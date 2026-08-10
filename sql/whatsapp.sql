-- sql/whatsapp.sql — WhatsApp: sendable documents + an audit log of sent messages.
-- Follows schema.sql conventions (uuid pk, tenant_id scoping, timestamptz).
-- Run in Supabase. whatsapp_documents is REQUIRED to send files; whatsapp_messages
-- is optional (the sender no-ops if it's absent).

-- Files the agent hands to customers (brochure, menu, price list, catalogue…).
-- Deliberately NOT the knowledge base: these are never chunked or embedded, so an
-- image-only PDF works fine here. Bytes live in the 'knowledge-files' bucket under
-- <tenant_id>/whatsapp/. See src/services/sendables.js.
create table if not exists public.whatsapp_documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  topic         text not null default '',  -- what callers ask for: "My Home Apas", "Menu"
  filename      text not null,
  mime_type     text,
  size_bytes    bigint,
  storage_path  text,
  created_at    timestamptz not null default now()
);

create index if not exists whatsapp_documents_tenant_idx on public.whatsapp_documents (tenant_id, created_at desc);

create table if not exists public.whatsapp_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  to_number   text not null,
  kind        text,                    -- 'brochure' | 'booking' | 'text'
  message_id  text,                    -- provider message id
  status      text default 'sent',     -- 'sent' | 'failed'
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists whatsapp_messages_tenant_idx on public.whatsapp_messages (tenant_id, created_at desc);
