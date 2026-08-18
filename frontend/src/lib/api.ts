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
  resetCache?.();
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
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
