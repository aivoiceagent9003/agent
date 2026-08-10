# Vocera — Voice Agent Platform — Frontend Specification

**For:** Frontend Developer
**Version:** 3 (supersedes the v2 PDF — reflects the platform as it is actually built today)
**Scope:** Frontend only. All APIs below are live and tested. You build the UI and connect to these endpoints. The backend is complete — treat every endpoint as ready to call.

> **Your scope for this round:** the **Client dashboard (`/app`)**, the **Agent builder (`/onboarding`)**, and the **Admin panel (`/admin`)** — including the new **Campaigns, Instant Calls, WhatsApp**, and **Operations Center** areas.
> **Out of scope:** the **public marketing site / landing page (`/`)**. It is owned separately and already built — it's described only briefly for context.

---

## 0. What changed since v2 (read this first)

If you built against the v2 PDF, here is everything that is different now. The rest of the doc is the full updated reference.

| Area | v2 (old) | v3 (now) |
|---|---|---|
| **Voice engine** | TTS voices ("Priya", "Sameera") | **Gemini Live speech-to-speech.** `config.voice` is a Gemini voice id: `Aoede, Kore, Leda, Charon, Orus, Puck`. All voices are multilingual (speak Hindi/Telugu/Tamil… natively). You pick a voice for **tone**, not language. |
| **Voice picker** | `gender` + label | Same shape, but show the **gender word** ("Female"/"Male") as a label — **no gender icon/symbol**. 3 female + 3 male. |
| **Agent builder route** | `/app/agent` | **`/onboarding`** (nav label: "Agent settings"). New clients land here first. |
| **Test the call** | text chat box only | **Real browser voice call** over a WebSocket (hi-fi Gemini Live) — the client talks and hears the agent. The text-chat test still exists as a fallback. |
| **Knowledge base** | paste text / .txt only | **Document-based**: upload PDF / DOCX / images (OCR) / txt, or paste. Files are listed and individually deletable. |
| **Leads** | every call became a lead | Only calls with **genuine interest** become leads (backend scores interest). Calls carry a `has_lead` flag. |
| **Calls** | single list | Calls have a **`direction`** (`inbound`/`outbound`) — show **Inbound / Outbound** as separate tabs. Call detail includes a **recording** (signed audio URL). |
| **Auth** | email/password | **Google Sign-In added.** Public signup is **Google-only**; login keeps **Google + password**. |
| **New client areas** | — | **Campaigns** (outbound calling), **Instant Calls** (CRM→instant call), **WhatsApp** (send brochures/confirmations), **Live-data lookups** (per-caller data at call time). |
| **New admin area** | — | **Operations Center** — 15 observability sections + a live `/ops-stream` WebSocket. |
| **Telephony** | Twilio | **Vobiz** (backend concern; nothing changes for you except that phone numbers must be full E.164, e.g. `+918071583556`). |

---

## 1. What you're building

A web app with **three separate portals**:

| Portal | Who | Route | Login? | Your scope |
|---|---|---|---|---|
| Public site | Anyone | `/` | No | **Out of scope** (already built) |
| Client dashboard | Paying business clients | `/app` | Yes | **Yes** |
| Agent builder | New + returning clients | `/onboarding` | Yes | **Yes** |
| Admin panel | Platform owner (us) | `/admin` | Yes | **Yes** |

**Product in one line:** businesses get an AI voice agent that answers their phone calls in English/Hindi/Hinglish (and other Indic languages), answers from their own knowledge base, captures qualified leads, hands off to a human when needed, runs outbound calling campaigns, and can send WhatsApp brochures/confirmations. You build the web interface around that.

---

## 2. Tech stack

- **React** + **TanStack Router** (the app already uses this; file-based routes in `frontend/src/routes`)
- **Tailwind CSS**
- **Recharts** for charts
- **fetch** for API calls (a thin `lib/api` wrapper handles the token + 401)
- **Supabase JS SDK** for auth (see Section 4)
- **Web Audio API** (`AudioContext` + `AudioWorklet`) for the browser voice test call — the plumbing already exists in `frontend/src/lib/webcall.ts` + `useVoiceCall.ts`; reuse it.

---

## 3. Talking to the backend

- Dev base URL: `http://localhost:3000` (the Vite dev server runs the UI on `:8080` and calls the API).
- All responses: JSON.
- Authenticated requests: `Authorization: Bearer <token>` header.
- Errors: `{ "error": "message" }` with HTTP `400 / 401 / 403 / 404 / 500`.
- Handle `401` by clearing the token and redirecting to the correct login page.
- Phone numbers are **E.164** (`+918071583556`). A national `08071583556` will fail at the carrier — validate on input.

