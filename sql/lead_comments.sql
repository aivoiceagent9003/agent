-- sql/lead_comments.sql — threaded team discussion on a lead.
--
-- Distinct from leads.notes, which is a single shared scratchpad anyone can
-- overwrite. This is a conversation with authorship and replies, which is what
-- "why did we mark this lost?" actually needs six weeks later.
--
-- Threading is ONE level deep by convention: src/api/client.js normalises a
-- reply-to-a-reply onto its root, so nothing can hide below a tier the UI draws.
--
-- Safe to run more than once. Run AFTER sql/team.sql (needs leads + tenants).
-- Companion files: sql/schema.sql (base), sql/team.sql (lead workflow columns).

create table if not exists public.lead_comments (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  -- No FK to profiles on purpose: removing a person must not erase the record of
  -- what they said. The API falls back to "Someone" when the id no longer resolves.
  author_id  uuid,
  -- Deleting a comment takes its replies with it — an orphaned reply reads as a
  -- non-sequitur.
  parent_id  uuid references public.lead_comments(id) on delete cascade,
  body       text not null,
  edited_at  timestamptz,
  created_at timestamptz not null default now()
);

-- The thread view: every comment on one lead, oldest first.
create index if not exists lead_comments_lead_idx
  on public.lead_comments (lead_id, created_at);
create index if not exists lead_comments_tenant_idx
  on public.lead_comments (tenant_id, created_at desc);

-- Deny-all, matching the rest of the schema: no policies are created, so anon
-- gets nothing and the service-role backend (which bypasses RLS) gets everything.
alter table public.lead_comments enable row level security;
