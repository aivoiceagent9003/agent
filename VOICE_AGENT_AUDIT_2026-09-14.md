# Voice agent review and Meta lead-ad test plan

Reviewed September 14, 2026 against the local working tree, including existing uncommitted work.

## Result

The intended journey is feasible: someone submits an Instagram/Facebook instant form, the connected integration delivers the lead, and the voice agent calls the supplied number. This applies to forms belonging to a business that has connected its Page and granted access; it does not apply to arbitrary ads encountered in an Instagram feed.

**Native Meta integration is not implemented in this repository.** The Meta preset parses an already retrieved lead (`field_data`) or flattened connector fields (`phone`, `name`). A native `leadgen_id` notification is rejected with HTTP 400 because the application does not retrieve the phone from Meta. The current UI explicitly describes using a connector or CRM instead.

The user confirmed there is no existing Meta Page/form-to-CRM/connector setup. Therefore no live Meta submission or real test call was made, and the 5–10 second target remains unmeasured.

## Scope and verification

Inventoried 319 project files, including 284 JavaScript/TypeScript/SQL files, excluding dependencies, Git internals and generated build directories. Reviewed the architecture and implementation of HTTP/WebSocket entry points, instant ingress, campaigns/queues, call lifecycle, auth/roles, knowledge/lookups, frontend flows, SQL, retention, tests and CI. This is a repository and critical-path review, not a claim that every UI component received a line-by-line security audit. Live database migrations, deployed version, Meta permissions and provider configuration were not verified.

Added `tests/instant-audit.test.js`: **20 tests**, with Supabase, Redis and telephony boundaries mocked. Thirteen exercise supported cases; seven reproduce existing gaps. The latter deliberately characterize defects and are labelled accordingly: their passing status does not mean those defects are fixed.

- Backend: **539 tests passed, 2 skipped, 18 test files passed**. Live voice smoke checks were not enabled.
- Imports: **80 backend modules loaded, zero failures**.
- Frontend TypeScript: passed.
- Frontend production build: passed (client and server bundles). The first attempt hit a sandbox filesystem denial; the approved retry completed. This verifies compilation, not deployment or browser behavior.
- The local `npm` launcher points to a missing `npm-cli.js`; invoked installed Vitest, TypeScript and the import script directly through Node instead.
- Production code, account configuration and existing user edits were not intentionally changed. Only the audit test and this report were added.

## Important confirmed defects