---

## 4. Authentication

Use the **Supabase JS SDK** for login — it handles tokens. Two auth methods:

**Password login** (client + admin login pages):
```js
POST /api/auth/login   { email, password }
  -> { token, role, tenant_id }
```

**Google Sign-In** (public signup + the login page):
```js
POST /api/auth/google  { credential }   // credential = Google ID token from Google Identity Services
  -> { token, role, tenant_id, is_new }
```
- `is_new: true` → this is the user's first login; **route them to `/onboarding`** (agent builder) to set up their business.
- `is_new: false` → existing user; route by `role`.
- A `<GoogleSignInButton />` component already exists — reuse it.

**Routing after auth:** `role === "admin"` → `/admin`; otherwise → `/app` (or `/onboarding` if `is_new`).

**Token handling:** store the token, attach as `Authorization: Bearer <token>` on every API call, on `401` clear it and redirect to login. The token encodes who the user is — you never pass user/tenant IDs in API calls.

**Two login pages:**
- `/login` → clients (Google + password)
- `/admin-login` → admin (password)

**Signup** — public, **Google-only** (`/signup`). There is also a legacy email/password signup endpoint if you ever need it:
```js
POST /api/signup   { email, password, business_name } -> { success, tenant_id, message }
```
Admin accounts are created manually (no public admin signup).

---

## 5. PUBLIC SITE (`/`) — OUT OF SCOPE

Already built by another owner. For context only: it's the marketing site (hero, features, pricing, contact form) plus a **live voice demo** — visitors actually **talk to a real AI agent in the browser** ("Talk to Priya" + per-industry demos). The old scripted/animated chat demo is gone. You don't build or change this. The two public endpoints it uses (`POST /api/public/contact`, `GET /api/public/demo/sectors`) are listed in Section 13 for completeness.

---

## 6. CLIENT DASHBOARD (`/app`) — login required

Sidebar nav (already defined in `PortalShell.tsx` → `clientNav`):

`Overview · Calls · Campaigns · Instant Calls · Leads · Knowledge · WhatsApp · Agent settings`

**First-login flow:** a brand-new client lands in the **Agent builder** (`/onboarding`) first (Section 7). Once they publish, they use the dashboard. Show a "Set up your agent" banner anywhere `config.status !== 'published'`.

### Page: Overview (`/app`)
```
GET /api/client/overview
 -> { total_calls, total_minutes, total_leads, handoff_count,
      avg_call_duration_seconds,
      calls_last_7_days: [ { date, count } ] }
```
Cards: **Total Minutes** (hero card — biggest), Total Calls, Total Leads, Handoffs, Avg Duration. Chart: calls over last 7 days.

### Page: Calls (`/app/calls`)
```
GET /api/client/calls?page=1&limit=20&direction=inbound|outbound
 -> { calls: [ { id, caller_number, status, duration_seconds, created_at,
                 direction, campaign_id, has_lead } ],
      total, page, limit }
```
- **Two tabs: Inbound / Outbound** (pass `direction`). Legacy rows with no direction count as inbound.
- Paginated table. Columns: caller number, date/time, duration, status, **lead badge** (`has_lead`). Outbound rows may show a `campaign_id`. Click row → call detail.

### Page: Call detail (`/app/calls/:id`)
```
GET /api/client/calls/:id
 -> { id, caller_number, status, duration_seconds, created_at,
      transcript, recording_url, lead }
```
- Transcript as chat bubbles (**Caller left, Agent right**).
- **Audio player** for `recording_url` (short-lived signed URL; may be `null` if no recording).
- Show the extracted `lead` below if present (shape in Section 14).

### Page: Leads (`/app/leads`)
```
GET /api/client/leads?page=1&limit=20&intent=&sentiment=&follow_up=
 -> { leads: [ { id, name, intent, summary, sentiment, language,
                 key_details (string[]), follow_up_needed (bool),
                 handed_off (bool), contact_info, caller_number,
                 created_at, transcript } ],
      total, page, limit }
```
- Filterable by `intent`, `sentiment`, `follow_up` (`true`).
- Sentiment color-coded: positive=green, neutral=grey, frustrated=orange, angry=red.
- Each lead already carries its call `transcript` (no extra fetch).
- Export button:
```
GET /api/client/leads/export   -> CSV download
```

---

## 7. AGENT BUILDER (`/onboarding`) — login required

Where clients set up their AI agent. **New clients land here first.** Flow:

```
Choose path
 ├─ Pre-Built   → pick a sector template → config pre-filled → edit → test → publish
 └─ Custom
     ├─ "Our Recommendations" → Auto Build form → generate prompt → edit → test → publish
     └─ "From Scratch"        → blank form → fill everything → test → publish
```

