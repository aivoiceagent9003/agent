-- sql/compliance.sql — DPDP 2023 + TRAI compliance columns and retention.
--
-- Run AFTER sql/schema.sql and sql/campaigns.sql. Safe to run more than once.
--
-- Three things live here:
--   1. Evidence that a recording notice was actually played (calls)
--   2. Retention windows per tenant, so data stops accumulating forever
--   3. An audit trail for erasure requests, which is the thing a regulator asks
--      to see — "we deleted it" is not an answer without a record of the deletion

-- ─── 1. Recording consent evidence ───────────────────────────────────────────
-- Recording is opt-in per tenant (tenants.config.recording_enabled). When it is
-- on, the greeting carries a disclosure — see recordingNotice() in
-- src/services/greeting.js. This column records that it went out on THIS call,
-- because "our greeting normally says so" is not evidence about a specific call.
alter table public.calls
  add column if not exists consent_notice_played boolean not null default false;

-- Nulled rather than dropped when a caller is pseudonymised, so the call still
-- counts in analytics after the personal data is gone.
alter table public.calls
  add column if not exists anonymized_at timestamptz;

alter table public.leads
  add column if not exists anonymized_at timestamptz;

-- ─── 2. Suppression list provenance ──────────────────────────────────────────
-- The list already existed but only tenants could write to it. Now the CALLER can
-- too, by asking the agent — so we need to know which entries came from the person
-- themselves, since those carry more weight than a tenant-uploaded row.
alter table public.suppression_list
  add column if not exists source text not null default 'tenant';

do $$ begin
  alter table public.suppression_list
    add constraint suppression_source_chk
    check (source in ('tenant', 'caller_request', 'dnd_registry', 'admin'));
exception when duplicate_object then null; end $$;

alter table public.suppression_list
  add column if not exists reason text;

-- ─── 3. Erasure audit trail ──────────────────────────────────────────────────
-- One row per data-subject erasure request. Deliberately keeps a HASH of the
-- number rather than the number itself: storing the phone number of someone who
-- asked to be forgotten would defeat the request, but we still need to prove the
-- erasure happened and be able to answer "did you action mine?".
create table if not exists public.erasure_requests (
  id            uuid primary key default gen_random_uuid(),
  phone_hash    text not null,
  requested_by  uuid,
  calls_erased  int not null default 0,
  leads_erased  int not null default 0,
  contacts_erased int not null default 0,
  recordings_deleted int not null default 0,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists erasure_requests_hash_idx
  on public.erasure_requests (phone_hash, created_at desc);

-- ─── 4. Retention ────────────────────────────────────────────────────────────
-- Per-tenant window; the nightly job reads tenants.config.retention_days and
-- falls back to this default. Kept in config rather than a column so it can be
-- changed per tenant without a migration.
--
-- Nothing to alter here — documented so the knob is discoverable:
--   tenants.config.retention_days   integer, default 90 (see src/jobs/retention.js)

-- ─── 5. RLS ──────────────────────────────────────────────────────────────────
alter table public.erasure_requests enable row level security;
