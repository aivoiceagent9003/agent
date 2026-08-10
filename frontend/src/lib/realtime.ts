// realtime.ts — one WebSocket for messages + notifications.
//
// A module-level singleton rather than a connection per hook: the Messages screen,
// the sidebar unread badge, and the notification bell all need the same stream, and
// three sockets per tab would be wasteful and race each other.
//
// Reconnects with exponential backoff, and refreshes on tab focus because a laptop
// waking from sleep usually finds its socket silently dead.

import { WS_BASE, getToken } from "./api";

export type RealtimeEvent =
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "message"; message: any }
  | { type: "notification"; notification: any };

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closedByUs = false;

function connect() {
  if (typeof window === "undefined") return;
  const token = getToken();
  if (!token) return; // signed out — nothing to subscribe to
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  closedByUs = false;
  try {
    ws = new WebSocket(`${WS_BASE}/messages-stream?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    retries = 0;
  };

  ws.onmessage = (e) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    // A listener that throws must not stop the others from being called.
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  };

  ws.onclose = () => {
    ws = null;
    if (!closedByUs && listeners.size) scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // 1s, 2s, 4s … capped at 30s, so a server restart doesn't get hammered.
  const delay = Math.min(30000, 1000 * Math.pow(2, retries++));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Subscribe to the stream. Returns an unsubscribe function. */
export function subscribeRealtime(fn: Listener): () => void {
  listeners.add(fn);
  connect();

  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      closedByUs = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
  };
}

/** Drop the socket — call on sign-out so the next user doesn't inherit it. */
export function closeRealtime() {
  closedByUs = true;
  listeners.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  retries = 0;
}

// A sleeping laptop's socket often dies without firing onclose. Re-check on focus.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (listeners.size && (!ws || ws.readyState === WebSocket.CLOSED)) connect();
  });
}
