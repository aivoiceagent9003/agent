-- sql/rls.sql — Row-Level Security hardening (defense-in-depth).
--
-- WHAT THIS DOES
-- Enables RLS on every application table with NO policies. With RLS on and no
-- policy, the anon/public role is DENIED all access through the Supabase data
-- API. The backend connects with the SERVICE ROLE key (see src/api/db.js), which
-- BYPASSES RLS, so the API keeps working exactly as before. Result: the database
-- refuses any DIRECT access that doesn't come through our trusted backend.
--
-- Tenant isolation is still enforced in application code (requireClient /
-- requireAdmin + explicit tenant_id filters). This is an extra safety net, not a
-- replacement for those checks.
--
-- WHY THE LIST GREW
-- The original version of this file covered 8 tables. The schema has since grown
-- to 32, and every table added after it — campaigns, contacts, messages,
-- notifications, WhatsApp, invitations, observability — was left with RLS off.
-- Supabase grants the anon role access to new public tables by default, so each
-- of those was one leaked anon key away from being world-readable. The frontend
-- never holds a Supabase key today, which is the only reason this was not live
-- exposure, but RLS is precisely the layer meant to survive that assumption
-- changing.
--
-- ⚠️ PREREQUISITE — APPLY ORDER MATTERS
-- Deploy the backend with SUPABASE_SERVICE_ROLE_KEY set FIRST (so src/api/db.js
-- uses the service-role client). Only THEN run this file. If you enable RLS while
-- the backend is still on the anon key, the API — and live calls (knowledge
-- retrieval, lookups, lead saves) — lose database access.
--
-- Verify the prerequisite is in place:
--   - SUPABASE_SERVICE_ROLE_KEY present in the backend env
--   - a test call still returns knowledge ([RAG] Found N chunks in the logs)
--
-- ROLLBACK (if anything breaks): re-run with `disable` instead of `enable`.

-- ─── Core ────────────────────────────────────────────────────────────────────
alter table public.tenants           enable row level security;
alter table public.profiles          enable row level security;
alter table public.knowledge_base    enable row level security;
alter table public.documents         enable row level security;
alter table public.leads             enable row level security;
alter table public.lookup_rows       enable row level security;
alter table public.calls             enable row level security;
alter table public.contacts          enable row level security;

-- ─── Campaigns ───────────────────────────────────────────────────────────────
alter table public.campaigns         enable row level security;
alter table public.campaign_contacts enable row level security;
alter table public.campaign_runs     enable row level security;
alter table public.campaign_events   enable row level security;
alter table public.campaign_metrics  enable row level security;
alter table public.campaign_logs     enable row level security;
alter table public.campaign_templates enable row level security;
alter table public.contact_sources   enable row level security;
alter table public.suppression_list  enable row level security;
alter table public.retry_queue       enable row level security;
alter table public.scheduled_jobs    enable row level security;

-- ─── Team, messaging, notifications ──────────────────────────────────────────
alter table public.invitations         enable row level security;
alter table public.conversations       enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages            enable row level security;
alter table public.notifications       enable row level security;

-- ─── WhatsApp ────────────────────────────────────────────────────────────────
alter table public.whatsapp_messages  enable row level security;
alter table public.whatsapp_documents enable row level security;

-- ─── Leads detail + knowledge quality ────────────────────────────────────────
alter table public.lead_activity   enable row level security;
alter table public.lead_comments   enable row level security;
alter table public.knowledge_gaps  enable row level security;

-- ─── Observability ───────────────────────────────────────────────────────────
alter table public.call_traces    enable row level security;
alter table public.service_events enable row level security;
alter table public.metric_rollups enable row level security;

-- No policies are created on purpose: anon/public gets nothing, the service-role
-- backend gets everything. If you later add direct browser→Supabase access, add
-- per-tenant SELECT/INSERT/UPDATE/DELETE policies here keyed on the caller's
-- tenant (e.g. using auth.uid() → profiles.tenant_id).

-- ─── Audit: which tables in `public` still have RLS off? ──────────────────────
-- Run this after applying. It must return zero rows. Worth wiring into CI once
-- Phase 6 exists, so the next migration cannot silently reopen the gap.
--
--   select tablename
--   from pg_tables
--   where schemaname = 'public'
--     and rowsecurity = false
--   order by tablename;
