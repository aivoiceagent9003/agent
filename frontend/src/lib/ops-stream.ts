// lib/ops-stream.ts — real-time Operations Center feed.
//
// Opens the admin /ops-stream WebSocket and merges deltas straight into the React
// Query caches the ops hooks already read from, so dashboards update live without
// each component managing a socket. If the socket drops, the REST `refetchInterval`
// in lib/ops.ts keeps the UI fresh (graceful degradation). One socket per mounted
// consumer; React Query dedupes the data.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WS_BASE, getToken } from "./api";
import type { LiveCall, OpsSnapshot } from "./ops";

type OpsMessage =
  | { type: "snapshot"; snapshot: OpsSnapshot; calls: LiveCall[] }
  | { type: "event"; event: string; payload: any }
  | { type: "error"; error: string };

export function useOpsStream() {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let closedByUs = false;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const ws = new WebSocket(`${WS_BASE}/ops-stream?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) retryRef.current = setTimeout(connect, 2000); // auto-reconnect
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };

      ws.onmessage = (e) => {
        let msg: OpsMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === "snapshot") {
          qc.setQueryData(["ops", "overview"], (prev: OpsSnapshot | undefined) => ({
            ...(prev || {}),
            ...msg.snapshot,
            // keep the larger of the two series so charts don't jump backwards
            series: msg.snapshot.series || prev?.series,
          }));
          qc.setQueryData(["ops", "calls", "live"], msg.calls);
          return;
        }

        if (msg.type === "event") applyEvent(qc, msg.event, msg.payload);
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, [qc]);

  return { connected };
}

// Merge a single telemetry delta into the live-calls cache for instant feedback
// (the 5s snapshot heartbeat reconciles anything missed).
function applyEvent(qc: ReturnType<typeof useQueryClient>, event: string, payload: any) {
  if (event === "trace:start" && payload?.call) {
    qc.setQueryData(["ops", "calls", "live"], (prev: LiveCall[] = []) =>
      prev.some((c) => c.callSid === payload.call.callSid) ? prev : [payload.call, ...prev],
    );
    return;
  }
  if (event === "trace:end" && payload?.call) {
    qc.setQueryData(["ops", "calls", "live"], (prev: LiveCall[] = []) =>
      prev.filter((c) => c.callSid !== payload.call.callSid),
    );
    return;
  }
  if (event === "trace:update" && payload?.callSid) {
    qc.setQueryData(["ops", "calls", "live"], (prev: LiveCall[] = []) =>
      prev.map((c) =>
        c.callSid === payload.callSid ? { ...c, [payload.field]: payload.value } : c,
      ),
    );
    return;
  }
}
