// API client. BASE_URL points at the voice-agent Express backend.
// Set VITE_API_BASE in .env (defaults to http://localhost:3000 for local dev).
// All responses are JSON. Token is sent as Authorization: Bearer <token>.
export const BASE_URL =
  (typeof window !== "undefined" && (window as any).__API_BASE__) ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:3000";

// WebSocket origin for the realtime web-call test (http→ws, https→wss).
export const WS_BASE = BASE_URL.replace(/^http/, "ws");

// ─── Session lifecycle ───────────────────────────────────────────────────────
// Changing the token has to wipe the React Query cache, and it has to happen
// HERE rather than at each call site.
//
// The bug this fixes: signing out only removed the token, leaving every cached
// query in memory. Sign in as someone else without reloading and /app read the
// PREVIOUS user's ["me"] — still fresh for 60s — so an employee saw the owner's
// dashboard and only got their own once a refresh dropped the in-memory cache.
// It also meant the next person on a shared device could see the last person's
// cached leads and calls.
//
// Five places start a session and four end one. Any fix relying on each of them
// remembering to clear the cache is one new login page away from breaking again,
// so the token setters own it.
let resetCache: (() => void) | null = null;

/** Registered once by the root component, which owns the QueryClient. */
export function registerCacheReset(fn: () => void) {
  resetCache = fn;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("vocera_token");
}

export function setToken(t: string) {
  // Only wipe on an actual identity change — re-setting the same token (a token
  // refresh, say) shouldn't throw away good data.
  if (getToken() !== t) resetCache?.();
  localStorage.setItem("vocera_token", t);
}

export function clearToken() {
  localStorage.removeItem("vocera_token");
  localStorage.removeItem("vocera_refresh");
  localStorage.removeItem("vocera_expires");
  resetCache?.();
}

// ─── Refresh ─────────────────────────────────────────────────────────────────
// Access tokens last about an hour, after which every request 401s and the user
// is bounced to /login mid-task. The refresh token buys a new one.
//
// Supabase ROTATES refresh tokens: each refresh returns a new one. The previous
// token stays valid for a short reuse window (Supabase default: 10s) rather than
// dying instantly, so a burst of refreshes will not usually log anyone out.
//
// It is still wrong to let them run independently. Every dashboard page has
// several queries in flight, so an expired access token means N simultaneous
// refreshes: N round-trips racing each other to write localStorage, where the
// last writer can persist a token older than one already stored — and any that
// arrive after the reuse window has closed fail outright. `inFlight` makes every
// concurrent caller await the SAME refresh, so exactly one is ever issued.
export interface Session {
  token: string;
  refresh_token?: string | null;
  expires_at?: number | null;
}

export function setSession(s: Session) {
  setToken(s.token);
  if (s.refresh_token) localStorage.setItem("vocera_refresh", s.refresh_token);
  if (s.expires_at) localStorage.setItem("vocera_expires", String(s.expires_at));
}

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("vocera_refresh");
}

let inFlight: Promise<string | null> | null = null;

/** Returns a fresh access token, or null if the session is truly over. */
export function refreshSession(): Promise<string | null> {
  if (inFlight) return inFlight;
  const refresh_token = getRefreshToken();
  if (!refresh_token) return Promise.resolve(null);

  inFlight = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body?.token) return null;
      // Persist the ROTATED refresh token, not just the access token — missing
      // this makes the next refresh fail and the session die after two hours.
      setSession(body);
      return body.token as string;
    } catch {
      // Network failure, not an auth failure. Returning null signs the user out,
      // which is the safe direction: a stale token cannot be smuggled onward.
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function send(path: string, init: RequestInit, token: string | null) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await send(path, init, getToken());

  // One 401 is not proof the session is over — it is usually just an access token
  // that aged out. Try a single refresh and replay before evicting the user.
  // Exactly one retry: if the replay 401s too, the session really is finished and
  // looping would only delay saying so.
  if (res.status === 401) {
    const fresh = await refreshSession();
    if (fresh) res = await send(path, init, fresh);
  }

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}
