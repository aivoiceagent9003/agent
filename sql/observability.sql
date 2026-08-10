-- sql/observability.sql — Operations Center historical storage.
--
-- The live Operations Center reads in-memory ring buffers (src/services/telemetry.js)
-- for real-time numbers with zero DB I/O on the call path. These tables hold the
-- HISTORY for trend analysis: a background flusher rolls aggregates up here every
-- ~30s, per-call trace summaries are persisted on hang-up, and service events
-- (errors / outages) are appended as they occur.
--
-- Safe to run repeatedly (IF NOT EXISTS). Companion: sql/schema.sql.
-- All writes use the service-role client and are best-effort — a failure here
-- never affects a live call.

-- ─── metric_rollups ────────────────────────────────────────────────────────────
-- One row per (op) per flush tick. For metric='latency', p50..p99 are latency ms
-- and op is the operation key ('first_audio','rag_retrieval','tool_call',…). For
-- metric='infra', op='process' and the columns carry process gauges (see flusher).
create table if not exists public.metric_rollups (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  metric    text not null,                 -- 'latency' | 'infra'
  op        text not null,                 -- operation key
  tenant_id uuid,                          -- null = platform-wide (Phase 1)
  p50       double precision default 0,
  p90       double precision default 0,
  p95       double precision default 0,
  p99       double precision default 0,
  avg       double precision default 0,
  count     integer default 0
);
create index if not exists metric_rollups_lookup_idx
  on public.metric_rollups (metric, op, ts desc);
create index if not exists metric_rollups_ts_idx
  on public.metric_rollups (ts desc);

-- ─── call_traces ───────────────────────────────────────────────────────────────
-- Compact per-call trace summary (the full span waterfall lives in `summary` jsonb)
-- persisted on call end, so a call can be debugged after it leaves the in-memory
-- recent-traces ring.
create table if not exists public.call_traces (
  call_sid   text primary key,
  tenant_id  uuid,
  started_at timestamptz,
  ended_at   timestamptz,
  status     text,                         -- completed | failed
  summary    jsonb,                        -- { ...trace summary, spans:[...] }
  created_at timestamptz not null default now()
);
create index if not exists call_traces_tenant_idx
  on public.call_traces (tenant_id, started_at desc);
create index if not exists call_traces_started_idx
  on public.call_traces (started_at desc);

-- ─── service_events ──────────────────────────────────────────────────────────
-- Errors, reconnect storms, component up/down — seeds the Downtime & Error
-- Explorer dashboards in later phases.
create table if not exists public.service_events (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  component text,                          -- 'gemini' | 'supabase' | 'rag' | 'telephony' | 'tool' | 'node'
  severity  text default 'info',           -- info | warning | error | critical
  kind      text,                          -- short machine label, e.g. 'session_close','reconnect','tool_timeout'
  detail    jsonb default '{}'::jsonb
);
create index if not exists service_events_ts_idx
  on public.service_events (ts desc);
create index if not exists service_events_component_idx
  on public.service_events (component, severity, ts desc);
