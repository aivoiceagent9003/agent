# Remediation Plan — Production Hardening

Every item traced to a finding in the codebase audit. Ordered by **dependency and
blast radius**, not by difficulty: repo integrity first (everything else depends on
it), then live fraud vectors, then the things that make the product chargeable and
legal, then the things that make it deployable.

Each step lists the **files to touch**, the **change**, and an **acceptance test** you
can actually run. Phases 0–2 are sequential. Phases 3–6 can be parallelised across
people if you have them.

| Phase | Theme | Est. | Blocks |
|---|---|---|---|
| 0 | Repo integrity | 1 hr | everything |
| 1 | Security lockdown | 2–3 days | any public deploy |
| 2 | Deployability | 2 days | any deploy at all |
| 3 | Billing & metering | 4–6 days | charging customers |
| 4 | Compliance | 3–4 days | selling in India |
| 5 | Auth & session | 2 days | real users |
| 6 | Tests & CI | 3 days | changing anything safely |

---

## Phase 0 — Repo integrity

**Why first:** ~90 files of work are uncommitted and two required build files are
gitignored. Until this is fixed, every other change risks being lost and no
teammate/CI can build the frontend.

### 0.1 Fix the blanket `*.json` ignore rule

`.gitignore:11` ignores **all** JSON, excepting only `package.json` /
`package-lock.json`. Confirmed effect: `frontend/tsconfig.json` and
`frontend/components.json` are untracked → fresh clone cannot build.

Replace the blanket rule with credential-specific patterns:

```gitignore
# Service account / credential files (NOT all JSON)
*-service-account*.json
aivoiceagent-*.json
gcp-*.json
**/credentials.json
```

Then `git add frontend/tsconfig.json frontend/components.json` and any other config
JSON that `git status --ignored` reveals.

**Accept:** `git ls-files "*.json" | wc -l` > 2, and a clone into a temp dir runs
`npm --prefix frontend install && npm --prefix frontend run build` successfully.

### 0.2 Verify no secret is now tracked

```bash
git ls-files | grep -iE "service-account|credentials|\.env$"   # must be empty
```

Confirm `aivoiceagent-496910-*.json` and `.env` are still ignored.

### 0.3 Commit the working tree

The repo has 2 commits and ~90 uncommitted files. Break into logical commits
(ops-center, campaigns, whatsapp, gemini migration, frontend) rather than one blob,
then push to a remote. **Nothing below should start before this is done.**

### 0.4 Rotate the service-account key

`aivoiceagent-496910-ab59603027c9.json` has sat on disk in the repo root for months.
Rotate it in GCP, move the new one outside the repo tree, point
`GOOGLE_APPLICATION_CREDENTIALS` at the new path.

---

## Phase 1 — Security lockdown

**Why second:** these are exploitable right now on any publicly reachable deploy.

### 1.1 Authenticate telephony webhooks — *highest priority in this phase*

`/answer`, `/hangup`, `/answer-campaign`, `/vobiz/transfer` (`src/index.js:58-67`)
accept unauthenticated POSTs from anyone.

**The urgent one:** `vobizTransferXml` (`src/telephony/vobiz.js:125-142`) reflects
`?to=` into `<Dial><Number>{to}</Number></Dial>`. That is an open toll-fraud relay.

Create `src/api/webhook-auth.js`:

```js
// Shared-secret gate for provider webhooks. Vobiz has no documented request
// signing, so we authenticate the URL itself: the secret rides in the path we
// hand the provider, and every webhook mount verifies it.
import crypto from 'crypto'

const SECRET = process.env.WEBHOOK_SECRET || ''

export function requireWebhookSecret() {
  return (req, res, next) => {
    if (!SECRET) return res.status(503).send('webhook secret not configured')
    const got = String(req.query.k || req.headers['x-webhook-secret'] || '')
    const a = Buffer.from(got), b = Buffer.from(SECRET)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).send('forbidden')
    }
    next()
  }
}
```

Additionally, **sign the transfer destination** rather than trusting the query
string. In `src/services/handoff.js`, when building the `aleg_url`, append an HMAC
of `to` + `callerId`; `vobizTransferXml` recomputes it and rejects a mismatch. This
closes the fraud vector even if `WEBHOOK_SECRET` leaks into a provider log.