| Priority | Finding and evidence | Effect and next action |
|---|---|---|
| P1 | Instant answer URL omits webhook authentication: `src/api/events.js:162`; `/answer-campaign` is protected in `src/index.js`. The campaign worker already uses `webhookQuery()` in `src/services/campaigns/execute.js:96`. | A dial request may be accepted but answering cannot reach the agent through the generated URL. The audit test sends that URL through the real gate and gets a rejection. Add the existing authentication suffix and test the answered-call flow. Prior successful CRM testing may have used a different deployment/version; this finding concerns the current folder. |
| P1 | No native Meta lead retrieval: `src/services/campaigns/sources.js:216`, `src/api/events.js:209`. | A `leadgen_id` event has no usable phone. Either connect Meta to the already tested CRM path, or implement a dedicated native integration with Page/form mapping, lead retrieval and credential lifecycle. |
| P1 | No event-ID idempotency on instant ingress: `src/api/events.js:129`. | Replaying the same lead ID places two calls with the default recent-call filter off; reproduced. The optional days filter is a non-atomic read-before-insert and is not an event deduplication guarantee. Persist a unique tenant/source/lead event and claim it atomically before dialing. |
| P1 | Database errors do not stop dialing: `src/api/events.js:146`, `src/services/campaigns/compliance.js:60`. | A failed call-row insert still yields `called:true, call_id:null`; a failed suppression lookup still allows dialing. Both reproduced. Handle database errors explicitly before spending money or assuming a number is callable. |
| P1 | No durable instant delivery/retry workflow; SOAP acknowledges provider failure: `src/api/events.js:193`, `src/api/events.js:204`. | Failed Salesforce calls receive `<Ack>true</Ack>` without an internal durable retry. JSON returns 502, but a timeout/retry can also duplicate a call already accepted by the provider. Persist receipt and processing state, then use a bounded retry worker with idempotency and failure visibility. |
| P1 | Shutdown closes live calls and does not await finalization work: `src/api/lifecycle.js:94`, `src/api/lifecycle.js:102`; `src/telephony/campaign.js:224`. | Closing all sockets interrupts conversations. Zero open sockets does not mean asynchronous recording/transcript/lead writes finished; `process.exit()` can cut them off. Drain existing calls and track/await finalizer promises before exiting. Static finding, not a destructive runtime test. |
| P1 | Retention clears storage references even if deleting recordings fails: `src/jobs/retention.js:51`, `src/jobs/retention.js:59`. | A failed deletion can leave an orphaned recording with no DB pointer for retry. Preserve failed paths and retry. Also process leads independently: the early return at line 43 skips leads if no eligible call rows remain, and lead summary/contact fields need a complete retention review. |
| P2 | Meta verification endpoint echoes challenges without checking token or tenant: `src/api/events.js:82`. | A successful verification response does not prove a correctly configured or authenticated integration. Reproduced with a nonexistent tenant and wrong verify token. Native support needs proper verification and signed POST handling before use. |
| P2 | Queue enqueue failures are swallowed: `src/queue/queues.js:58`; campaign ingress ignores enqueue results in `src/api/events.js`. | Campaign ingress can report triggered after Redis rejected the job. Propagate/persist enqueue errors or use a transactional outbox. |
| P2 | Pending context is not fully safe across replicas: `src/telephony/campaign-registry.js:15`, `:39`. | Redis write failures silently fall back to local memory, which another API replica cannot see. Consume uses separate GET and DEL calls, allowing concurrent consumers. Fail explicitly or use a durable shared fallback and atomic consumption. |
| P2 | Fresh-clone test fixture missing from Git: `tests/audio.test.js:145`. | `test_output.mulaw` exists locally and is read at module load, but `git ls-files test_output.mulaw` is empty and `.gitignore` ignores it. A clean checkout cannot run this test suite as-is. Add a reviewed non-sensitive fixture or generate deterministic test audio. |

## Important missing product/operational pieces

| Area | Current state | Needed |
|---|---|---|
| Meta connection and diagnostics | No native Page/form connection management or Meta environment keys found; UI offers connector/CRM instructions. | For native support: validated Page/form ownership, securely stored credentials, required lead access, subscription setup, lead-ID retrieval, signature verification, expiry/revocation handling and connection health. Exact permissions must be checked during Meta setup; public Meta documentation returned access/rate-limit errors during this review. |
| End-to-end lead timing | Instant API responds when origination is accepted; no source-to-ringing timeline. | Record submission, receipt, retrieval, enqueue, dial request, provider acceptance, ringing and answer timestamps, joined by lead/call IDs. Report median/p95 and delayed/missed leads. |
| Instant call outcomes | Call row starts as active; no ring/hangup status callbacks are configured by the outbound adapter. | Persist provider IDs and correlate terminal outcomes even when the person never answers; distinguish queued, ringing, answered, busy, failed and no answer. Startup orphan reconciliation is not a substitute for per-call completion. |
| Instant capacity and limits | Dials inline; campaign worker concurrency controls do not apply. `instantCallLimiter` is mounted on the settings route before its auth, not the public ingress. | Tenant-aware dialing concurrency, burst control and spend limits at ingress/worker. A generic 300 requests/15 minutes/IP limiter exists but is not tenant call-budget enforcement. |
| Calling windows | Instant calls pass an empty campaign object to `canDial`. | If the product offers business-hour restrictions for instant calls, persist and pass those settings; currently the instant path only gets the suppression check. |
| Billing | No implemented plan/minute enforcement found; `src/api/team.js:66` always returns seats available. | Usage metering, plans/quotas, payment lifecycle and seat enforcement before charging customers. |
| Operations controls | Listen/replay/transfer routes return 501 in `src/api/ops.js:386`; admin settings is a placeholder page. | Implement or clearly disable unfinished controls. This does not mean all analytics are mocked: many dashboard routes use real APIs. |
| Database reproducibility | SQL schema and follow-up scripts exist, but no ordered migration/apply verification in CI was found. | Versioned migration runner, fresh-database test and verification of constraints/RLS on the actual deployment. Repository comments about live state are not fresh live verification. |
| Deployment documentation | `ARCHITECTURE.md` references removed realtime/deepgram modules; `REMEDIATION_PLAN.md` says there are no tests although the suite now exists. | Update completed versus outstanding work and document the supported runtime, deployment and recovery procedure. |

