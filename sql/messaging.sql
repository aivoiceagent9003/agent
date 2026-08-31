-- sql/messaging.sql — Internal team messaging + notifications for the employee view.
--
-- WHAT THIS ADDS
--   1. conversations        — a thread: the whole team, a 1:1 direct, or Vocera support
--   2. conversation_members — who is in a thread + how far they have read
--   3. messages             — the messages themselves
--   4. notifications        — the bell feed (lead assigned, new message, …)
--   5. leads.status migration → new | contacted | converted | lost
--
-- Run AFTER sql/team.sql (it depends on profiles.tenant_role existing).
-- Safe to run more than once.

-- ─── 1. conversations ────────────────────────────────────────────────────────
-- kind:
--   team    — one per tenant, everyone in the business is a member
--   direct  — 1:1 between two members of the same tenant
--   support — ONE PER PERSON talking to Vocera staff (answered in the admin panel)
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  kind            text not null default 'direct',
  title           text,
  created_by      uuid,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.conversations
    add constraint conversations_kind_chk check (kind in ('team','direct','support'));
exception when duplicate_object then null; end $$;

-- Ordering the sidebar is "most recent first", so index on it.
create index if not exists conversations_tenant_idx
  on public.conversations (tenant_id, last_message_at desc);

-- Exactly one team thread per business, and one support thread per PERSON
-- (created_by is whose it is). Direct threads are unconstrained here — the app
-- de-dupes them by member pair, see conversations.js.
create unique index if not exists conversations_one_team_idx
  on public.conversations (tenant_id) where kind = 'team';

-- Support used to be one thread per business with everyone in it, which let an
-- employer read their employee's support messages. sql/support-private.sql
-- migrates existing databases; this drop keeps a re-run of this file idempotent.
drop index if exists public.conversations_one_support_idx;
create unique index if not exists conversations_one_support_per_person_idx
  on public.conversations (tenant_id, created_by) where kind = 'support';

-- ─── 2. conversation_members ─────────────────────────────────────────────────
-- last_read_at is what drives unread badges: count messages newer than it.
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id      uuid not null,
  last_read_at    timestamptz not null default 'epoch',
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, profile_id)
);

create index if not exists conversation_members_profile_idx
  on public.conversation_members (profile_id);

-- ─── 3. messages ─────────────────────────────────────────────────────────────
-- tenant_id is denormalised so every read can be tenant-scoped without a join —
-- the same rule the rest of the API follows.
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  sender_id       uuid,
  -- Null sender + is_system marks "Vocera Support" replies and automated notices.
  is_system       boolean not null default false,
  body            text not null,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at desc);
create index if not exists messages_tenant_idx
  on public.messages (tenant_id, created_at desc);

-- Keep conversations.last_message_at accurate without the app having to remember.
create or replace function public.bump_conversation_last_message()
returns trigger language plpgsql as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists messages_bump_conversation on public.messages;
create trigger messages_bump_conversation
  after insert on public.messages
  for each row execute function public.bump_conversation_last_message();

-- ─── 4. notifications ────────────────────────────────────────────────────────
-- The bell feed. One row per person per event, so "mark read" is per-user.
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  profile_id uuid not null,
  kind       text not null,          -- lead_assigned | message | lead_status | system
  title      text not null,
  body       text,
  link       text,                   -- in-app path to open
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_profile_idx
  on public.notifications (profile_id, created_at desc);
-- Partial index: the unread count is the hottest query in the shell.
create index if not exists notifications_unread_idx
  on public.notifications (profile_id) where read_at is null;

-- ─── 5. leads.status → new | contacted | converted | lost ────────────────────
-- The staff-facing vocabulary from the employee mockups. 'qualified' and 'won'
-- both collapse into 'converted' — a distinction nobody was maintaining by hand.
alter table public.leads drop constraint if exists leads_status_chk;

update public.leads set status = 'converted' where status in ('qualified', 'won');
update public.leads set status = 'new'       where status is null;

do $$ begin
  alter table public.leads
    add constraint leads_status_chk check (status in ('new','contacted','converted','lost'));
exception when duplicate_object then null; end $$;

-- profiles.phone — editable from the employee Settings page (PATCH /api/client/me).
alter table public.profiles add column if not exists phone text;

-- ─── 6. RLS (deny-all; the service-role backend bypasses it) ─────────────────
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.notifications        enable row level security;