### Step 0 — Load current agent (pre-fill returning clients)
```
GET /api/client/agent
 -> { id, name, phone_number, config }
```
`config.status` is `"draft"` or `"published"`. Show a "Draft — not live yet" badge when draft.

### Step 1A — Pre-Built: template picker
```
GET /api/client/agent/templates
 -> [ { id, label, description, icon, suggested_kb_topics } ]
```
Show as cards. On click, load the full template and pre-fill the config form:
```
GET /api/client/agent/templates/:id
 -> { id, label, description, icon, suggested_kb_topics, config }
```
Template ids: `real_estate_sales, lead_qualification, customer_support, front_desk, reminder_collections, order_confirmation`.

### Step 1B — Custom "Our Recommendations" (Auto Build)
Form fields: `agent_name` (req), `languages` (checkboxes: English, Hindi — req), `goal` (req), `next_steps` (req), `faqs` (opt), `sample_transcript` (opt).
```
POST /api/client/agent/generate-prompt
 body: { agent_name, languages, goal, next_steps, faqs, sample_transcript }
 -> { system_prompt, config }
```
Show `system_prompt` in an **editable textarea** ("you can always modify & edit it later"). Sector KB hints:
```
GET /api/client/agent/recommendations?sector=real_estate
 -> { suggested_kb_topics: [...], tip: "..." }
```

### Step 2 — Edit config (all paths converge)

| Field | UI control | Saved as |
|---|---|---|
| Agent name | text input | `config.agent_name` |
| Prompt / Role | editable textarea | `config.system_prompt` |
| Voice | picker (see below) | `config.voice` |
| Mobile number to automate | phone input (E.164) | `phone_number` (top-level) |
| Handoff number | phone input (E.164) | `config.handoff_number` |
| Enable handoff | toggle | `config.enable_handoff` |
| Enable knowledge base | toggle | `config.enable_kb` |
| Filler phrases | add/remove list | `config.filler_phrases` |

**Voice picker** — fetch and show as cards/radios:
```
GET /api/client/agent/voices
 -> [ { id, label, gender, note } ]
// e.g. { id:"Aoede", label:"Aoede", gender:"female", note:"Breezy, warm (default)" }
```
- 3 female + 3 male Gemini Live voices. **Show the gender as a word label ("Female"/"Male") — NO gender icon/symbol.** Show `note` as the tone hint. All voices speak every language; there is no per-language voice.

**Save draft** (auto-save on blur or explicit Save):
```
PATCH /api/client/agent
 body: { config, phone_number? }
 -> { id, phone_number, config }
```
> Note: `PATCH` merges into the existing config and forces `status:"draft"`. If `config.business_name` is set, it also syncs the tenant's display name.

### Step 3 — Knowledge base (document-based)
Upload files (PDF, DOCX, images w/ OCR, txt) **or** paste text. Files are listed and individually deletable. Show `suggested_kb_topics` from the template/recommendations as hints.
```
GET    /api/client/agent/documents            -> [ { id, filename, source, chunk_count, size_bytes, created_at } ]
POST   /api/client/agent/knowledge            body: { text, source? }        -> { chunks_added, document_id }   // paste
POST   /api/client/agent/knowledge/upload     multipart: file=<pdf|docx|img|txt>  -> { document_id, filename, chunks_added, chars }
GET    /api/client/agent/documents/:id/url    -> { url }        // signed view/download link
DELETE /api/client/agent/documents/:id        -> { success }    // removes doc + its chunks + stored file
DELETE /api/client/agent/knowledge            -> { success }    // "Clear all"
```
UI: file input + paste textarea. After add, show `chunks_added`. List documents with a per-row view link + delete, plus a "Clear all".
(Chunk-level `GET/DELETE /api/client/agent/knowledge[/:chunkId]` also exist for inspection — optional.)

### Step 3.5 — Live data lookups (optional, advanced)
Per-caller data the agent fetches **at call time** (order status, dues, booking). A lookup is backed by the client's own REST API (`http`) or a data sheet they upload here (`table`).
```
GET   /api/client/agent/lookups
 -> { enable_lookups, lookups: [...], datasets: [ { name, row_count, columns } ] }
PATCH /api/client/agent/lookups
 body: { lookups: [...], enable_lookups? }   -> { lookups, enable_lookups }
POST  /api/client/agent/lookups/dataset      multipart: file=<csv> OR body { dataset, csv }  -> { dataset, rows_added, columns }
DELETE /api/client/agent/lookups/dataset/:dataset -> { success }
```
Show as an "add data source" list: each lookup has a name + type (`http`/`table`) + config. For `table`, let them upload a CSV that becomes a named dataset. (A `LiveDataSetup.tsx` component already exists — extend it.)

