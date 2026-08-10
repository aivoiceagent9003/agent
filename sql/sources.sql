-- sql/sources.sql — data-source ingestion (files, Google Sheets, database, realtime).
--
-- Additive. Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Extends contact_sources (already created in campaigns.sql) with the columns the
-- source engine needs, and (re)creates campaign_events for the realtime ingress
-- (/api/events/:id). Nothing here is destructive.

-- ─── contact_sources: batch source config + sync bookkeeping ─────────────────
alter table public.contact_sources add column if not exists name           text;
alter table public.contact_sources add column if not exists config         jsonb default '{}'::jsonb;
alter table public.contact_sources add column if not exists last_synced_at timestamptz;
alter table public.contact_sources add column if not exists last_result    jsonb default '{}'::jsonb;

-- kind now includes: file | google_sheet | database | csv | paste | manual
comment on column public.contact_sources.kind is 'file|google_sheet|database|csv|paste|manual';

create index if not exists contact_sources_campaign_idx
  on public.contact_sources (campaign_id, created_at desc);

-- ─── campaign_events: realtime ingress audit log ─────────────────────────────
create table if not exists public.campaign_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  campaign_id uuid not null,
  type        text,                                   -- source/preset or event name
  payload     jsonb default '{}'::jsonb,
  status      text default 'received',                -- received|triggered|rejected|error
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists campaign_events_campaign_idx
  on public.campaign_events (campaign_id, created_at desc);
