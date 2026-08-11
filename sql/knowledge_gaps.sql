-- sql/knowledge_gaps.sql — questions the agent was asked and could not answer.
--
-- The Analytics page can already tell a client their info hit rate is 81%. This
-- table is what makes that number actionable: it records the QUESTION behind each
-- of the other 19%, so the client portal can say "six callers asked about parking
-- and your agent didn't know" and offer to fix it in one click.
--
-- One row per miss, written by the live session when search_knowledge comes back
-- empty (src/services/gemini-live.js). Grouping happens at read time — the same
-- question phrased three ways is still three rows here, and normalising at write
-- time would throw away the wording a client needs to see.
--
-- Safe to run more than once. Run AFTER sql/schema.sql.

create table if not exists public.knowledge_gaps (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  -- Which call it came up on, for "play me the moment they asked". Nulled rather
  -- than cascaded away so the gap survives call cleanup.
  call_id    uuid,
  question   text not null,
  -- Set once the client adds knowledge covering it, so an answered gap stops
  -- nagging without losing the record that it was ever a gap.
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- The Home page reads: unresolved gaps for this tenant, newest first.
create index if not exists knowledge_gaps_open_idx
  on public.knowledge_gaps (tenant_id, created_at desc) where resolved_at is null;

-- Deny-all, like the rest of the schema: the service-role backend bypasses RLS.
alter table public.knowledge_gaps enable row level security;
