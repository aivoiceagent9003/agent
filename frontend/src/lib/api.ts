// API client. BASE_URL points at the voice-agent Express backend.
// Set VITE_API_BASE in .env (defaults to http://localhost:3000 for local dev).
// All responses are JSON. Token is sent as Authorization: Bearer <token>.
export const BASE_URL =
  (typeof window !== "undefined" && (window as any).__API_BASE__) ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:3000";

// WebSocket origin for the realtime web-call test (http→ws, https→wss).
export const WS_BASE = BASE_URL.replace(/^http/, "ws");

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("vocera_token");
}
export function setToken(t: string) {
  localStorage.setItem("vocera_token", t);
}
export function clearToken() {
  localStorage.removeItem("vocera_token");
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