Existing foundations include multilingual Gemini audio, RAG/document ingestion, caller-specific lookups, tenant auth/roles, campaign workers, suppression logic, recording support, team messaging, telemetry, health checks and substantial tests. These are present; they should not be described as wholly missing based on the older remediation document.

## How to perform the first real Meta test

For the first test, use **Meta form → Zoho or Salesforce → existing instant-call webhook**, since the CRM-to-call portion has already been tested by the user. Creating a lead manually in the CRM validates only the final segment, not Meta delivery. Connector setup and access vary by account; do not assume an integration is available merely because both products have accounts.

1. Create/select the business Facebook Page and a lead form requesting name and phone. Use the business's connected Instagram account for the eventual Instagram ad placement. Establish lead access and connect that form to the chosen CRM/connector.
2. Keep the voice-agent preset matching the sender: **Zoho** for Zoho delivery, **Salesforce** for Salesforce delivery. Use **Meta** for forwarded Meta `field_data` or the guide's flattened connector JSON.
3. Fix the answer callback authentication defect before using the local version for a real call. Verify the public HTTPS hostname, caller ID and agent configuration.
4. Use the [Meta Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing/) to select the Page/form and preview it with the operator's own test number. Follow the tool's sample creation flow. For Zapier, its [official sample-lead guide](https://help.zapier.com/hc/en-us/articles/8496061345805-Use-the-Facebook-Lead-Ads-testing-tool-to-create-sample-leads) explains Preview Form, Create lead, Test trigger and Track Status; it also explains deleting only the old test lead when repeating a sample.
5. Observe the Meta/connector status, CRM record, app receipt and provider outcome. Answer the phone and confirm the AI speaks. HTTP 200 or a provider UUID alone is insufficient.
6. Use an isolated test configuration when repeating calls: a recent-contact filter or an existing CRM lead may intentionally prevent another call. Do not disable production suppression protections just to force a test.

Adobe's [official testing instructions](https://experienceleague.adobe.com/en/docs/experience-cloud-kcs/kbarticles/ka-29309) also describe testing forms without viewing an advertisement and inspecting subscription delivery status. Meta's documentation itself could not be fully retrieved in this session. Account setup and permissions still need live verification.

## Measuring the 5–10 second target

Start the clock at form submission, not when the CRM receives it. Stop at the handset ringing, not provider acceptance. Measure the individual delivery stages to identify the delay. Meta, any intermediate connector/CRM, the app, and the carrier all contribute; the app's inline dialing alone cannot establish a 5–10 second guarantee.

Suggested acceptance run: ten controlled submissions after setup, one dial per distinct lead, correct agent audio after answering, visible outcomes, and a measured submission-to-ring distribution. Replay the same event to prove deduplication, and test a missing phone and provider failure without dialing unintended recipients. The current local audit is functional simulation only and provides no real Meta/carrier latency result.

Recommended order: fix callback authentication and fail-open errors; add durable event identity/retries/outcomes; establish the Meta-to-CRM test connection; measure real latency; then decide whether the product needs direct native Meta integration.
