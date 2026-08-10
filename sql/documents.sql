-- sql/documents.sql
-- Document-level knowledge management.
--
-- Before this, an upload was chunked + embedded and the original file was thrown
-- away — so clients couldn't see, re-download, or delete what they uploaded, and
-- there was no way to remove just one file's chunks.
--
-- Now every upload (or paste) is a `documents` row, and each knowledge_base chunk
-- links back to it via document_id with ON DELETE CASCADE. Deleting a document
-- automatically deletes its chunks. Raw file bytes live in Supabase STORAGE
-- (bucket 'knowledge-files'), never in Postgres — the row only keeps the path.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ── documents ────────────────────────────────────────────────────────────────
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  filename     text not null,
  storage_path text,                       -- path in the 'knowledge-files' bucket; null for pasted text
  mime_type    text,
  size_bytes   bigint,
  source       text default 'upload',      -- 'upload' | 'paste'
  char_count   integer default 0,
  chunk_count  integer default 0,
  status       text default 'ready',       -- 'processing' | 'ready' | 'error'
  created_at   timestamptz not null default now()
);

create index if not exists documents_tenant_idx
  on public.documents (tenant_id, created_at desc);

-- ── link chunks to their source document ─────────────────────────────────────
-- ON DELETE CASCADE: removing a document removes all of its chunks in one step.
-- Existing pre-migration chunks keep document_id = null (legacy / ungrouped).
alter table public.knowledge_base
  add column if not exists document_id uuid
  references public.documents(id) on delete cascade;

create index if not exists kb_document_idx
  on public.knowledge_base (document_id);

-- ── Storage bucket for the raw files (private) ───────────────────────────────
-- Created here so it's reproducible; equivalent to Dashboard → Storage → New
-- bucket → 'knowledge-files' (Public = off). Access is server-side via the
-- service-role key, so no public policies are needed.
insert into storage.buckets (id, name, public)
values ('knowledge-files', 'knowledge-files', false)
on conflict (id) do nothing;