Also add: `to` must match `/^\+?[0-9]{8,15}$/`, and XML-escape both `to` and
`callerId` before interpolation.

**Files:** `src/api/webhook-auth.js` (new), `src/index.js:58-67`,
`src/telephony/vobiz.js:125-142`, `src/services/handoff.js`, `.env.example`.
**Also update:** the Vobiz console URLs and `wsUrl` construction at
`src/telephony/vobiz.js:107` to carry `?k=<secret>`.

**Accept:** `curl -X POST https://<host>/vobiz/transfer?to=+919999999999` → 403.
A real inbound call still connects end to end.

### 1.2 Remove the public LLM endpoints

`src/index.js:254` (`POST /api/test-turn`) and `src/index.js:275` (`GET /test`) are
unauthenticated and cost money per request.

Delete both. The browser tester at `/test-stream` (auth'd via Supabase token,
`src/index.js:181`) already supersedes them, and `VoiceTester.tsx` is the real UI.
If you want to keep `/test` for debugging, gate it behind `requireAdmin()`.

**Accept:** `curl -X POST <host>/api/test-turn -d '{"message":"hi"}'` → 404.

### 1.3 Pin CORS

`src/index.js:29` defaults to `*` while allowing `Authorization`.

```js
const ALLOWED = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
  }
  // ... methods/headers as today
})
```

Fail loudly at boot if `FRONTEND_ORIGIN` is unset in production.

**Accept:** a request with `Origin: https://evil.test` gets no CORS header; the real
dashboard origin still works.

### 1.4 Add HTTP rate limiting + helmet

The only limiter today is the demo's per-IP counter (`src/telephony/demo.js:164`).

`npm i express-rate-limit helmet`

Apply `helmet()` globally, then tiered limits:

| Scope | Limit |
|---|---|
| `/api/auth/*`, `/api/signup` | 10 / 15 min / IP |
| `/api/client/agent/knowledge*`, `/lookups/dataset` | 20 / hr / tenant |
| `/api/client/campaigns` (POST) | 30 / hr / tenant |
| everything else under `/api` | 300 / 15 min / IP |

Key tenant-scoped limiters on `req.auth.tenantId` (mount them *after* `requireClient`).
Set `app.set('trust proxy', 1)` so IPs are real behind the proxy.

**Accept:** 11 rapid login attempts → the 11th returns 429.

### 1.5 Validate upload MIME types + cap knowledge volume

File-size caps already exist (15MB at `src/api/agent.js:38-41`, 25MB at
`src/api/campaigns.js:22`). What's missing:

- A `fileFilter` allow-listing pdf / docx / txt / csv / xlsx / png / jpeg. Today any
  file type reaches `extractTextFromFile` and the vision OCR path.
- A **per-tenant knowledge cap** (e.g. 200 documents / 50k chunks). Embedding spend
  is currently unbounded per tenant — check the count in
  `POST /knowledge` and `/knowledge/upload` before ingesting.

**Accept:** uploading a `.exe` → 400. Exceeding the doc cap → 402/403 with a clear message.

### 1.6 Fix the `pendingCalls` leak

`src/telephony/vobiz.js:51` — entries are only deleted on a successful WS `start`
(`:213-217`). Calls where the stream never connects leak forever.

Store `createdAt` alongside each entry and sweep entries older than 60s on an
`setInterval(..., 30_000).unref()`.

**Accept:** POST `/answer` 100× without connecting a WS; after 2 min `pendingCalls.size === 0`.

---

## Phase 2 — Deployability

**Why now:** you cannot safely ship Phases 3–6 to production without these. Small
phase, high leverage.

### 2.1 Health endpoint

None exists. Add to `src/index.js`:

- `GET /health` → `200 {ok:true}` (liveness, no dependencies)
- `GET /health/ready` → checks Supabase reachability + Redis (if `REDIS_URL` set)

### 2.2 Graceful shutdown for the API process

Only `src/worker.js:88-89` handles SIGTERM. The API does not — **every deploy
hard-kills live calls mid-conversation**, skipping `finalize()` in
`src/telephony/vobiz.js:354`. Result: lost transcripts, lost leads, and `calls` rows
stuck at `status='active'` forever.