### Step 4 — Test the call (browser — no phone)

**This is the most impressive part of the builder — make it feel like a real phone call.** The client **talks** and **hears** the agent, running the exact same Gemini Live engine + knowledge base as a real call.

**Real voice test (primary)** — over a WebSocket:
```
WS  ws://<host>/test-stream
→ send  { event:"start", start:{ token:<bearer>, config?:<draft config>, streamSid? } }
→ send  { event:"media", media:{ payload:<base64 PCM audio> } }   // mic audio, continuously
← recv  audio frames (agent speech) + { event:"started" } / { event:"clear" } (barge-in) / { event:"error" }
→ send  { event:"stop" }
```
- Pass the **draft `config`** to test unsaved changes; omit to test the saved config.
- The wiring (mic capture → PCM, `AudioWorklet` playback, barge-in) already exists in `webcall.ts` + `useVoiceCall.ts` + `VoiceTester.tsx`. **Reuse the `VoiceTester` component** — it's a phone-style UI with a talk button and live status.

**Text-chat test (fallback)** — same AI + KB pipeline, typed:
```
POST /api/client/agent/test        body: { message, session_id, config? }  -> { reply, used_knowledge }
POST /api/client/agent/test/reset  body: { session_id }                    -> { success }
```
Show a small badge when `used_knowledge: true` (proves the KB is working). "Reset conversation" clears memory.

### Step 5 — Publish
```
POST /api/client/agent/publish   -> { success, status:"published" }
```
After publish: success state ("Your agent is live! Calls to your number will now be handled by your AI agent.") and flip the badge Draft → Live.

---

## 8. CAMPAIGNS (`/app/campaigns`) — login required (NEW)

Outbound calling. A campaign dials a list of contacts with either an **AI agent** (`type: "ai_sales"` — full Gemini conversation) or a **fixed spoken message** (`type: "template"`). Contacts come from: a **file upload**, a **paste**, a **Google Sheet**, a **database query**, or a **real-time webhook** (CRM / Meta & Google Lead Ads).

> Campaigns require Redis on the backend. If it's off, `start` returns `503` — surface that gracefully.

### List + create (`/app/campaigns`)
```
GET  /api/client/campaigns
 -> { campaigns: [ { id, name, type, status, direction, from_number,
                     schedule, retry_policy, compliance, config, created_at,
                     contacts: { total, completed } } ] }
POST /api/client/campaigns
 body: { name, type?, config?, schedule?, retry_policy?, compliance?, from_number? }
 -> <campaign>
```
`status`: `draft → scheduled → running → paused → completed`. Show status pills + a progress bar from `contacts.completed / contacts.total`.

### Campaign detail (`/app/campaigns/:id`)
```
GET    /api/client/campaigns/:id                 -> <campaign>
PATCH  /api/client/campaigns/:id                 body: { name?, type?, config?, schedule?, retry_policy?, compliance?, from_number?, status? }
DELETE /api/client/campaigns/:id                 -> { ok }
POST   /api/client/campaigns/:id/duplicate       -> <new campaign>
```

**Lifecycle buttons:**
```
POST /api/client/campaigns/:id/start        body: { start_at? }   -> { ok, queued|scheduled, delayMs? }
POST /api/client/campaigns/:id/unschedule   -> { ok }   // cancel a pending scheduled start
POST /api/client/campaigns/:id/pause        -> { ok }
POST /api/client/campaigns/:id/resume       -> { ok }
POST /api/client/campaigns/:id/stop         -> { ok }
```

**Contacts:**
```
GET  /api/client/campaigns/:id/contacts?page=1&limit=50  -> { contacts, total, page, limit }
POST /api/client/campaigns/:id/contacts        body: { contacts:[{name?,phone,...}] }  -> { inserted, invalidCount, duplicateCount }
POST /api/client/campaigns/:id/contacts/paste  body: { text }                          -> { inserted, invalidCount, duplicateCount }
POST /api/client/campaigns/:id/contacts/import multipart: file=<csv|xlsx|txt|pdf|docx> -> { inserted, invalidCount, duplicateCount, parsed }
```

**Data sources** (Google Sheet / Database — pulled by the worker):
```
GET    /api/client/campaigns/:id/sources                    -> { sources: [ { id, kind, name, status, row_count, ... } ] }
POST   /api/client/campaigns/:id/sources                    body: { kind:"google_sheet"|"database", name?, config }
        // google_sheet: config.url required · database: config.query required · optional config.poll_seconds (>=30 keeps it fresh)
POST   /api/client/campaigns/:id/sources/:sourceId/sync     -> { ok }   // pull now
DELETE /api/client/campaigns/:id/sources/:sourceId          -> { ok }
```

