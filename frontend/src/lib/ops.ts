// lib/ops.ts — Operations Center data layer (admin-only).
//
// React Query hooks over /api/admin/ops/*, same pattern as lib/data.ts. Live
// dashboards layer the /ops-stream WebSocket (lib/ops-stream.ts) on top of these
// for real-time updates; the REST hooks provide the initial render + polling
// fallback when the socket is down.

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "./api";

const isBrowser = typeof window !== "undefined";

// ─── Types ──────────────────────────────────────────────────────────────────
export interface SeriesPoint {
  ts: number;
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  eventLoopDelayMs: number;
  eventLoopDelayP99Ms: number;
  activeCalls: number;
  websockets: number;
  geminiSessions: number;
  uptimeSec: number;
}

export interface OpsSnapshot {
  status: "healthy" | "degraded" | "critical";
  healthScore: number;
  activeCalls: number;
  callsToday: number;
  callsAllTime?: number;
  callsThisHour: number;
  peakConcurrentCalls: number;
  avgConcurrentCalls: number;
  avgCallDurationMs: number;
  avgTurnDurationMs: number;
  avgFirstAudioMs: number;
  avgModelLatencyMs: number;
  avgRagLatencyMs: number;
  avgLanguageDetectionMs: number;
  avgToolLatencyMs: number;
  cpuPct: number;
  memoryMb: number;
  heapUsedMb: number;
  eventLoopDelayMs: number;
  eventLoopDelayP99Ms: number;
  websockets: number;
  geminiSessions: number;
  counters: Record<string, number>;
  uptimeSec: number;
  series?: SeriesPoint[];
}

export interface LiveCall {
  callSid: string;
  correlationId: string;
  tenantId: string | null;
  tenantName: string | null;
  callerNumber: string | null;
  businessNumber: string | null;
  engine: string | null;
  startedAt: number;
  endedAt: number | null;
  status: string;
  durationMs: number;
  language: string | null;
  intent: string | null;
  currentTool: string | null;
  model: string | null;
  voice: string | null;
  conversationState: string;
  lastLatencyMs: number | null;
  reconnects: number;
  interruptions: number;
  packetsIn: number;
  packetsOut: number;
  lastTranscript: string;
  lastAgentReply: string;
}

export interface TraceSpan {
  name: string;
  startRel: number;
  durationMs: number | null;
  status: string;
  retryCount: number;
  error: string | null;
  payloadBytes: number;
  attrs: Record<string, any>;
}

export interface TraceDetail extends LiveCall {
  spans: TraceSpan[];
}

export interface LatencyStat {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  count: number;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────
export function useOpsOverview(refetchMs = 5000) {
  return useQuery({
    queryKey: ["ops", "overview"],
    enabled: isBrowser,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<OpsSnapshot> => apiFetch("/api/admin/ops/overview"),
  });
}

export function useLiveCalls(refetchMs = 3000) {
  return useQuery({
    queryKey: ["ops", "calls", "live"],
    enabled: isBrowser,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<LiveCall[]> => {
      const r = await apiFetch("/api/admin/ops/calls/live");
      return r.calls || [];
    },
  });
}

export function useRecentCalls(limit = 100) {
  return useQuery({
    queryKey: ["ops", "calls", "recent", limit],
    enabled: isBrowser,
    queryFn: async (): Promise<TraceDetail[]> => {
      const r = await apiFetch(`/api/admin/ops/calls/recent?limit=${limit}`);
      return r.calls || [];
    },
  });
}

export function useCallTrace(callSid: string) {
  return useQuery({
    queryKey: ["ops", "trace", callSid],
    enabled: isBrowser && !!callSid,
    refetchInterval: 2000,
    retry: false,
    queryFn: async (): Promise<TraceDetail> => apiFetch(`/api/admin/ops/calls/${callSid}/trace`),
  });
}

export function useLatency(refetchMs = 5000) {
  return useQuery({
    queryKey: ["ops", "latency"],
    enabled: isBrowser,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<Record<string, LatencyStat>> => apiFetch("/api/admin/ops/latency"),
  });
}

export function useMetricHistory(op: string, sinceMs = 6 * 3600_000) {
  return useQuery({
    queryKey: ["ops", "history", op, sinceMs],
    enabled: isBrowser && !!op,
    queryFn: async (): Promise<any[]> => {
      const r = await apiFetch(
        `/api/admin/ops/metrics/history?metric=latency&op=${encodeURIComponent(op)}&sinceMs=${sinceMs}`,
      );
      return r.rows || [];
    },
  });
}

export function useTerminateCall() {
  return useMutation({
    mutationFn: (callSid: string) =>
      apiFetch(`/api/admin/ops/calls/${callSid}/terminate`, { method: "POST" }),
  });
}

// ─── Phase 2: service dashboards ──────────────────────────────────────────────
function opsResource<T>(key: string, path: string, refetchMs = 5000) {
  return () =>
    useQuery({
      queryKey: ["ops", key],
      enabled: isBrowser,
      refetchInterval: refetchMs,
      queryFn: async (): Promise<T> => apiFetch(path),
    });
}

export const useLanguageStats = opsResource<any>("language", "/api/admin/ops/language");
export const useGeminiStats = opsResource<any>("gemini", "/api/admin/ops/gemini");
export const useTelephonyStats = opsResource<any>("telephony", "/api/admin/ops/telephony");
export const useRagStats = opsResource<any>("rag", "/api/admin/ops/rag");
export const useToolStats = opsResource<any>("tools", "/api/admin/ops/tools");
export const useInfraStats = opsResource<any>("infra", "/api/admin/ops/infra");
export const useErrorStats = opsResource<any>("errors", "/api/admin/ops/errors", 8000);
export const useDowntime = opsResource<any>("downtime", "/api/admin/ops/downtime", 8000);

// ─── Phase 3: Business, AI Quality, Alerts ───────────────────────────────────
export const useBusinessStats = opsResource<any>("business", "/api/admin/ops/business", 15000);
export const useQualityStats = opsResource<any>("quality", "/api/admin/ops/quality", 6000);
export const useAlerts = opsResource<any>("alerts", "/api/admin/ops/alerts", 5000);

export const fmtUsd = (n?: number | null) =>
  n == null
    ? "—"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Friendly ms formatter shared across the ops dashboards.
export const fmtMs = (ms?: number | null) =>
  ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

export const fmtDuration = (ms?: number | null) => {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};