```js
async function shutdown(sig) {
  console.log(`[API] ${sig} — draining…`)
  server.close()                       // stop accepting new connections
  // let in-flight calls finalize; vobiz/campaign handlers run finalize() on close
  for (const wss of [vobizWss, campaignWss, demoWss, testWss, opsWss]) {
    wss.clients.forEach(c => { try { c.close(1001, 'server shutting down') } catch {} })
  }
  await new Promise(r => setTimeout(r, Number(process.env.SHUTDOWN_GRACE_MS || 15000)))
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
```

Set the platform's termination grace period **above** `SHUTDOWN_GRACE_MS`.

Pair this with a **startup reconciler**: on boot, mark any `calls` row still
`status='active'` older than 2h as `status='interrupted'`.

**Accept:** start a call, `kill -TERM` the API, confirm the `calls` row reaches
`status='completed'` with a transcript.

### 2.3 Crash visibility

No `unhandledRejection` / `uncaughtException` handler anywhere; logging is
`console.log` only.

- Add both process handlers (log + `telemetry.recordServiceEvent` + exit non-zero on
  `uncaughtException`).
- Add `pino` for structured JSON logs with a `callSid` field, so Ops Center traces
  and log lines can be correlated.
- Wire Sentry (`@sentry/node`) with the Express error handler. ~30 min, and it turns
  invisible prod failures into alerts.

### 2.4 Containerise + CI

No `Dockerfile`, no `.github/`, no deploy config exists.

- `Dockerfile` (node:22-alpine, `npm ci --omit=dev`, non-root user) — note
  `FFMPEG_PATH` must resolve inside the image if the recording path needs it.
- `docker-compose.yml` for local: api + worker + redis.
- `.github/workflows/ci.yml`: install → lint → `npm test` → build frontend, on PR.

**Accept:** `docker compose up` serves `/health`; CI green on a PR.

### 2.5 Replace ngrok in the call path

`src/telephony/vobiz.js:107` builds the media-stream URL from `NGROK_URL`.
`.env.example` already has `PUBLIC_HOST` — use it here with `NGROK_URL` as the dev
fallback, and fail at boot if neither is set.

---

## Phase 3 — Billing & metering

**Why it matters most commercially:** there is currently no plan, quota, credit, or
per-tenant cap anywhere in the codebase. `COST_PER_MIN_USD` / `PRICE_PER_MIN_USD`
(`.env.example:76-78`) and `campaign_metrics.cost` (`sql/campaigns.sql:110`) exist but
nothing enforces or bills. One tenant can burn unlimited Gemini Live minutes.

### 3.1 Schema — `sql/billing.sql` (new)

```sql
create table if not exists public.plans (
  id text primary key,                      -- 'trial' | 'starter' | 'growth'
  name text not null,
  included_minutes int not null default 0,
  max_concurrent_calls int not null default 2,
  max_documents int not null default 50,
  price_inr numeric not null default 0,
  overage_per_min_inr numeric not null default 0
);

create table if not exists public.tenant_subscriptions (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null default 'trialing',  -- trialing|active|past_due|suspended
  period_start timestamptz not null default date_trunc('month', now()),
  period_end   timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  balance_minutes numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- Append-only meter. One row per billable unit of work.
create table if not exists public.usage_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,                       -- call_minutes|whatsapp_msg|embedding_tokens
  quantity numeric not null,
  call_id uuid,
  campaign_id uuid,
  unit_cost_inr numeric,
  occurred_at timestamptz not null default now()
);
create index on public.usage_events (tenant_id, occurred_at desc);
create index on public.usage_events (tenant_id, kind, occurred_at desc);
```

Add to `sql/rls.sql`: `alter table ... enable row level security` for all three.

### 3.2 Metering service — `src/services/billing.js` (new)

```
recordUsage({ tenantId, kind, quantity, callId, campaignId })
getBalance(tenantId)      -> { plan, usedMinutes, includedMinutes, remaining, status }
checkQuota(tenantId, kind) -> { ok, reason }
```

Cache `getBalance` in-process for ~30s — it sits on the call-answer hot path.

### 3.3 Meter every billable path

