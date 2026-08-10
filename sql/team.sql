-- sql/team.sql — Employee access: roles, invitations, and the lead workflow.
--
-- WHAT THIS ADDS
--   1. profiles.tenant_role   — owner | manager | agent  (permission INSIDE a business)
--   2. invitations            — owner invites an employee by email, single-use token
--   3. leads workflow columns — status / assigned_to / notes, so an employee has
--                               something to actually DO with a lead
--   4. lead_activity          — append-only audit of who changed what
--
-- ⚠️ profiles.role is deliberately UNTOUCHED. It stays 'client' | 'admin' and keeps
-- routing platform-level access (requireAdmin in src/api/auth.js). Tenant-level
-- permission is the NEW tenant_role column. Mixing the two into one field would
-- have meant rewriting every existing role check.
--
-- Safe to run more than once (everything is IF NOT EXISTS / guarded).
-- Companion files: sql/schema.sql (base), sql/rls.sql (run AFTER this).

-- ─── 1. profiles: tenant-level role ──────────────────────────────────────────
alter table public.profiles
  add column if not exists tenant_role  text not null default 'owner',
  add column if not exists full_name    text,
  add column if not exists status       text not null default 'active',
  add column if not exists invited_by   uuid,
  add column if not exists last_seen_at timestamptz;

-- Everyone who exists today signed up for their own business — they are owners.
update public.profiles set tenant_role = 'owner' where tenant_role is null or role = 'client';

do $$ begin
  alter table public.profiles
    add constraint profiles_tenant_role_chk check (tenant_role in ('owner','manager','agent'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_status_chk check (status in ('active','suspended'));
exception when duplicate_object then null; end $$;

-- Fast "list everyone in this business" for the Team page.
create index if not exists profiles_tenant_idx on public.profiles (tenant_id, tenant_role);

-- ─── 2. invitations ──────────────────────────────────────────────────────────
-- The raw token is emailed and NEVER stored; we keep only its SHA-256 hash, so a
-- database leak cannot be replayed into account access.
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  tenant_role text not null default 'agent',
  token_hash  text not null unique,
  invited_by  uuid,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

do $$ begin
  alter table public.invitations
    add constraint invitations_role_chk check (tenant_role in ('owner','manager','agent'));
exception when duplicate_object then null; end $$;

create index if not exists invitations_tenant_idx on public.invitations (tenant_id, created_at desc);

-- At most ONE live invite per email per business. Re-inviting revokes the old row
-- first (see POST /api/client/team/invite), so this index is the safety net.
create unique index if not exists invitations_pending_idx
  on public.invitations (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ─── 3. leads: workflow columns ──────────────────────────────────────────────
-- Leads were previously READ-ONLY (src/api/client.js exposed GET only, and the
-- table had no status). An employee login is pointless without these.
alter table public.leads
  add column if not exists status      text not null default 'new',
  add column if not exists assigned_to uuid,
  add column if not exists notes       text,
  add column if not exists updated_at  timestamptz default now();

do $$ begin
  alter table public.leads
    add constraint leads_status_chk check (status in ('new','contacted','qualified','won','lost'));
exception when duplicate_object then null; end $$;

-- Drives the "My leads" view (tenant + assignee + status).
create index if not exists leads_assigned_idx on public.leads (tenant_id, assigned_to, status);
create index if not exists leads_status_idx   on public.leads (tenant_id, status, created_at desc);

-- ─── 4. lead_activity — append-only audit ────────────────────────────────────
-- Who changed what, when. Cheap now, painful to retrofit, and it doubles as the
-- evidence trail for the DPDP work in REMEDIATION_PLAN.md Phase 4.
create table if not exists public.lead_activity (
  id         bigserial primary key,
  lead_id    uuid not null references public.leads(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  actor_id   uuid,
  action     text not null,   -- status_changed | assigned | unassigned | note_added
  detail     jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lead_activity_lead_idx on public.lead_activity (lead_id, created_at desc);
create index if not exists lead_activity_tenant_idx on public.lead_activity (tenant_id, created_at desc);

-- ─── 5. RLS (same deny-all posture as the rest of the schema) ────────────────
-- The backend uses the service-role key and bypasses RLS; enabling it with no
-- policies means nothing can reach these tables through the public data API.
alter table public.invitations  enable row level security;
alter table public.lead_activity enable row level security;
