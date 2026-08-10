-- sql/campaigns.sql — Campaign Automation Platform schema (additive).
--
-- Outbound campaign automation on top of the existing inbound voice platform.
-- Follows sql/schema.sql conventions: uuid pk, tenant_id scoping, timestamptz,
-- IF NOT EXISTS everywhere (safe to re-run). Nothing here alters existing tables
-- except ADDING nullable columns to `calls` for inbound/outbound differentiation.

-- ─── calls: inbound/outbound differentiation + campaign linkage (ADDITIVE) ──────
alter table public.calls add column if not exists direction text not null default 'inbound';
alter table public.calls add column if not exists campaign_id uuid;
alter table public.calls add column if not exists campaign_contact_id uuid;
alter table public.calls add column if not exists campaign_run_id uuid;
create index if not exists calls_direction_idx on public.calls (tenant_id, direction, created_at desc);
create index if not exists calls_campaign_idx on public.calls (campaign_id);

-- ─── campaigns ──────────────────────────────────────────────────────────────────
create table if not exists public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  name         text not null,
  type         text not null default 'ai_sales',   -- broadcast | ai_sales | ai_followup | event
  status       text not null default 'draft',       -- draft|scheduled|running|paused|completed|archived
  direction    text not null default 'outbound',
  from_number  text,                                 -- caller-id used to originate
  config       jsonb default '{}'::jsonb,            -- prompt/voice/language/kb/temperature/goal/... OR broadcast template
  schedule     jsonb default '{}'::jsonb,            -- {mode, start_at, cron, timezone, business_hours, blackout_dates}
  retry_policy jsonb default '{}'::jsonb,            -- {max_attempts, delay_minutes, window, dispositions[]}
  compliance   jsonb default '{}'::jsonb,            -- {respect_dnd, working_hours, frequency_cap, ...}
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists campaigns_tenant_idx on public.campaigns (tenant_id, created_at desc);
create index if not exists campaigns_status_idx on public.campaigns (status);

-- ─── campaign_contacts ──────────────────────────────────────────────────────────
create table if not exists public.campaign_contacts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  campaign_id       uuid not null,
  name              text,
  phone             text not null,                  -- E.164 normalized
  custom_fields     jsonb default '{}'::jsonb,
  segment           text,                            -- hot|warm|cold|vip|... (Phase 2 auto-segmentation)
  status            text not null default 'pending', -- pending|queued|dialing|completed|failed|no_answer|dnc|opted_out
  disposition       text,                            -- busy|no_answer|voicemail|rejected|failed|answered|...
  attempts          int not null default 0,
  last_contacted_at timestamptz,
  call_id           uuid,
  dedupe_key        text,                            -- tenant_id + normalized phone, for dedupe
  created_at        timestamptz not null default now()
);
create index if not exists campaign_contacts_campaign_idx on public.campaign_contacts (campaign_id, status);
create index if not exists campaign_contacts_tenant_idx on public.campaign_contacts (tenant_id);
create unique index if not exists campaign_contacts_dedupe_idx on public.campaign_contacts (campaign_id, dedupe_key);

-- ─── contact_sources ────────────────────────────────────────────────────────────
create table if not exists public.contact_sources (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  campaign_id uuid,
  kind       text not null default 'csv',           -- csv|paste|manual|crm|db|api|cloud (Phase 2+)
  filename   text,
  row_count  int default 0,
  status     text default 'ready',
  detail     jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contact_sources_tenant_idx on public.contact_sources (tenant_id, created_at desc);

-- ─── campaign_runs ──────────────────────────────────────────────────────────────
create table if not exists public.campaign_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  status      text not null default 'running',       -- running|completed|stopped|failed
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  totals      jsonb default '{}'::jsonb
);
create index if not exists campaign_runs_campaign_idx on public.campaign_runs (campaign_id, started_at desc);

-- ─── campaign_logs (append-only event stream) ───────────────────────────────────
create table if not exists public.campaign_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  campaign_id uuid not null,
  run_id      uuid,
  contact_id  uuid,
  event       text not null,                          -- queued|dialing|answered|no_answer|completed|failed|retry|converted|transferred|...
  detail      jsonb default '{}'::jsonb,
  ts          timestamptz not null default now()
);
create index if not exists campaign_logs_campaign_idx on public.campaign_logs (campaign_id, ts desc);
create index if not exists campaign_logs_event_idx on public.campaign_logs (campaign_id, event);

-- ─── campaign_metrics (rolled-up aggregates) ────────────────────────────────────
create table if not exists public.campaign_metrics (
  campaign_id      uuid primary key,
  tenant_id        uuid not null,
  calls            int default 0,
  answered         int default 0,
  conversations    int default 0,
  ai_minutes       double precision default 0,
  human_transfers  int default 0,
  qualified_leads  int default 0,
  meetings_booked  int default 0,
  no_answer        int default 0,
  failed           int default 0,
  cost             double precision default 0,
  revenue          double precision default 0,
  language_dist    jsonb default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

-- ─── retry_queue + scheduled_jobs (durable mirrors for audit/recovery) ──────────
create table if not exists public.retry_queue (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  contact_id  uuid not null,
  attempt     int not null default 1,
  reason      text,
  run_after   timestamptz not null,
  status      text not null default 'scheduled',      -- scheduled|dispatched|cancelled
  created_at  timestamptz not null default now()
);
create index if not exists retry_queue_due_idx on public.retry_queue (status, run_after);

create table if not exists public.scheduled_jobs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  kind        text not null,                          -- run|recurring
  cron        text,
  next_run_at timestamptz,
  status      text not null default 'active',
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists scheduled_jobs_campaign_idx on public.scheduled_jobs (campaign_id);

-- ─── campaign_templates ─────────────────────────────────────────────────────────
create table if not exists public.campaign_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid,                                    -- null = platform/global template
  name       text not null,
  type       text not null default 'ai_sales',
  config     jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists campaign_templates_tenant_idx on public.campaign_templates (tenant_id);

-- ─── suppression_list (compliance) ──────────────────────────────────────────────
create table if not exists public.suppression_list (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  phone      text not null,                           -- E.164 normalized
  reason     text default 'opt_out',                  -- dnd|opt_out|blacklist
  created_at timestamptz not null default now()
);
create unique index if not exists suppression_unique_idx on public.suppression_list (tenant_id, phone);