| Where | Hook |
|---|---|
| `src/telephony/vobiz.js:368` (`finalize`, `durationSeconds`) | `recordUsage('call_minutes')` |
| `src/telephony/campaign.js` finalize | same |
| `src/telephony/demo.js` cleanup | meter to a platform pseudo-tenant so demo spend is visible |
| `src/services/whatsapp.js` send | `recordUsage('whatsapp_msg')` |
| `src/ingest.js` `embedBatch` | `recordUsage('embedding_tokens')` |

Meter **inside** the existing `finalize()` so it inherits the shutdown-drain fix from 2.2.

### 3.4 Enforce quota

- **Inbound** (`vobizAnswer`, `src/telephony/vobiz.js:56`): if `checkQuota` fails,
  return `<Response><Speak>…</Speak><Hangup/></Response>` instead of `<Stream>` —
  the tenant hears a "service suspended" message rather than silence.
- **Outbound** (`src/services/campaigns/dialer.js`, `src/api/instant.js`): refuse to
  enqueue and mark the campaign `paused_quota`.
- **Concurrency**: enforce `max_concurrent_calls` using the live count already
  tracked by `telemetry.getActiveCalls()`.
- **Knowledge**: `max_documents` check from 1.5.

### 3.5 Surface it

- `GET /api/client/billing` → plan, usage, remaining, current period.
- `GET /api/admin/billing` → per-tenant usage table for your own ops.
- Frontend: usage meter in `PortalShell.tsx`, plus a warning banner at 80% and a
  blocking state at 100%.
- Nightly job reconciling `usage_events` → `tenant_subscriptions.balance_minutes`.

**Deliberately out of scope here:** payment collection (Razorpay/Stripe). Metering
and enforcement are the hard part and unlock manual invoicing immediately. Wire a
PSP once plans are proven.

**Accept:** set a tenant to 1 included minute, place a 90s call → call connects,
second call is refused with the suspension message, `usage_events` has the row.

---

## Phase 4 — Compliance (India / DPDP / TRAI)

### 4.1 Call recording consent

`CallRecorder` captures both legs and uploads WAVs (`src/telephony/vobiz.js:371-382`)
with **no disclosure anywhere** — verified absent from `src/api/templates.js` and
`src/services/greeting.js`.

- In `src/services/greeting.js:24`, prepend a consent clause when
  `tenantConfig.recording_enabled` is true:
  *"…This call is recorded for quality purposes."*
  Make the wording tenant-overridable (`recording_notice`) and language-aware — it
  must render in the caller's language, so route it through the same steer the
  greeting uses.
- Add a `recording_enabled` toggle in the agent builder, **defaulting to off** for
  new tenants.
- Store `consent_notice_played` on the `calls` row as evidence.

### 4.2 Callee opt-out — the missing half of the compliance gate

`filterContacts` / `canDial` (`src/services/campaigns/compliance.js`) read
`suppression_list` correctly, but the only writer is a tenant-facing API
(`src/api/campaigns.js:89`). **A person being called has no way to opt out.** The
agent declares only `search_knowledge` and `send_whatsapp`
(`src/services/gemini-live.js:120,131`).

- Add a third Gemini tool `add_to_dnd` → inserts into `suppression_list` for that
  tenant + caller number, then closes the call politely.
- Add the instruction to the outbound prompt in `src/api/templates.js`: *if the
  person asks not to be called again, call `add_to_dnd` and confirm.*
- Optionally accept DTMF `9` as an opt-out in `handleCampaignConnection`.

**Accept:** on an outbound test call say "don't call me again" → row appears in
`suppression_list`, and a re-run of the campaign reports that contact as `suppressed`.

### 4.3 Retention & purge

No retention logic exists (`retention|purge|anonymi` returns nothing across `src/` and `sql/`).

- Add `tenants.config.retention_days` (default 90).
- Nightly job (`src/jobs/retention.js`, runnable from `worker.js` and the inline
  runner): delete recordings from Storage past retention, null out `transcript`,
  and pseudonymise `caller_number` on `calls` and `leads`.
- Log each purge run to `service_events` so it is auditable.

### 4.4 Data-subject deletion

`scripts/delete-tenant.js` handles the *customer*. There is no path for a **caller**
(the actual data subject) to be erased.

Add `src/api/dsr.js` — admin-authenticated `POST /api/admin/dsr/erase { phone }` that
purges that number's `calls`, `leads`, recordings, and `contacts` across all tenants
and writes an audit record. This is the operational answer to a DPDP erasure request.

