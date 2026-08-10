-- sql/schema.sql — Canonical database schema (source of truth).
--
-- Verified against the LIVE Supabase schema: columns, defaults, nullability AND
-- indexes all match the introspection dumps. This file is the authority on
-- structure so the repo — not a hand-edited Supabase project — is the source of
-- truth (the gap that caused the missing tenants.created_at bug).
--
-- Everything uses IF NOT EXISTS so it's safe to run against the existing DB and
-- can recreate the schema from scratch.
--
-- ⚠️ The live DB currently has NO foreign keys and tenant_id is nullable on the
-- older tables. That's an integrity gap, not the desired end state — the
-- recommended constraints live in sql/constraints.sql (apply separately after
-- cleaning any orphan rows). This file reflects what EXISTS today.
--
-- Companion files: sql/documents.sql, sql/hnsw_index.sql, sql/lookups.sql,
-- sql/rls.sql, sql/constraints.sql.

create extension if not exists "pgcrypto";  -- gen_random_uuid()
create extension if not exists "vector";    -- pgvector (knowledge_base.embedding)
create extension if not exists "pg_trgm";   -- trigram index on lookup_rows.search_text

-- ─── tenants ─────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  industry     text,
  config       jsonb default '{}'::jsonb,
  phone_number text,
  created_at   timestamptz not null default now()
);

-- ─── profiles ────────────────────────────────────────────────────────────────
-- One row per auth user. id = auth.users.id. role routes admin vs client.
create table if not exists public.profiles (
  id         uuid primary key,  -- = auth.users.id (no FK enforced in live DB)
  role       text not null default 'client',
  tenant_id  uuid,
  email      text,
  created_at timestamptz default now()
);

-- ─── documents ───────────────────────────────────────────────────────────────
-- One uploaded file or pasted block. Raw bytes live in Storage ('knowledge-files').
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  filename     text not null,
  storage_path text,
  mime_type    text,
  size_bytes   bigint,
  source       text default 'upload',
  char_count   integer default 0,
  chunk_count  integer default 0,
  status       text default 'ready',
  created_at   timestamptz not null default now()
);
create index if not exists documents_tenant_idx on public.documents (tenant_id, created_at desc);

-- ─── knowledge_base ──────────────────────────────────────────────────────────
-- RAG chunks. embedding is pgvector (text-embedding-3-small → 1536 dims).
-- HNSW index for fast per-tenant cosine search (see sql/hnsw_index.sql).
-- NOTE: document_id has NO FK/cascade in the live DB — document deletion removes
-- chunks explicitly in code (src/services/documents.js). sql/constraints.sql adds
-- the proper ON DELETE CASCADE.
create table if not exists public.knowledge_base (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  content     text not null,
  embedding   vector(1536),
  source      text,
  created_at  timestamptz default now(),
  document_id uuid
);
create index if not exists kb_tenant_idx    on public.knowledge_base (tenant_id);
create index if not exists kb_document_idx  on public.knowledge_base (document_id);
create index if not exists kb_embedding_idx  on public.knowledge_base
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ─── calls ───────────────────────────────────────────────────────────────────
create table if not exists public.calls (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid,
  caller_number    text,
  duration         integer,
  transcript       text,
  status           text default 'active',
  created_at       timestamptz default now(),
  duration_seconds integer default 0
);

-- ─── leads ───────────────────────────────────────────────────────────────────
create table if not exists public.leads (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid,
  call_id          uuid,
  caller_number    text,
  name             text,
  intent           text,
  summary          text,
  sentiment        text,
  language         text,
  key_details      jsonb default '[]'::jsonb,
  follow_up_needed boolean default false,
  handed_off       boolean default false,
  contact_info     text,
  raw_data         jsonb,
  created_at       timestamptz default now()
);

-- ─── lookup_rows ─────────────────────────────────────────────────────────────
-- Uploaded data sheets for the 'table' backend of live-data lookups.
create table if not exists public.lookup_rows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  dataset     text not null,
  row         jsonb not null,
  search_text text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists lookup_rows_tenant_dataset_idx on public.lookup_rows (tenant_id, dataset);
create index if not exists lookup_rows_search_trgm_idx on public.lookup_rows
  using gin (search_text gin_trgm_ops);

-- ─── contacts ────────────────────────────────────────────────────────────────
-- Marketing-site "contact us" submissions (not tenant-scoped).
create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  email      text,
  company    text,
  message    text,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- NOT captured here (live-only — reconstruct separately):
--   • RPC functions match_knowledge(query_embedding, match_tenant_id, match_count)
--     and tenant_stats(t_id). Dump with:
--       select pg_get_functiondef(oid) from pg_proc
--       where proname in ('match_knowledge','tenant_stats');
--   • Storage bucket 'knowledge-files' (see sql/documents.sql).
--   • RLS state (see sql/rls.sql).
