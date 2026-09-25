-- sql/billing.sql — invoices, payments, billing profiles and the plan-change log.
--
-- WHAT THIS ADDS
--   1. billing_profiles  — who the invoice is made out to: legal name, GSTIN, address.
--                          Required before an invoice can be issued in India.
--   2. invoices          — one per closed cycle, with its line items and GST frozen
--                          into the row.
--   3. payments          — money recorded against an invoice. No gateway yet; a row
--                          here is a record that something was paid, however it was.
--   4. plan_changes      — append-only audit of who moved which tenant to which plan.
--   5. tenants.config    — plan, plan_since, pending_plan (documented, not a column).
--
-- WHY AN INVOICE FREEZES ITS NUMBERS instead of recomputing them: a price list
-- changes, a plan is renamed, a call is deleted. An invoice that recalculates is an
-- invoice that disagrees with the one the customer already paid, and that argument is
-- unwinnable. The live billing page derives from calls; a CLOSED invoice never does.
--
-- Safe to run more than once. Companion files: sql/schema.sql, then sql/rls.sql.

-- ─── 1. billing profiles ─────────────────────────────────────────────────────
-- One row per tenant. `state_code` is the GST state code (Telangana 36, Karnataka 29,
-- Maharashtra 27...) and it decides whether a sale is intra-state (CGST+SGST) or
-- inter-state (IGST). Getting it wrong is a filing error, not a display bug.
create table if not exists public.billing_profiles (
  tenant_id     uuid primary key,
  legal_name    text,
  gstin         text,
  pan           text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  state_code    text,
  pincode       text,
  billing_email text,
  phone         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─── 2. invoices ─────────────────────────────────────────────────────────────
-- `number` is human-facing and must be unique and gapless per financial year for GST.
-- It is generated in application code (services/invoices.js) rather than by a sequence
-- so the format stays readable: AL-2627-0001.
--
-- Amounts are in PAISE, as integers. Storing rupees as a float means 0.1 + 0.2 lands
-- on an invoice, and a rounding difference of one paisa on a GST return is a notice
-- from the department.
create table if not exists public.invoices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  number         text not null,
  status         text not null default 'open',   -- draft | open | paid | void
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  plan_id        text,
  plan_name      text,
  -- What the customer is being charged for, frozen at issue time.
  line_items     jsonb not null default '[]'::jsonb,
  subtotal_paise bigint not null default 0,
  cgst_paise     bigint not null default 0,
  sgst_paise     bigint not null default 0,
  igst_paise     bigint not null default 0,
  total_paise    bigint not null default 0,
  -- The billing profile as it stood when the invoice was issued. An address that
  -- changes next month must not rewrite an invoice already sent.
  bill_to        jsonb,
  place_of_supply text,
  issued_at      timestamptz default now(),
  due_at         timestamptz,
  paid_at        timestamptz,
  notes          text,
  created_at     timestamptz default now()
);

create unique index if not exists invoices_number_key on public.invoices (number);
create index if not exists invoices_tenant_idx on public.invoices (tenant_id, period_start desc);
create index if not exists invoices_status_idx on public.invoices (tenant_id, status);

-- One invoice per tenant per cycle. Without this a retried cycle-close job issues a
-- second invoice for a month the customer has already paid.
create unique index if not exists invoices_tenant_period_key
  on public.invoices (tenant_id, period_start);

-- ─── 3. payments ─────────────────────────────────────────────────────────────
-- No gateway is wired yet. A row here says money arrived and how it was recorded;
-- `provider` and `provider_ref` are left free-form so whichever gateway is chosen
-- later drops straight in without a migration.
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  invoice_id    uuid,
  amount_paise  bigint not null,
  status        text not null default 'pending', -- pending | succeeded | failed | refunded
  method        text,                            -- upi | netbanking | card | neft | manual
  provider      text,
  provider_ref  text,
  requested_by  uuid,
  failure_reason text,
  created_at    timestamptz default now(),
  completed_at  timestamptz
);

create index if not exists payments_tenant_idx on public.payments (tenant_id, created_at desc);
create index if not exists payments_invoice_idx on public.payments (invoice_id);

-- ─── 4. plan changes ─────────────────────────────────────────────────────────
-- Append-only. "Why is this customer on Scale?" must be answerable a year later, and
-- a config field that was overwritten cannot answer it.
create table if not exists public.plan_changes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  from_plan     text,
  to_plan       text not null,
  kind          text not null,                   -- upgrade | downgrade | initial
  effective_at  timestamptz not null,
  prorated_paise bigint default 0,
  changed_by    uuid,
  created_at    timestamptz default now()
);

create index if not exists plan_changes_tenant_idx on public.plan_changes (tenant_id, created_at desc);

-- ─── 5. what lives on tenants.config ─────────────────────────────────────────
-- No migration needed; documented here because it is part of the billing contract.
--
--   plan          'starter' | 'growth' | 'scale'  — the plan in force NOW
--   plan_since    ISO timestamp the current plan took effect
--   pending_plan  a DOWNGRADE queued for the next cycle boundary. Downgrades do not
--                 take effect immediately: the customer has already paid for this
--                 cycle's allowance and taking it away mid-month is theft.
--   extra_numbers count of numbers beyond what the plan includes

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- sql/rls.sql enables RLS on every table it finds with no policies, so these are
-- covered by running it afterwards. Listed here so it is obvious they are not exempt.
alter table public.billing_profiles enable row level security;
alter table public.invoices         enable row level security;
alter table public.payments         enable row level security;
alter table public.plan_changes     enable row level security;
