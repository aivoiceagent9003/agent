-- sql/analytics.sql — per-call quality columns behind the client Analytics page.
--
-- These three numbers already exist inside call_traces.summary, but that column
-- carries the entire span waterfall for a call. Averaging two integers across a
-- tenant's last 30 days should not mean downloading thousands of waterfalls, so
-- the telephony layer denormalises them onto the call row at hangup
-- (src/services/telemetry.js → callQuality).
--
-- Nulls/zeros are expected on every call that happened before this ran; the
-- dashboard shows "—" rather than inventing a number.
--
-- Safe to run more than once. Run AFTER sql/schema.sql.

alter table public.calls
  -- Mean time from "caller stopped speaking" to "agent started replying", across
  -- every turn of the call. Null when the call produced no agent turns at all.
  add column if not exists avg_reply_ms   integer,
  -- How often the agent searched the client's own knowledge base, and how often
  -- that search actually found something. hits/asks is the "Info hit rate" tile.
  add column if not exists knowledge_asks integer default 0,
  add column if not exists knowledge_hits integer default 0;

-- The Analytics page always filters by tenant + a rolling date window.
create index if not exists calls_tenant_created_idx
  on public.calls (tenant_id, created_at desc);