**Real-time trigger** (webhook ingress URL + token for CRMs / lead ads):
```
GET  /api/client/campaigns/:id/trigger        -> { url, token, header:"X-Campaign-Token", presets:[...], active_preset }
POST /api/client/campaigns/:id/trigger/rotate -> { token }
PUT  /api/client/campaigns/:id/trigger/preset body: { preset }   -> { ok }
```
Show the URL + token as copy-to-clipboard with a rotate button and a preset dropdown (the CRM/lead-ad source they'll post from).

**Schedule / retry config:**
```
PUT /api/client/campaigns/:id/schedule  body: { mode:"once"|"recurring", start_at?, cron?, every_ms? }  -> { ok }
PUT /api/client/campaigns/:id/retry     body: { ... }   -> { ok }
```

**Analytics / runs / logs (campaign detail tabs):**
```
GET /api/client/campaigns/:id/analytics  -> { metrics }
GET /api/client/campaigns/:id/runs       -> { runs: [...] }
GET /api/client/campaigns/:id/logs       -> { logs: [...] }   // last 200
```

### Monitor (`/app/campaigns/monitor`)
```
GET /api/client/campaigns/monitor
 -> { redis, running: [ { id, name, status, type } ], queues, liveCalls: [...] }
GET /api/client/campaigns/dialer   -> dialer info (concurrency / provider)
```
Live view: queue depths, running campaigns, live outbound calls.

**Suppression list (compliance):**
```
GET  /api/client/campaigns/suppression   -> { entries: [ { phone, reason, created_at } ] }
POST /api/client/campaigns/suppression   body: { phone, reason? }   -> { ok }
```

**Campaign templates (reusable presets):**
```
GET  /api/client/campaigns/templates     -> { templates: [...] }
POST /api/client/campaigns/templates     body: { name, type?, config? }
```

**New campaign wizard** lives at `/app/campaigns/new`.

---

## 9. INSTANT CALLS (`/app/instant`) — login required (NEW)

A standalone "CRM entry → immediate AI call" webhook (not a campaign). The moment a new lead lands in the client's CRM, they POST it to their ingress URL and we dial within seconds.
```
GET  /api/client/instant-call
 -> { enabled, url, token, header:"X-Instant-Token", presets:[...], active_preset,
      from_number, skip_recent_days, skip_statuses:[...] }
PUT  /api/client/instant-call
 body: { enabled?, preset?, from_number?, skip_recent_days?, skip_statuses? }  -> <same shape>
POST /api/client/instant-call/rotate   -> <same shape, new token>
```
UI: an on/off toggle, the ingress **URL + token** (copy + rotate), a **preset** dropdown (CRM/lead-ad source), a **caller-ID** (`from_number`, E.164) input, and de-dup guards: **skip_recent_days** (don't re-call within N days) + **skip_statuses** (lead statuses that mean "already worked" — a tag/multiselect).

---

## 10. WHATSAPP (`/app/whatsapp`) — login required (NEW)

The agent can send a **brochure** or a **booking confirmation** over WhatsApp during/after a call. Messages send from the **platform's** shared WhatsApp number — the client sets **no API credentials**, only what shows in the message (their contact number) and which files to send.
```
GET /api/client/whatsapp
 -> { platform_enabled, enabled, display_phone,
      own_number, provider, phone_number, phone_number_id, token_set,
      templates:{ document, confirmation } }
PUT /api/client/whatsapp
 body: { enabled?, display_phone?,  /* advanced BYO-number: provider?, phone_number?, phone_number_id?, token?, templates? */ }
 -> <same shape>
```
- `platform_enabled` tells you the shared sender is live (show a "ready" state). If `false`, show "WhatsApp not yet configured by Vocera".
- Main UI: an enable toggle + the **contact number to display**. Put BYO-number fields (provider, phone number id, token, template names) behind an "Advanced" disclosure. **Never** display the token back (`token_set` just tells you one is saved).

**Sendable documents** (brochures/menus — their own store, separate from the knowledge base):
```
GET    /api/client/whatsapp/documents         -> [ { id, topic, filename, mime_type, size_bytes, created_at } ]
POST   /api/client/whatsapp/documents         multipart: file=<pdf|img>, topic=<what callers ask for>  -> <doc>
PUT    /api/client/whatsapp/documents/:id     body: { topic }   -> <doc>
DELETE /api/client/whatsapp/documents/:id     -> { success }
```
UI: upload a file + a `topic` label (e.g. "3BHK brochure", "menu"), list them, edit topic, delete.

---

## 11. ADMIN PANEL (`/admin`) — login required

Internal tool for the platform owner. Sidebar (`adminNav`):
`Dashboard · Clients · Operations · Live Calls · Latency · Services · Errors · Alerts · AI Quality · Business · Settings`

### Page: Dashboard (`/admin`)
```
GET /api/admin/overview
 -> { total_tenants, total_calls, total_minutes, total_leads,
      calls_last_7_days: [ { date, count } ],
      recent_calls: [ { id, tenant_name, caller_number, duration_seconds, created_at } ] }
```
Platform-wide stat cards + chart + recent-calls table.

### Page: Clients list (`/admin/clients`)
```
GET /api/admin/tenants
 -> [ { id, name, phone_number, config, created_at,
        stats: { total_calls, total_minutes, total_leads } } ]
```
Table with name, number, call count, minutes, leads. "Add Client" button (`/admin/clients/new`).

### Page: Add / Edit client (`/admin/clients/:id`, `/admin/clients/new`)
```
GET    /api/admin/tenants/:id     -> <tenant>
POST   /api/admin/tenants         body: { name, phone_number, config }   -> <tenant>
PATCH  /api/admin/tenants/:id     body: { name?, phone_number?, config? }
DELETE /api/admin/tenants/:id     -> { success }
```
Same config fields as the client agent builder (Section 7 Step 2), but admin can edit any client.

**Knowledge base (within the edit page):**
```
GET    /api/admin/tenants/:id/knowledge            -> [ { id, content, source, created_at } ]
POST   /api/admin/tenants/:id/knowledge            body: { text, source?, replace? }  -> { chunks_added }
DELETE /api/admin/tenants/:id/knowledge/:chunkId   -> { success }
DELETE /api/admin/tenants/:id/knowledge            -> { success }   // clear all
```

---

## 12. OPERATIONS CENTER (`/admin/ops/*`) — admin only (NEW)

A real-time observability console for the voice platform. **15 sections.** Every REST endpoint below is the initial snapshot / polling fallback; live deltas stream over a WebSocket.

**Live feed WebSocket:**
```
WS ws://<host>/ops-stream?token=<admin bearer token>
← { type:"snapshot", snapshot, calls }   // on connect + every 5s heartbeat
← { type:"event", event, payload }        // live deltas
← { type:"error", error:"unauthorized" }  // then closes
```
(The browser can't set headers on a WS handshake, so pass the admin token as `?token=`.)

**REST endpoints** (all under `/api/admin/ops`, all `requireAdmin`):

| Section | Route | Returns (shape summary) |
|---|---|---|
| 1. Executive overview | `GET /overview` | snapshot + `series` (live time-series) |
| — time-series only | `GET /series?limit=180` | array of samples |
| 2. Live calls | `GET /calls/live` | `{ calls: [...] }` |
| — recent calls | `GET /calls/recent?limit=100` | `{ calls: [...] }` |
| 3. Distributed trace | `GET /calls/:callSid/trace` | full per-call trace (`404` if aged out) |
| 4. Latency | `GET /latency?op=` | latency stats (p50/p95/p99 per op) |
| — history | `GET /metrics/history?metric=&op=&sinceMs=` | `{ rows }` |
| — service events | `GET /events?limit=200` | `{ events: [...] }` |
| 5. Language analytics | `GET /language` | detection sources, per-language counts, confidence |
| 6. Gemini | `GET /gemini` | sessions, reconnects, errors, close codes, first-audio/turn latency |
| 7. Telephony | `GET /telephony` | incoming/answered/rejected, active WS, webhook latency |
| 8. Knowledge / RAG | `GET /rag` | cache hit rate, no-match rate, retrieval latency, similarity |
| 9. Tools | `GET /tools` | per-tool ok/error + lookup hit/miss/timeout |
| 10. Infrastructure | `GET /infra` | cpu, memory, heap, event-loop delay, uptime + `series` |
| 11. Errors | `GET /errors` | `{ byComponent, recent }` |
| 12. Downtime | `GET /downtime` | `{ incidents: [...] }` |
| 13. Business analytics | `GET /business` | `{ tenants:[{calls,minutes,leads,cost,revenue,profit,...}], totals }` |
| 14. AI quality | `GET /quality` | `qualityScore` (0-100) + failure-rate breakdown |
| 15. Alerts | `GET /alerts` | `{ active, history, rules }` |

**Actions:**
```
POST /api/admin/ops/calls/:callSid/terminate  -> { ok }        // end a live call
POST /api/admin/ops/calls/:callSid/{listen|replay|transfer}  -> 501 (later phase — show as "coming soon")
```

**Existing routes for these** (already scaffolded): `/admin/ops` (overview), `/admin/ops/live`, `/admin/ops/latency`, `/admin/ops/services`, `/admin/ops/errors`, `/admin/ops/alerts`, `/admin/ops/quality`, `/admin/ops/business`, `/admin/ops/trace/:callSid`. Build each section against its endpoint above; some (`/quality` `needsLlmJudge`, `/gemini` `tokenUsageAvailable:false`, the `501` actions) tell you honestly which metrics aren't wired yet — render them as "not available yet", don't fake them.

---

## 13. Complete endpoint reference

```
PUBLIC (no auth)
  POST  /api/public/contact                 { name, email, company?, message? }
  GET   /api/public/demo/sectors            (marketing live-demo sectors)
  POST  /api/signup                         { email, password, business_name }   (legacy; signup is Google-only)

AUTH
  POST  /api/auth/login                     { email, password } -> { token, role, tenant_id }
  POST  /api/auth/google                    { credential } -> { token, role, tenant_id, is_new }

CLIENT — Dashboard (Bearer)
  GET   /api/client/overview
  GET   /api/client/calls?page=&limit=&direction=
  GET   /api/client/calls/:id
  GET   /api/client/leads?page=&limit=&intent=&sentiment=&follow_up=
  GET   /api/client/leads/export            (CSV)

CLIENT — Agent Builder (Bearer)
  GET   /api/client/agent
  PATCH /api/client/agent                   { config, phone_number? }
  POST  /api/client/agent/publish
  GET   /api/client/agent/templates
  GET   /api/client/agent/templates/:id
  GET   /api/client/agent/voices
  GET   /api/client/agent/recommendations?sector=
  POST  /api/client/agent/generate-prompt
  POST  /api/client/agent/test
  POST  /api/client/agent/test/reset
  GET   /api/client/agent/documents
  GET   /api/client/agent/documents/:id/url
  DELETE/api/client/agent/documents/:id
  POST  /api/client/agent/knowledge         { text, source? }
  POST  /api/client/agent/knowledge/upload  (multipart file)
  GET   /api/client/agent/knowledge
  DELETE/api/client/agent/knowledge/:chunkId
  DELETE/api/client/agent/knowledge         (clear all)
  GET   /api/client/agent/lookups
  PATCH /api/client/agent/lookups
  POST  /api/client/agent/lookups/dataset   (multipart csv OR { dataset, csv })
  DELETE/api/client/agent/lookups/dataset/:dataset

CLIENT — Campaigns (Bearer)
  GET/POST                 /api/client/campaigns
  GET                      /api/client/campaigns/monitor
  GET                      /api/client/campaigns/dialer
  GET/POST                 /api/client/campaigns/suppression
  GET/POST                 /api/client/campaigns/templates
  GET/PATCH/DELETE         /api/client/campaigns/:id
  POST                     /api/client/campaigns/:id/start|unschedule|pause|resume|stop|duplicate
  GET/POST                 /api/client/campaigns/:id/contacts
  POST                     /api/client/campaigns/:id/contacts/paste
  POST                     /api/client/campaigns/:id/contacts/import   (multipart)
  PUT                      /api/client/campaigns/:id/schedule|retry
  GET/POST                 /api/client/campaigns/:id/sources
  POST                     /api/client/campaigns/:id/sources/:sourceId/sync
  DELETE                   /api/client/campaigns/:id/sources/:sourceId
  GET                      /api/client/campaigns/:id/trigger
  POST                     /api/client/campaigns/:id/trigger/rotate
  PUT                      /api/client/campaigns/:id/trigger/preset
  GET                      /api/client/campaigns/:id/analytics|runs|logs

CLIENT — Instant Calls (Bearer)
  GET/PUT                  /api/client/instant-call
  POST                     /api/client/instant-call/rotate

CLIENT — WhatsApp (Bearer)
  GET/PUT                  /api/client/whatsapp
  GET/POST                 /api/client/whatsapp/documents
  PUT/DELETE               /api/client/whatsapp/documents/:id

ADMIN (Bearer, admin role)
  GET   /api/admin/overview
  GET   /api/admin/tenants
  GET/POST/PATCH/DELETE    /api/admin/tenants[/:id]
  GET/POST/DELETE          /api/admin/tenants/:id/knowledge[/:chunkId]
  GET   /api/admin/ops/*                    (15 sections — see Section 12)
  POST  /api/admin/ops/calls/:callSid/terminate

WEBSOCKETS
  ws /test-stream          (client browser voice test — Bearer token in start payload)
  ws /ops-stream?token=    (admin ops live feed)
```

---

## 14. Data shapes (quick reference)

**Tenant config** (lives inside `tenant.config`):
```json
{
  "agent_name": "Priya",
  "system_prompt": "You are a real estate sales agent...",
  "voice": "Aoede",
  "handoff_number": "+91XXXXXXXXXX",
  "enable_handoff": true,
  "enable_kb": true,
  "enable_lookups": true,
  "lookups": [],
  "filler_phrases": ["Let me check that for you.", "One moment, please."],
  "business_name": "My Home Constructions",
  "whatsapp": { "enabled": true, "display_phone": "+91..." },
  "instant_call": { "enabled": true, "token": "...", "preset": "generic" },
  "status": "draft | published"
}
```

**Tenant:**
```json
{ "id": "uuid", "name": "My Home Constructions", "phone_number": "+91...",
  "config": { ...see above }, "created_at": "ISO" }
```

**Call:**
```json
{ "id": "uuid", "caller_number": "+91...", "status": "completed",
  "duration_seconds": 87, "direction": "inbound|outbound", "campaign_id": null,
  "transcript": "Caller: ...\nAgent: ...", "recording_url": "https://... (signed, nullable)",
  "created_at": "ISO", "has_lead": true }
```

**Lead:**
```json
{ "id": "uuid", "name": "Madhusudan", "intent": "product_inquiry",
  "summary": "Caller is looking for a 3BHK in Kokapet.",
  "sentiment": "positive | neutral | frustrated | angry",
  "language": "en | hi | te",
  "key_details": ["Looking for 3BHK", "Budget 2.8 crore"],
  "follow_up_needed": true, "handed_off": false,
  "contact_info": "+91...", "caller_number": "+91...", "created_at": "ISO" }
```

**Voice:**
```json
{ "id": "Aoede", "label": "Aoede", "gender": "female", "note": "Breezy, warm (default)" }
```

**Template:**
```json
{ "id": "real_estate_sales", "label": "Real Estate Sales Agent",
  "description": "Answers property queries, shares pricing, books site visits.",
  "icon": "building",
  "suggested_kb_topics": ["List of projects", "Pricing", "Amenities", "Booking process"],
  "config": { ...ready-made config with system_prompt } }
```

**Campaign:**
```json
{ "id": "uuid", "name": "Diwali Offer", "type": "ai_sales | template",
  "status": "draft|scheduled|running|paused|completed", "direction": "outbound",
  "from_number": "+91...", "config": {}, "schedule": {}, "retry_policy": {},
  "compliance": {}, "created_at": "ISO",
  "contacts": { "total": 500, "completed": 210 } }
```

---

## 15. Build order

1. **Auth + shell** — Google + password login, token handling, protected routes, the two sidebars.
2. **Agent builder (`/onboarding`)** — the client's first experience after signup. **Highest priority.** Nail the voice test call (Step 4).
3. **Client dashboard** — Overview → Calls (inbound/outbound) → Call detail → Leads.
4. **Campaigns** → **Instant Calls** → **WhatsApp**.
5. **Admin panel** — CRUD + knowledge.
6. **Operations Center** — snapshot pages first, then wire the `/ops-stream` live feed.

---

## 16. UX notes

- New client after signup → land on the **agent builder** (`/onboarding`), not the dashboard.
- Show the `config.status` ("Draft" / "Live") badge on the builder at all times.
- The **voice test call** (Section 7 Step 4) is the showpiece — phone-style UI, talk button, live "listening/speaking" state, barge-in works.
- `total_minutes` is the headline metric on the client dashboard — biggest card.
- Voice picker: gender as a **word**, no icon. Show `note` as the tone hint.
- Calls: **Inbound / Outbound tabs**. Sentiment on leads: green/grey/orange/red. Transcript bubbles: Caller left, Agent right, plus an audio player on call detail.
- Phone inputs: enforce **E.164** (`+91…`).
- Copy-to-clipboard + rotate for every webhook URL/token (Campaigns trigger, Instant Calls).
- Ops Center: render "not available yet" honestly for endpoints that say so (`needsLlmJudge`, `tokenUsageAvailable:false`, `501` actions).

---

## 17. What you own / don't

**You build:** all UI for the client dashboard, agent builder, and admin panel; Supabase auth (Google + password, token handling, protected routes); calling every endpoint above and rendering it; the agent builder wizard incl. the **browser voice test call**; charts, pagination, filters, CSV download; Campaigns / Instant Calls / WhatsApp UIs; the Operations Center (15 sections + live WS feed); loading / error / empty states.

**You do NOT build:** the public marketing site / landing page; APIs, database, AI pipeline, phone system, auth backend.

> Every endpoint listed here is live and tested. If a screen needs data not listed, flag it — the backend will be extended to match.
