-- sql/constraints.sql — Foreign-key + integrity hardening.
--
-- Adds the foreign keys the app's behaviour assumes. A few already exist (created
-- by sql/documents.sql), so every constraint is DROPPED IF EXISTS before being
-- re-added — that makes this script safe to run more than once and stops it from
-- erroring on constraints that are already there.
--
-- ⚠️ READ BEFORE RUNNING. Adding a FK fails if existing rows violate it, so each
-- block first CLEANS UP offending rows: invalid tenant refs on calls/leads/
-- profiles are set to NULL (row preserved); un-tenanted knowledge_base/documents/
-- lookup_rows are DELETED (they're unusable — can never be retrieved per-tenant).
-- Everything runs in one transaction: if a count looks wrong, it ALL rolls back
-- and nothing changes. Preview the impact first with the query in chat.

begin;

-- ── 1. knowledge_base.document_id → documents (cascade: delete doc → del chunks)
update public.knowledge_base
   set document_id = null
 where document_id is not null
   and document_id not in (select id from public.documents);

alter table public.knowledge_base drop constraint if exists knowledge_base_document_id_fkey;
alter table public.knowledge_base
  add constraint knowledge_base_document_id_fkey
  foreign key (document_id) references public.documents(id) on delete cascade;

-- ── 2. documents.tenant_id → tenants ─────────────────────────────────────────
delete from public.documents
 where tenant_id is null
    or tenant_id not in (select id from public.tenants);

alter table public.documents drop constraint if exists documents_tenant_id_fkey;
alter table public.documents
  add constraint documents_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- ── 3. knowledge_base.tenant_id → tenants ────────────────────────────────────
delete from public.knowledge_base
 where tenant_id is null
    or tenant_id not in (select id from public.tenants);

alter table public.knowledge_base drop constraint if exists knowledge_base_tenant_id_fkey;
alter table public.knowledge_base
  add constraint knowledge_base_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- ── 4. lookup_rows.tenant_id → tenants ───────────────────────────────────────
delete from public.lookup_rows
 where tenant_id is null
    or tenant_id not in (select id from public.tenants);

alter table public.lookup_rows drop constraint if exists lookup_rows_tenant_id_fkey;
alter table public.lookup_rows
  add constraint lookup_rows_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- ── 5. calls.tenant_id → tenants (preserve rows; null invalid refs) ──────────
update public.calls
   set tenant_id = null
 where tenant_id is not null
   and tenant_id not in (select id from public.tenants);

alter table public.calls drop constraint if exists calls_tenant_id_fkey;
alter table public.calls
  add constraint calls_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- ── 6. leads.tenant_id → tenants, leads.call_id → calls ──────────────────────
update public.leads
   set tenant_id = null
 where tenant_id is not null
   and tenant_id not in (select id from public.tenants);
update public.leads
   set call_id = null
 where call_id is not null
   and call_id not in (select id from public.calls);

alter table public.leads drop constraint if exists leads_tenant_id_fkey;
alter table public.leads
  add constraint leads_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;
alter table public.leads drop constraint if exists leads_call_id_fkey;
alter table public.leads
  add constraint leads_call_id_fkey
  foreign key (call_id) references public.calls(id) on delete set null;

-- ── 7. profiles.tenant_id → tenants, profiles.id → auth.users ────────────────
update public.profiles
   set tenant_id = null
 where tenant_id is not null
   and tenant_id not in (select id from public.tenants);

alter table public.profiles drop constraint if exists profiles_tenant_id_fkey;
alter table public.profiles
  add constraint profiles_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete set null;
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- ── Helpful per-tenant indexes the live DB is missing (cheap, big win at scale)
create index if not exists calls_tenant_idx on public.calls (tenant_id, created_at desc);
create index if not exists leads_tenant_idx on public.leads (tenant_id, created_at desc);

commit;

-- ── OPTIONAL: tighten tenant_id to NOT NULL (run only AFTER the cleanup above
-- has removed null-tenant rows and you've confirmed counts look right). Kept
-- separate/commented because it's irreversible without re-allowing nulls.
-- alter table public.knowledge_base alter column tenant_id set not null;
-- alter table public.calls          alter column tenant_id set not null;
-- alter table public.leads          alter column tenant_id set not null;
