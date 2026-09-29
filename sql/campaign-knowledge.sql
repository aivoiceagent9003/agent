-- sql/campaign-knowledge.sql — files an AI campaign talks from (additive, safe to re-run).
--
-- A business running an outbound campaign about something NEW — a project launched
-- last week — has nothing about it in its knowledge base, so the agent could not
-- answer a single question about the thing it called to talk about. These tables
-- hold files uploaded for ONE campaign.
--
-- They are deliberately separate from documents/knowledge_base, not a campaign_id
-- column on them. Every reader of knowledge_base (the in-memory index, the
-- match_knowledge RPC, the documents list, the chunk counts) would otherwise have
-- to remember to exclude campaign rows, and the one that forgot would have the
-- INBOUND agent pitching an unannounced project. Here, nothing that reads the
-- business's knowledge base can see a campaign file at all.
--
-- When the campaign ends the owner is asked whether to add the files to the main
-- knowledge base; kb_decision records the answer. Adding copies the chunks WITH
-- their embeddings, so nothing is re-processed.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";     -- pgvector (embedding)

create table if not exists public.campaign_documents (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
  filename       text not null,
  storage_path   text,                          -- in the 'knowledge-files' bucket
  mime_type      text,
  size_bytes     bigint,
  char_count     integer default 0,
  chunk_count    integer default 0,
  keyterms       jsonb default '[]'::jsonb,     -- names in the file, as speech-recognition hints
  status         text default 'processing',     -- processing | ready | error
  kb_decision    text,                          -- null = not asked yet | 'added' | 'kept'
  kb_document_id uuid,                          -- the documents row it became, once added
  created_at     timestamptz not null default now()
);
create index if not exists campaign_documents_campaign_idx
  on public.campaign_documents (campaign_id, created_at desc);

create table if not exists public.campaign_knowledge (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  document_id uuid not null references public.campaign_documents(id) on delete cascade,
  content     text not null,
  embedding   vector(1536),                     -- text-embedding-3-small, same as knowledge_base
  created_at  timestamptz not null default now()
);
create index if not exists campaign_knowledge_campaign_idx on public.campaign_knowledge (campaign_id);
create index if not exists campaign_knowledge_document_idx on public.campaign_knowledge (document_id);

-- RLS is NOT enabled here on purpose. sql/rls.sql enables it on every table in
-- public in one go, and must only run once SUPABASE_SERVICE_ROLE_KEY is set on the
-- backend — enabling it here first would lock the backend out of these two tables.
