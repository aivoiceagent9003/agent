# Employee Access — Implementation Plan

Adds a second class of user: **employees invited by a business owner**, who sign in
at their own login page and get a restricted view (calls + leads) rather than the
full owner dashboard.

## Decisions locked

| Decision | Choice |
|---|---|
| Login | **One page, Employee/Business toggle** on `/login` (revised — was two separate pages; `/employee-login` now redirects to `/login?tab=employee`) |
| Lead workflow | **Full** — status + assignment + notes + activity log |
| Roles | **Owner / Manager / Agent** |

### How two login pages stay maintainable

Both pages call the **same** `login()` helper and the same `POST /api/auth/login`,
then branch on the returned role — exactly what [admin-login.tsx](frontend/src/routes/admin-login.tsx#L26-L33)
already does today. Two branded doors, one auth implementation. No duplicated
OAuth, refresh, or reset logic.

**Wrong-door handling:** rather than `admin-login`'s hard error ("This account is
not an admin"), a user who signs in at the wrong page is *soft-redirected* to the
right dashboard with a toast. Same credentials work at either door; only the
landing page differs. This removes the main failure mode of split logins.

---

## 1. Data model — `sql/team.sql` (new)

### 1.1 Extend `profiles`

`role` stays exactly as-is (`client` | `admin`) so `requireAdmin()`
([auth.js:43-51](src/api/auth.js#L43-L51)) and every existing check keep working
untouched. Tenant-level permission goes in a **new** column.

```sql
alter table public.profiles
  add column if not exists tenant_role  text not null default 'owner',  -- owner|manager|agent
  add column if not exists full_name    text,
  add column if not exists status       text not null default 'active', -- active|suspended
  add column if not exists invited_by   uuid,
  add column if not exists last_seen_at timestamptz;

-- Every existing tenant user is the owner of their business.
update public.profiles set tenant_role = 'owner' where role = 'client';

alter table public.profiles
  add constraint profiles_tenant_role_chk
  check (tenant_role in ('owner','manager','agent'));
```

### 1.2 Invitations

```sql
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  tenant_role text not null default 'agent',
  token_hash  text not null unique,          -- SHA-256 of the token; raw token never stored
  invited_by  uuid,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists invitations_tenant_idx on public.invitations (tenant_id, created_at desc);

-- One live invite per email per tenant (re-inviting revokes + reissues).
create unique index if not exists invitations_pending_idx
  on public.invitations (tenant_id, lower(email))
  where accepted_at is null and revoked_at is null;
```

### 1.3 Lead workflow

The `leads` table ([schema.sql:93-109](sql/schema.sql#L93-L109)) has no status or
ownership today, and [client.js](src/api/client.js) exposes leads read-only. Without
this, an employee login lands on a screen they cannot act on.

```sql
alter table public.leads
  add column if not exists status       text not null default 'new',
  add column if not exists assigned_to  uuid,
  add column if not exists notes        text,
  add column if not exists updated_at   timestamptz default now();

alter table public.leads
  add constraint leads_status_chk
  check (status in ('new','contacted','qualified','won','lost'));

create index if not exists leads_assigned_idx on public.leads (tenant_id, assigned_to, status);

-- Append-only audit: who changed what, when.
create table if not exists public.lead_activity (
  id         bigserial primary key,
  lead_id    uuid not null references public.leads(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  actor_id   uuid,
  action     text not null,        -- status_changed|assigned|note_added|created
  detail     jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_activity_lead_idx on public.lead_activity (lead_id, created_at desc);
```

Add all three new tables to [sql/rls.sql](sql/rls.sql) (`enable row level security`,
no policies — same deny-all-except-service-role posture as the rest).

---

## 2. Backend

### 2.1 Permission layer — `src/api/permissions.js` (new)

> **This is the critical piece.** `requireClient()`
> ([auth.js:55-63](src/api/auth.js#L55-L63)) only checks that a `tenant_id` exists,
> and it guards *every* route in `agent.js`, `campaigns.js`, `whatsapp.js`, and
> `client.js`. The moment an employee profile has a `tenant_id`, they can reconfigure
> the agent and launch campaigns. **This must ship in the same PR as invites, not after.**

```js
export const PERMISSIONS = {
  owner: ['*'],
  manager: [
    'calls:read', 'leads:read', 'leads:write',
    'campaigns:read', 'campaigns:write',
    'knowledge:read', 'knowledge:write',
    'whatsapp:read', 'whatsapp:write',
    'team:read',
  ],
  agent: ['calls:read', 'leads:read', 'leads:write'],
}

export function can(tenantRole, perm) {
  const list = PERMISSIONS[tenantRole] || []
  return list.includes('*') || list.includes(perm)
}

export function requirePermission(perm) {
  return (req, res, next) => {
    if (!can(req.auth?.tenantRole, perm)) {
      return res.status(403).json({ error: 'You do not have access to this' })
    }
    next()
  }
}
```

Add `tenantRole` to the `resolveUser()` select and return value in
[auth.js:17-29](src/api/auth.js#L17-L29). Also reject `status = 'suspended'` profiles
there — that gives you instant off-boarding without deleting the account.

### 2.2 Mount permissions on existing routers

| Router | Guard |
|---|---|
| [src/api/agent.js](src/api/agent.js) | `knowledge:write` on `/knowledge*`, `/lookups*`; **owner-only** on `PATCH /`, `/publish`, `/voices`, `/generate-prompt` |
| [src/api/campaigns.js:23](src/api/campaigns.js#L23) | `campaigns:read` on GET, `campaigns:write` on mutations |
| [src/api/whatsapp.js](src/api/whatsapp.js) | `whatsapp:*` |
| [src/api/client.js:11](src/api/client.js#L11) | `calls:read` / `leads:read` |
| [src/api/instant.js](src/api/instant.js) | `campaigns:write` |

Audit every route once, explicitly. A missed route is a privilege-escalation bug.

### 2.3 Team API — `src/api/team.js` (new), mounted at `/api/client/team`

| Endpoint | Guard | Notes |
|---|---|---|
| `GET /` | `team:read` | Members + pending invites |
| `POST /invite` `{email, tenant_role}` | owner | Revokes any existing pending invite for that email, issues a new one, emails the link |
| `POST /invite/:id/resend` | owner | Re-sends; does **not** extend expiry |
| `DELETE /invite/:id` | owner | Revoke |
| `PATCH /:profileId` `{tenant_role \| status}` | owner | Cannot change your own role; cannot demote the last owner |
| `DELETE /:profileId` `{reassign_to?}` | owner | Reassigns or unassigns their leads first |

Token generation:

```js
const raw = crypto.randomBytes(32).toString('base64url')      // goes in the email only
const token_hash = crypto.createHash('sha256').update(raw).digest('hex')  // goes in the DB
```

### 2.4 Public invite acceptance — in [src/api/public.js](src/api/public.js)

| Endpoint | Behaviour |
|---|---|
| `GET /api/public/invite/:token` | Returns `{ business_name, email, tenant_role }`, or 410 if expired/revoked/accepted. Lets `/join` render "Acme invited you to join as Agent". |
| `POST /api/public/invite/:token/accept` | Creates the auth user via `supabaseAdmin`, inserts the profile with `tenant_id` + `tenant_role` from the invite, stamps `accepted_at`, returns a session token. |

**Security requirements:**
- The accepted account's email **must match** the invited email. Since signup is
  Google-only today, verify the Google `credential`'s email equals `invitations.email`
  before provisioning — otherwise the invite link becomes a free account for anyone.
- Single use: check `accepted_at is null` inside the same transaction that sets it.
- Rate limit by IP (ties into Phase 1.4 of [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md)).
- If the email already has a profile on a *different* tenant, reject clearly — one
  user belongs to one tenant in this model.

### 2.5 Lead mutation API — extend [src/api/client.js](src/api/client.js)

```
PATCH /api/client/leads/:id      { status?, assigned_to?, notes? }   leads:write
GET   /api/client/leads/:id/activity                                 leads:read
```

Every write appends a `lead_activity` row with `actor_id = req.auth.userId`.
`assigned_to` must be a profile in the **same tenant** — validate it, don't trust it.

Extend `GET /leads` with `?assigned_to=me` and `?status=` so the "My leads" view is
one query.

### 2.6 Invite email — extend [src/services/email.js](src/services/email.js)

Add `sendInviteEmail({ to, businessName, inviterName, role, url })` following the
existing `renderWelcomeEmail` pattern (exported renderer + never-throws sender).
Link: `${APP_URL}/join?token=<raw>`.

Also worth adding now: `sendLeadAssignedEmail` — SMTP is already wired, so it's nearly free.

---

## 3. Frontend

### 3.1 New routes

| Route | Purpose |
|---|---|
| `/employee-login` | Employee door. Mirrors [admin-login.tsx](frontend/src/routes/admin-login.tsx): own branding, shared `login()` helper, role check after. |
| `/join` | Reads `?token=`, calls `GET /api/public/invite/:token`, shows "Acme invited you as Agent", renders the Google sign-in button, posts to `/accept`. |
| `/app/team` | Owner-only. Members list, role dropdowns, pending invites with resend/revoke, invite form. |

Add a cross-link on each login page ("Are you an employee? Sign in here" / "Business
owner? Sign in here") so a wrong-door user self-corrects in one click.

### 3.2 Role-driven navigation

`clientNav` in [PortalShell.tsx:65-72](frontend/src/components/portal/PortalShell.tsx#L65-L72)
is a hardcoded array. Add a `perm` field per item and filter by the signed-in role:

| Nav item | Min role |
|---|---|
| Overview, Calls, Leads | agent |
| Campaigns, Instant Calls, Knowledge, WhatsApp | manager |
| Agent settings, **Team** | owner |

Hiding nav is cosmetic — 2.2 is what actually enforces it.

### 3.3 ⚠️ Fix the onboarding redirect

[app.tsx:19-23](frontend/src/routes/app.tsx#L19-L23) redirects any user whose tenant
has no `phone_number` to `/onboarding`. An invited employee would be bounced into a
setup wizard they have no permission to complete — an infinite redirect loop for the
first employee of a not-yet-configured business.

Gate it: `needsOnboarding && tenantRole === 'owner'`. Employees see an "Your admin is
still setting things up" empty state instead.

Related: `app.tsx` calls `useAgent()` on mount, which hits `GET /api/client/agent`.
Either allow read for all tenant roles, or give the shell a lighter `/api/client/me`
endpoint returning `{ tenant_role, business_name, phone_number, permissions }`. **The
`/me` endpoint is the better call** — the frontend needs the permission list anyway
for 3.2.

### 3.4 Lead workflow UI

On [app.leads.tsx](frontend/src/routes/app.leads.tsx): status dropdown, assignee
picker, notes field, and an activity timeline in the detail view. Plus a "My leads"
filter that becomes the default landing view for the `agent` role.

---

## 4. Edge cases to handle explicitly

1. **Last owner** — cannot demote or remove the only owner. Enforce server-side.
2. **Removing a member with assigned leads** — `DELETE /:profileId` takes an optional
   `reassign_to`; unassign if omitted. Never orphan.
3. **Email enumeration** — invite responses must not reveal whether an email already
   has a Vocera account.
4. **Expired / already-used links** — `/join` renders a clear "This invite expired,
   ask your admin to resend" state, not a crash.
5. **Suspended users** — blocked in `resolveUser()`, so their existing JWT stops
   working within one request rather than at token expiry.
6. **Seat limits** — leave a `checkSeats(tenantId)` hook in `POST /invite` returning
   `true` for now. Phase 3 of [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md) fills it in
   from `plans.max_seats`.

---

## 5. Build order

**Step 1 — Data + permissions (no user-visible change)**
`sql/team.sql`, `permissions.js`, `tenantRole` in `resolveUser`, permission guards on
every existing router, `/api/client/me`. Existing owners keep working identically.

**Step 2 — Invite + join**
`team.js`, public invite endpoints, invite email, `/app/team`, `/join`.
*Testable end to end: invite yourself at a second email address and join.*

**Step 3 — Employee login + role-driven UI**
`/employee-login`, nav filtering, the `app.tsx` onboarding fix, employee empty states.

**Step 4 — Lead workflow**
Lead columns + `lead_activity`, `PATCH /leads/:id`, activity endpoint, leads UI,
"My leads" view, assignment email.

Steps 1–3 are one coherent PR if you prefer; step 4 stands alone cleanly.

---

## 6. Test checklist

- [ ] An `agent` calling `PATCH /api/client/agent` gets 403
- [ ] An `agent` calling `POST /api/client/campaigns` gets 403
- [ ] A `manager` can run campaigns but cannot invite or change the agent persona
- [ ] An invite token works exactly once; second use returns 410
- [ ] A Google account whose email ≠ the invited email is rejected
- [ ] An expired invite (>7 days) is rejected
- [ ] Employee of tenant A cannot read any row of tenant B (calls, leads, campaigns)
- [ ] The last owner cannot be demoted or removed
- [ ] Removing a member reassigns or unassigns their leads
- [ ] An employee in a business with no `phone_number` does **not** loop to `/onboarding`
- [ ] A suspended employee's existing token stops working on the next request
- [ ] Every lead status change writes a `lead_activity` row with the right `actor_id`

The cross-tenant test is the one to automate first — it's the failure that would
matter most, and adding a second user class multiplies the paths where a missing
`tenant_id` filter leaks data.
