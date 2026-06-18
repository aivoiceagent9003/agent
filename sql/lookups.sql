-- lookup_rows — uploaded data sheets for the 'table' lookup backend.
-- Run this once in the Supabase SQL editor.
--
-- Each row of a client's uploaded sheet (orders, dues, bookings…) is stored as
-- jsonb plus a flattened `search_text` so the live call can find a record fast
-- with an ILIKE on the caller-supplied value (order id, phone, etc.).

create extension if not exists pg_trgm;

create table if not exists lookup_rows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  dataset     text not null,
  row         jsonb not null,
  search_text text not null default '',
  created_at  timestamptz not null default now()
);

-- Narrow by tenant + dataset first…
create index if not exists lookup_rows_tenant_dataset_idx
  on lookup_rows (tenant_id, dataset);

-- …then trigram index makes the ILIKE on search_text fast.
create index if not exists lookup_rows_search_trgm_idx
  on lookup_rows using gin (search_text gin_trgm_ops);

-- The backend talks to Supabase with the anon key and enforces tenant scoping in
-- app code (same as knowledge_base), so RLS is left off for this table. Without
-- this, inserts fail with "new row violates row-level security policy".
alter table lookup_rows disable row level security;
