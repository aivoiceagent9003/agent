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
-- WHY THIS IS DRIVEN BY THE LIVE SCHEMA, NOT A HARDCODED LIST
-- An earlier version listed all 32 tables by name, derived from the `create table`
-- statements across sql/. That list described what the REPO defines, which is not
-- the same as what any given DATABASE contains — a migration file that was never
-- run (knowledge_gaps.sql, say) makes the whole script fail on a missing table,
-- and worse, a hardcoded list silently misses any table added later.
--
-- So: loop over what is actually there. This is idempotent, safe to re-run after
-- every migration, and cannot fail because a table does or doesn't exist yet.
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
-- ROLLBACK: run this instead — it mirrors the loop with the condition inverted.
--   do $$ declare r record; begin
--     for r in select tablename from pg_tables
--              where schemaname='public' and rowsecurity = true loop
--       execute format('alter table public.%I disable row level security', r.tablename);
--     end loop;
--   end $$;

-- ─── 1. Enable RLS on every table that exists in public ──────────────────────
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and rowsecurity = false
    order by tablename
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    raise notice 'RLS enabled: %', r.tablename;
    n := n + 1;
  end loop;

  if n = 0 then
    raise notice 'RLS was already enabled on every table in public — nothing to do.';
  else
    raise notice 'RLS enabled on % table(s).', n;
  end if;
end $$;

-- No policies are created on purpose: anon/public gets nothing, the service-role
-- backend gets everything. If you later add direct browser→Supabase access, add
-- per-tenant SELECT/INSERT/UPDATE/DELETE policies here keyed on the caller's
-- tenant (e.g. using auth.uid() → profiles.tenant_id).

-- ─── 2. Audit: anything in public still unprotected? ─────────────────────────
-- Must return zero rows. Worth wiring into CI in Phase 6 so a later migration
-- cannot silently reopen the gap.
select tablename as "table without RLS"
from pg_tables
where schemaname = 'public'
  and rowsecurity = false
order by tablename;

-- ─── 3. Which migrations haven't been applied to this database? ──────────────
-- Lists tables the repo defines in sql/ that do NOT exist here. Anything that
-- shows up means the migration file naming it was never run. Re-run this file
-- after applying them so the new tables get RLS too.
with expected(tablename, defined_in) as (values
  ('tenants','schema.sql'),                  ('profiles','schema.sql'),
  ('knowledge_base','schema.sql'),           ('documents','schema.sql'),
  ('leads','schema.sql'),                    ('calls','schema.sql'),
  ('contacts','schema.sql'),                 ('lookup_rows','lookups.sql'),
  ('campaigns','campaigns.sql'),             ('campaign_contacts','campaigns.sql'),
  ('campaign_runs','campaigns.sql'),         ('campaign_metrics','campaigns.sql'),
  ('campaign_logs','campaigns.sql'),         ('campaign_templates','campaigns.sql'),
  ('contact_sources','campaigns.sql'),       ('suppression_list','campaigns.sql'),
  ('retry_queue','campaigns.sql'),           ('scheduled_jobs','campaigns.sql'),
  ('campaign_events','sources.sql'),
  ('conversations','messaging.sql'),         ('conversation_members','messaging.sql'),
  ('messages','messaging.sql'),              ('notifications','messaging.sql'),
  ('invitations','team.sql'),                ('lead_activity','team.sql'),
  ('lead_comments','lead_comments.sql'),     ('knowledge_gaps','knowledge_gaps.sql'),
  ('whatsapp_messages','whatsapp.sql'),      ('whatsapp_documents','whatsapp.sql'),
  ('call_traces','observability.sql'),       ('service_events','observability.sql'),
  ('metric_rollups','observability.sql')
)
select e.tablename as "missing table", e.defined_in as "run this file"
from expected e
where not exists (
  select 1 from pg_tables t
  where t.schemaname = 'public' and t.tablename = e.tablename
)
order by e.defined_in, e.tablename;