### 4.5 Policy surface

Privacy policy + terms pages on the marketing site, a data-processing summary you
can hand to enterprise buyers, and a documented (even if manual) DND-registry
scrubbing step before large campaigns.

---

## Phase 5 — Auth & session

### 5.1 Token refresh

`refresh_token` appears nowhere. `src/api/auth-routes.js:36` returns only
`access_token`, and `frontend/src/lib/api.ts:12-21` stores it in `localStorage`.
Every user is silently logged out ~1 hour into their work.

- Return `refresh_token` + `expires_at` from `/login` and `/google`.
- Add `POST /api/auth/refresh` calling `supabaseAuth.auth.refreshSession`.
- In `apiFetch` (`frontend/src/lib/api.ts:26`), on 401 attempt one refresh and
  replay the request before redirecting to `/login`.
- Preferred hardening: move the refresh token to an `httpOnly; Secure; SameSite=Lax`
  cookie so XSS cannot exfiltrate it; keep the short-lived access token in memory.

**Accept:** leave the dashboard idle 65 min, click around → still authenticated.

### 5.2 Password reset + real email verification

`src/api/signup.js:40` sets `email_confirm: true`, auto-confirming everyone. A
password user who forgets their password is permanently locked out.

- `POST /api/auth/forgot` → `resetPasswordForEmail`; `POST /api/auth/reset` → update.
- Frontend `/forgot-password` and `/reset-password` routes + a link on `login.tsx`.
- Flip `email_confirm` to false and send a real verification link (SMTP is already
  configured in `src/services/email.js`).

### 5.3 Route-level guards

`frontend/src/lib/use-auth.ts` is `useEffect`-based and its own comment says
*"Replace token validation with server check when wired."* API enforcement is
correct (`router.use(requireClient())` at `src/api/client.js:11`), so this is a
content-flash issue, not a hole — move the check into TanStack Router `beforeLoad`
on `app.tsx` / `admin.tsx` to fix it properly.

---

## Phase 6 — Tests & correctness

`npm test` exits 1. Zero test files exist. The highest-risk logic is entirely
unverified.

### 6.1 Harness

`npm i -D vitest supertest` → `"test": "vitest run"`.

### 6.2 Unit tests, in priority order

| Target | Why it's first |
|---|---|
| `src/services/language-manager.js` | 489 lines of hysteresis state machine — subtle and untested. Cover: first-utterance init, explicit switch bypass, 2-signal streak, oscillation resistance |
| audio conversion in `src/services/gemini-live.js` | `mulawToPcm16` / `pcm16ToMulaw` / resampling — round-trip and frame-boundary tests |
| `src/services/campaigns/compliance.js` | `withinWorkingHours` across timezones + DST, blackout dates, max attempts |
| `src/services/greeting.js` | `fill()` placeholder collapsing, inbound vs outbound |
| `src/services/billing.js` (Phase 3) | quota edge cases — bill it wrong and you lose money |

### 6.3 Integration tests

Supertest against the Express app with Supabase mocked:
- auth matrix — every route rejects anonymous, wrong-tenant, and wrong-role access
- webhook secret gate (Phase 1.1) returns 403 without `k`
- rate limiters return 429

### 6.4 One end-to-end smoke test

Drive `/test-stream` with a recorded mulaw fixture (`test_output.mulaw` already
exists) and assert the engine produces audio frames. Catches the class of break that
silently kills every call.

---

## Suggested execution order

```
Week 1   Phase 0 (day 1)  →  Phase 1  →  Phase 2
Week 2   Phase 3 (metering + enforcement)
Week 3   Phase 4  ‖  Phase 5
Week 4   Phase 6, retro-fitting tests over Phases 1–3 as you go
```

Phase 6's harness (6.1) is worth pulling forward to Week 1 so Phases 3–5 can be
written with tests rather than back-filled.

### Definition of done for "production ready"

- [ ] Fresh clone builds frontend + backend with no manual file copying
- [ ] No unauthenticated endpoint can spend money or place a call
- [ ] A deploy does not drop a live call
- [ ] A tenant cannot exceed their plan's minutes
- [ ] Every recorded call disclosed it; every caller can opt out in-call
- [ ] A crash pages someone
- [ ] CI runs tests on every PR
