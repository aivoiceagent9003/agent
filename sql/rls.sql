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

alter table public.tenants        enable row level security;
alter table public.profiles       enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.documents      enable row level security;
alter table public.leads          enable row level security;
alter table public.lookup_rows    enable row level security;
alter table public.calls          enable row level security;
alter table public.contacts       enable row level security;

-- No policies are created on purpose: anon/public gets nothing, the service-role
-- backend gets everything. If you later add direct browser→Supabase access, add
-- per-tenant SELECT/INSERT/UPDATE/DELETE policies here keyed on the caller's
-- tenant (e.g. using auth.uid() → profiles.tenant_id).
