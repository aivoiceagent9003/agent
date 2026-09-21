// telephony/vobiz.js — INBOUND adapter for Plivo / Vobiz (Indian numbers, TRAI-compliant).
//
// Both providers stream G.711 mu-law 8kHz over a bidirectional WebSocket and speak the
// same <Stream> XML and playAudio/clearAudio frames, so ONE adapter serves both and the
// voice engine runs UNCHANGED. This module only adapts the TRANSPORT:
//   • /answer  webhook → returns <Stream> XML
//   • /media-stream-vobiz WS → feeds provider frames into the voice engine
//   • outbound audio → 'playAudio' frames (re-chunked to 20ms/160 bytes)
//
// The filename and the /media-stream-vobiz route keep their original names on purpose:
// the route is baked into provider consoles, and renaming it would break every
// configured webhook. TELEPHONY_PROVIDER selects the actual provider (provider.js).
//
// ⚠️ CONFIRM-ON-FIRST-CALL: the 'start' event field names aren't fully documented on
// either provider. We log the raw 'start' frame and resolve the tenant defensively
// (extraHeaders key → number fields). Confirmed on Plivo: extra_headers arrives as
// "{X-PH-callkey: <uuid>, ...}" and streamId/callId sit under start.

import { createSonioxCascadeConnection } from '../services/soniox-cascade.js'
import { clearHistory } from '../services/llm.js'
import { TAG, PROVIDER } from './provider.js'
import { createPlayoutTracker } from './playout.js'
import { hangUpCall } from './hangup.js'

// One engine: Soniox STT → LLM → Soniox TTS (see services/soniox-cascade.js).
//
// There used to be a per-tenant selector here, because the platform ran Gemini Live
// speech-to-speech as well. That engine is gone: it re-billed the whole conversation on
// every turn, and the cascade answers faster, costs a fraction, and is the only path
// that gets the latency and prompt-cache work. Keeping a second engine alive meant
// every fix had to be made twice.
function voiceEngineFor() {
  return { name: 'soniox', create: createSonioxCascadeConnection }
}
import { extractLead, saveLead } from '../services/leads.js'
import { CallRecorder, uploadRecording } from '../services/recording.js'
import { recordingNotice } from '../services/greeting.js'
import { saveKnowledgeGaps } from '../services/rag.js'
import { supabase } from '../api/db.js'
import telemetry from '../services/telemetry.js'
import { verifyDestination, isE164, xmlEscape, webhookQuery } from '../api/webhook-auth.js'
import { randomUUID } from 'crypto'
import 'dotenv/config'

// Margin left after the caller should have heard everything, before the line drops.
// It covers the provider's own jitter buffer so the last syllable is never clipped.
// Tunable, because a provider that buffers more deeply needs more of it.
const TAIL_MS = Number(process.env.HANGUP_TAIL_MS || 700)

// Extract an E.164-ish number from "+1234", "sip:+1234@domain", etc.
function normalize(n) {
  if (!n) return ''
  const match = String(n).match(/(\+?\d[\d\s\-().]+)/)
  return match ? match[1].replace(/\s/g, '') : String(n).trim()
}

// Resolve a tenant by the called number, tolerant of formatting. Vobiz sends the
// Indian national format ("08071583556"); a tenant may be stored as "+918071583556",
// "918071583556", etc. Match on the last 10 digits (the significant part) so all
// formats resolve to the same tenant.
async function findTenantByNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return null
  const last10 = digits.slice(-10)
  if (last10.length < 10) {
    const { data } = await supabase.from('tenants').select('*').eq('phone_number', raw).maybeSingle()
    return data || null
  }
  const { data } = await supabase
    .from('tenants').select('*').ilike('phone_number', `%${last10}`).limit(1)
  return data?.[0] || null
}

// ─── Pending call tickets ─────────────────────────────────────────────────────
// /answer mints a ticket and hands the key to Vobiz via extraHeaders; the WS
// 'start' frame presents it back and consumes it. The key IS the authentication
// for the media stream, so it has three properties that all matter:
//
//   unguessable — a random UUID, not the call row id. The row id would otherwise
//                 leak an internal identifier to the provider, and anything
//                 derived from the caller/called numbers would be guessable by
//                 anyone who knows a business's published phone number.
//   single-use  — consumed on the first successful start; a replayed key is dead.
//   short-lived — swept after TICKET_TTL_MS. Previously entries were only removed
//                 on a successful start, so every call whose stream never
//                 connected leaked its tenant object for the process lifetime.
const pendingCalls = new Map()
const TICKET_TTL_MS = Number(process.env.CALL_TICKET_TTL_MS || 60_000)

setInterval(() => {
  const cutoff = Date.now() - TICKET_TTL_MS
  for (const [key, v] of pendingCalls) {
    if (v.createdAt < cutoff) pendingCalls.delete(key)
  }
}, 30_000).unref?.()

// ─── /answer webhook ─────────────────────────────────────────────────────────
// Vobiz POSTs here when a call hits one of our numbers. We resolve the tenant by
// the called number, open a call row, and return <Stream> pointing at our WS.
export async function vobizAnswer(req, res) {
  // Telemetry: the webhook is the FIRST event of a call's lifecycle. We capture
  // the timings here (callSid isn't known until the WS 'start' frame) and replay
  // them as spans once the trace exists, so the waterfall opens with webhook →
  // tenant_resolution → call_row_insert. webhookAt is the timeline origin.
  const webhookAt = Date.now()
  const calledNumber = normalize(req.body.To || req.body.to || req.body.called_number || req.body.destination)
  const callerNumber = normalize(req.body.From || req.body.from || req.body.caller_number || req.body.source)
  // Vobiz's per-call REST control handle (Plivo-style CallUUID). Needed later to
  // transfer this LIVE call to a human (see handoff.js). Captured defensively —
  // confirm the exact field from the /answer body log after the first real call.
  const providerCallId =
    req.body.CallUUID || req.body.call_uuid || req.body.callUuid ||
    req.body.CallSid || req.body.call_sid || req.body.uuid || null
  console.log(`[${TAG}] Incoming call to: ${calledNumber} from: ${callerNumber} callUuid: ${providerCallId || 'n/a'}`)

  telemetry.incr('calls_incoming')
  const tResolve0 = Date.now()
  const tenant = await findTenantByNumber(calledNumber)
  const tenantResolveMs = Date.now() - tResolve0
  telemetry.recordLatency('tenant_resolution', tenantResolveMs)

  if (!tenant) {
    console.error(`[${TAG}] No tenant for number:`, calledNumber)
    telemetry.incr('calls_rejected')
    telemetry.recordServiceEvent({ component: 'telephony', severity: 'warning', kind: 'no_tenant', detail: { calledNumber } })
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>')
    return
  }

  const tInsert0 = Date.now()
  const { data: call } = await supabase
    .from('calls')
    .insert({ tenant_id: tenant.id, caller_number: callerNumber, status: 'active' })
    .select().single()
  const callInsertMs = Date.now() - tInsert0

  // Random, not the call row id: this key authenticates the media stream, and it
  // travels out to the provider. Deriving it from anything an outsider could know
  // or guess — the caller's number, a timestamp — would defeat the point.
  const callkey = randomUUID()
  pendingCalls.set(callkey, {
    tenant, callId: call?.id || null, callerNumber, providerCallId,
    createdAt: Date.now(),
    // Webhook-phase telemetry, replayed as spans when the WS trace starts.
    telemetry: {
      webhookAt,
      webhookMs: Date.now() - webhookAt,
      tenantResolveMs, tenantResolveRel: tResolve0 - webhookAt,
      callInsertMs, callInsertRel: tInsert0 - webhookAt,
      calledNumber,
    },
  })
  telemetry.recordLatency('webhook', Date.now() - webhookAt)

  // PUBLIC_HOST is the real deployment hostname; NGROK_URL is the dev fallback.
  // The stream URL carries the webhook secret so the upgrade can be gated too.
  const host = process.env.PUBLIC_HOST || process.env.NGROK_URL
  const wsUrl = `wss://${host}/media-stream-vobiz?${webhookQuery()}`
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" extraHeaders="callkey=${callkey}">
    ${wsUrl}
  </Stream>
</Response>`)
}

// Optional global hangup webhook (configured in the Vobiz console).
export function vobizHangup(_req, res) {
  res.sendStatus(200)
}

// ─── /vobiz/transfer — the XML Vobiz fetches when we transfer a live call ───────
// handoff.js redirects the caller leg here (aleg_url) with ?to=<human number> and
// ?callerId=<business DID>. We return <Dial> XML so the caller is connected to the
// human agent. The media stream ends automatically when the leg is redirected.
export function vobizTransferXml(req, res) {
  const to = String(req.query.to || req.body?.to || '').trim()
  const callerId = String(req.query.callerId || req.body?.callerId || '').trim()
  const sig = String(req.query.sig || req.body?.sig || '').trim()
  res.type('text/xml')

  const empty = () => res.send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>')

  if (!to) {
    console.error(`[${TAG}] transfer XML requested without a destination number`)
    return empty()
  }

  // The destination made a round trip through Vobiz and came back as a query
  // string, so it is attacker-controllable by anyone who can reach this endpoint.
  // Only a destination we ourselves signed in handoff.js is dialled. Without this
  // the endpoint is an open relay: ?to=<any premium-rate number> and we pay.
  if (!verifyDestination(to, callerId, sig)) {
    console.error(`[${TAG}] transfer REJECTED — bad or missing signature for ${to}`)
    telemetry.recordServiceEvent({
      component: 'telephony', severity: 'error', kind: 'transfer_signature_rejected',
      detail: { to, hasSig: Boolean(sig) },
    })
    return empty()
  }

  // Defence in depth: even a correctly signed value must still look like a phone
  // number before it reaches the XML.
  if (!isE164(to) || (callerId && !isE164(callerId))) {
    console.error(`[${TAG}] transfer REJECTED — non-E.164 value (to=${to} callerId=${callerId})`)
    return empty()
  }

  const callerAttr = callerId ? ` callerId="${xmlEscape(callerId)}"` : ''
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Please hold while I connect you to a team member.</Speak>
  <Dial${callerAttr} timeout="30">
    <Number>${xmlEscape(to)}</Number>
  </Dial>
  <Speak>Sorry, no one is available right now. Please try again later. Goodbye.</Speak>
  <Hangup/>
</Response>`)
}

// ─── Outbound sink ───────────────────────────────────────────────────────────
// Mimics the Twilio ws interface that streamTTSToTwilio expects, so deepgram.js
// stays Twilio-shaped. It translates the outbound frames:
//   {event:'media', media:{payload}}  → Vobiz 'playAudio' (re-chunked to 160B/20ms)
//   {event:'clear'}                    → Vobiz 'clearAudio' (barge-in)
function makeVobizSink(ws, getStreamId, recorder, trace, getProviderCallId) {
  let sentFirstAudio = false
  let ending = false
  const playout = createPlayoutTracker()
  return {
    get readyState() { return ws.readyState },
    /** Milliseconds of agent speech the caller has not heard yet. */
    msRemaining() { return playout.msRemaining() },
    send(str) {
      let m
      try { m = JSON.parse(str) } catch { ws.send(str); return }

      if (m.event === 'media' && m.media?.payload) {
        // Re-frame to 20ms / 160-byte mulaw chunks — Vobiz ingress expects 20ms
        // framing; larger chunks cause jitter/robotic audio.
        const buf = Buffer.from(m.media.payload, 'base64')
        recorder?.addOutbound(buf)   // capture the agent's audio for the recording
        // One-shot proof that agent audio actually left this process. Without it a
        // silent call is indistinguishable from a broken tunnel, a dead socket and
        // a model that never spoke — all three look identical in the log.
        if (!sentFirstAudio) {
          sentFirstAudio = true
          console.log(`[${TAG}] 🔊 first agent audio frame sent to caller (socket=${ws.readyState === 1 ? 'OPEN' : 'NOT OPEN — audio is being DROPPED'})`)
        }
        let frames = 0
        for (let off = 0; off < buf.length; off += 160) {
          const piece = buf.subarray(off, off + 160)
          ws.send(JSON.stringify({
            event: 'playAudio',
            media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: piece.toString('base64') },
          }))
          frames++
        }
        playout.queued(buf.length)     // so we know when the caller has heard it all
        trace?.packet('out', frames)   // count outbound audio frames (non-emitting)
        return
      }

      if (m.event === 'clear') {
        // Barge-in: the provider discards what it had buffered, so nothing is
        // outstanding any more.
        playout.cleared()
        ws.send(JSON.stringify({ event: 'clearAudio', streamId: getStreamId() }))
        return
      }

      ws.send(str)
    },

    /**
     * End the call from our side, once the caller has actually HEARD the closing
     * line. Everything queued is still playing out at 8kHz, so closing the moment
     * the model stops generating cuts the goodbye off mid-word.
     *
     * Two mechanisms, deliberately. Closing the stream returns the provider to the
     * answer XML, which has nothing after the <Stream> and so drops the call — that
     * is the usual path. The REST hangup is the guarantee, because "usually" is not
     * good enough for the one feature whose whole job is ending the call.
     */
    endCall(reason = 'agent') {
      if (ending) return
      ending = true
      const wait = playout.msRemaining() + TAIL_MS
      console.log(`[${TAG}] 👋 ending call in ${wait}ms (${reason}) — letting the last words play out`)
      setTimeout(() => {
        hangUpCall(getProviderCallId?.()).catch(() => {})
        try { ws.close() } catch { /* already gone */ }
      }, wait)
    },
  }
}

// Providers deliver extra headers as a STRING like "{X-PH-callkey: <value>, X-PH-x: y}"
// (not JSON) and prefix our keys with their own tag — Plivo uses "X-PH-", Vobiz
// "X-VH-". Strip EITHER prefix rather than keying this off TELEPHONY_PROVIDER: the
// prefix is whatever the provider that placed this call used, and during a provider
// switch both shapes can legitimately arrive at the same process. Getting this wrong
// loses the callkey, which drops the call.
function parseExtraHeaders(raw) {
  const out = {}
  if (!raw) return out
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) out[String(k).replace(/^X-(VH|PH)-/i, '')] = v
    return out
  }
  const inner = String(raw).trim().replace(/^\{/, '').replace(/\}$/, '')
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim().replace(/^X-(VH|PH)-/i, '')
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

// Tenant recovery from the 'start' frame, via the ticket /answer minted.
//
// There is deliberately NO fallback. There used to be one: if the callkey was
// missing, the tenant was resolved from the phone number in the start frame — a
// value supplied by whoever opened the socket. Since the socket itself is
// unauthenticated, that meant anyone could connect, name a customer's published
// business number, and be handed a full agent session on that customer's
// agent, prompt, and knowledge base — billed to them. The number in the start
// frame is now treated as what it is: an untrusted claim.
//
// If a legitimate call ever arrives without a usable callkey, the correct outcome
// is a dropped call and a loud telemetry event, not a guessed tenant.
function resolveTenantFromStart(msg) {
  const headers = parseExtraHeaders(
    msg.extra_headers || msg.start?.extra_headers || msg.extraHeaders || msg.start?.extraHeaders
  )
  const callkey = headers.callkey || msg.start?.callkey || msg.callkey
  if (!callkey) return { error: 'no_callkey' }

  const pending = pendingCalls.get(callkey)
  if (!pending) return { error: 'unknown_or_expired_callkey' }

  // Read-once: consuming the ticket here means a replayed key is already dead.
  pendingCalls.delete(callkey)
  return { pending }
}

// ─── WS connection handler ───────────────────────────────────────────────────
export function handleVobizConnection(ws) {
  console.log(`[${TAG}] WebSocket connected`)

  let dg = null
  let tenant = null
  let callId = null
  let callerNumber = null
  let callSid = null
  let streamId = null
  let dgReady = false
  let audioBuffer = []
  let transcriptBuffer = []
  let callStart = null
  let finalized = false
  let recorder = null
  let trace = null
  // Evidence that the disclosure went out on THIS call. "Our greeting normally
  // says so" is not an answer about a specific call, which is the whole reason
  // the column exists — so it has to be stamped from the same condition that
  // decides whether to record at all.
  let noticePlayed = false
  let gotFirstAudio = false   // one-shot inbound-media diagnostic

  const getStreamId = () => streamId

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.event === 'start') {
      // Log the raw start frame so the exact field names can be confirmed and
      // resolveTenantFromStart() tightened after the first real call.
      console.log(`[${TAG}] start:`, JSON.stringify(msg))
      streamId = msg.streamId || msg.start?.streamId || msg.stream_id || null

      const { pending: resolved, error } = resolveTenantFromStart(msg)
      if (!resolved?.tenant) {
        console.error(`[${TAG}] rejecting media stream — ${error}`)
        telemetry.incr('media_stream_failures')
        telemetry.recordServiceEvent({
          component: 'telephony', severity: 'error', kind: 'media_stream_unauthenticated',
          detail: { streamId, reason: error },
        })
        ws.close()
        return
      }
      telemetry.incr('calls_answered')
      tenant = resolved.tenant
      callId = resolved.callId
      callerNumber = resolved.callerNumber || callerNumber
      callSid = streamId || callId || `vobiz-${Date.now()}`
      callStart = Date.now()

      // ── Telemetry: open the trace for this call. The engine looks it
      // up by callSid via telemetry.getTrace(), so it MUST exist before the engine
      // is created. The webhook phase (captured in pendingCalls) is replayed as
      // spans so the waterfall starts at the webhook, not the WS connect.
      const tm = resolved.telemetry || {}
      trace = telemetry.startTrace({
        callSid,
        tenantId: tenant.id,
        tenantName: tenant.name,
        callerNumber,
        businessNumber: tm.calledNumber || null,
        engine: voiceEngineFor(tenant.config || {}).name,
        startedAt: tm.webhookAt || callStart,
      })
      if (tm.webhookAt) {
        trace.addSpan('webhook', { startRel: 0, durationMs: tm.webhookMs || 0 })
        trace.addSpan('tenant_resolution', { startRel: tm.tenantResolveRel || 0, durationMs: tm.tenantResolveMs || 0 })
        trace.addSpan('db_call_insert', { startRel: tm.callInsertRel || 0, durationMs: tm.callInsertMs || 0, latencyOp: 'supabase' })
      }
      trace.addSpan('websocket_connected', { startRel: callStart - (tm.webhookAt || callStart), durationMs: 0 })
      trace.set('conversationState', 'active')

      // Let the Ops Center terminate this live call (Live Calls Console action).
      telemetry.registerControl(callSid, {
        terminate: () => { try { ws.close() } catch {} ; finalize() },
      })

      // Per-call transport info so the engine's human-handoff transfers over Vobiz
      // (not Twilio): provider + the Vobiz CallUUID (REST control handle) + the DID
      // to use as caller ID when dialing the human. provider_call_id falls back to
      // fields on the 'start' frame if the /answer webhook didn't carry it.
      const tenantConfig = {
        ...(tenant.config || {}),
        tenant_id: tenant.id,
        provider: PROVIDER,
        provider_call_id:
          resolved.providerCallId ||
          msg.start?.callUuid || msg.start?.CallUUID || msg.callUuid || msg.CallUUID || null,
        business_number: tm.calledNumber || null,
      }
      // Recording is OPT-IN. It is personal data under DPDP, and the caller is
      // only told about it when the tenant has enabled it (see recordingNotice in
      // greeting.js) — so recording while the greeting stays silent about it would
      // be capturing a voice nobody disclosed we were capturing.
      const recordingOn = tenantConfig.recording_enabled === true
      noticePlayed = recordingNotice(tenantConfig) !== ''
      recorder = recordingOn ? new CallRecorder() : null
      const sink = makeVobizSink(ws, getStreamId, recorder, trace, () => tenantConfig.provider_call_id)

      const voiceEngine = voiceEngineFor(tenantConfig)
      dg = voiceEngine.create(
        callSid,
        tenantConfig,
        sink,                       // outbound audio → playAudio frames
        streamId || 'vobiz',
        (text, role = 'user') => { transcriptBuffer.push({ role, text }) },
        () => {                     // onReady — flush audio buffered before STT was ready
          dgReady = true
          audioBuffer.forEach(c => dg.send(c))
          audioBuffer = []
        },
        callerNumber,
      )
      console.log(`[${TAG}] Pipeline started for tenant: ${tenant.name} (engine: ${voiceEngine.name})`)
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      const chunk = Buffer.from(msg.media.payload, 'base64')
      // One-shot proof the caller's audio is reaching us at all. A call where this
      // never prints is a transport problem (tunnel, provider, codec) — no amount
      // of engine or prompt work can fix a stream that never arrives.
      if (!gotFirstAudio) { gotFirstAudio = true; console.log(`[${TAG}] 🎤 first caller audio frame received`) }
      recorder?.addInbound(chunk)   // capture the caller's audio for the recording
      trace?.packet('in')           // count inbound audio frames (non-emitting)
      if (!dg) return
      if (!dgReady) audioBuffer.push(chunk)
      else dg.send(chunk)
      return
    }

    if (msg.event === 'stop') {
      console.log(`[${TAG}] stop`)
      await finalize()
      return
    }

    // 'playedStream' — ack that our audio reached a checkpoint; nothing to do yet.
  })

  ws.on('close', () => { finalize() })

  // Save transcript + extract/save lead, then clear memory. Mirrors the Twilio
  // path's stop handling. Idempotent.
  async function finalize() {
    if (finalized) return
    finalized = true
    trace?.set('conversationState', 'finalizing')
    if (dg) dg.finish()

    const finSpan = trace?.span('finalize')
    if (callId) {
      // We show clients the RECORDING + an English summary, not the noisy live
      // transcript — so we store the raw transcript only for internal reference
      // (no LLM cleanup) and upload the call audio for playback.
      const transcript = transcriptBuffer
        .map(t => `${t.role === 'assistant' ? 'Agent' : 'Caller'}: ${t.text}`)
        .join('\n')
      const durationSeconds = callStart ? Math.round((Date.now() - callStart) / 1000) : 0

      let recordingPath = null
      if (recorder && !recorder.isEmpty()) {
        const recSpan = trace?.span('recording_upload')
        try {
          const wav = recorder.toWav()
          if (wav) recordingPath = await uploadRecording(tenant?.id, callId, wav)
          recSpan?.end({ payloadBytes: wav?.length || 0 })
        } catch (e) {
          console.error(`[${TAG}] recording upload failed:`, e.message)
          recSpan?.end({ error: e })
          telemetry.recordServiceEvent({ component: 'storage', severity: 'error', kind: 'recording_upload', detail: { error: e.message, callSid } })
        }
      }

      const updSpan = trace?.span('db_call_update', { latencyOp: 'supabase' })
      const callRow = {
        status: 'completed', transcript, duration_seconds: durationSeconds, recording_path: recordingPath,
        consent_notice_played: noticePlayed,
        ...telemetry.callQuality(trace),   // avg reply time + knowledge hit/ask counts
      }
      // Postgres rejects the ENTIRE update when a single column is missing, and this
      // is the write that persists the transcript — the most valuable thing the call
      // produced. Migrations in sql/ get applied late or not at all (analytics.sql and
      // compliance.sql have both been missing in practice), and losing a transcript to
      // a migration gap is a far worse outcome than losing a metric. So: drop whichever
      // column the database says it does not know, and retry with the rest.
      //
      // ESSENTIAL is never dropped. Without these the row is not a record of the call
      // at all, and silently writing a hollow row would be worse than failing loudly.
      const ESSENTIAL = new Set(['status', 'transcript', 'duration_seconds'])
      const dropped = []
      let updErr = null
      for (let attempt = 0; attempt < 6; attempt++) {
        const { error } = await supabase.from('calls').update(callRow).eq('id', callId)
        updErr = error
        if (!error) break
        // PostgREST names the offending column: "Could not find the 'x' column of …"
        const missing = /Could not find the '([^']+)' column/.exec(error.message || '')?.[1]
        if (!missing || ESSENTIAL.has(missing) || !(missing in callRow)) break
        delete callRow[missing]
        dropped.push(missing)
      }
      if (dropped.length) {
        console.warn(`[${TAG}] calls table is missing ${dropped.join(', ')} — run the pending sql/ migrations. Call saved without ${dropped.length === 1 ? 'it' : 'them'}.`)
        telemetry.recordServiceEvent({
          component: 'telephony', severity: 'warn', kind: 'calls_schema_behind',
          detail: { missing: dropped, callSid },
        })
      }
      // Previously unchecked: a failure here silently discarded the transcript.
      if (updErr) {
        console.error(`[${TAG}] call row update failed:`, updErr.message)
        telemetry.recordServiceEvent({
          component: 'telephony', severity: 'error', kind: 'call_update_failed',
          detail: { error: updErr.message, callSid },
        })
      }
      updSpan?.end()

      // Questions the agent couldn't answer, collected during the call. Surfaced
      // on the client's Home page as a to-do list for their knowledge base.
      await saveKnowledgeGaps({
        tenantId: tenant?.id, callId, questions: trace?.state?.knowledgeMisses,
      })

      if (tenant) {
        // The conversation, for the extractor — built from the SAME turns that became
        // the transcript above, so the two can never disagree about what was said.
        //
        // This deliberately does NOT use llm.js getHistory(). That store was only ever
        // filled by the old speech-to-speech engine, which pushed each turn into it by
        // hand. The cascade keeps its own messages and never wrote there, so after the
        // engine swap getHistory() returned [] on every call and lead extraction
        // stopped running entirely — silently, because the emptiness was checked here,
        // in front of the code that would have logged it. Every call still recorded a
        // transcript, so nothing looked broken except that no leads appeared.
        const history = transcriptBuffer.map(t => ({ role: t.role, content: t.text }))
        if (history.length > 0) {
          const leadSpan = trace?.span('lead_extraction')
          try {
            // The live classifier measured the call language turn by turn; the
            // extractor would otherwise re-guess it from the transcript and can
            // get it plainly wrong. Undefined for native-audio models, which run
            // without a LanguageManager — the extractor then falls back to its
            // own inference, which is the best available signal in that case.
            // dominantLanguage, not language: the latter is the live steering
            // state, which a garbled final utterance can flip. Telugu calls were
            // being filed as Hindi on the strength of two mistranscribed lines.
            const lead = await extractLead(history, tenant.config || {}, {
              knownLanguage: trace?.state?.dominantLanguage || trace?.state?.language || null,
            })
            if (lead) await saveLead(supabase, { tenantId: tenant.id, callId, callerNumber, lead })
            leadSpan?.end({ attrs: { extracted: !!lead, intent: lead?.intent || null } })
          } catch (e) {
            leadSpan?.end({ error: e })
          }
        } else {
          // Say so. Extraction quietly not running is exactly how it went unnoticed
          // after the engine swap: the transcript still saved, the call still looked
          // healthy, and only the absence of leads gave it away. A genuinely empty
          // call (wrong number, silence) prints this too — that is the cheaper error.
          console.warn(`[${TAG}] no conversation turns — skipping lead extraction (call ${callId})`)
        }
      }
    }
    finSpan?.end()

    if (callSid) clearHistory(callSid)
    if (callSid) { telemetry.unregisterControl(callSid); telemetry.endTrace(callSid, { status: 'completed' }) }
    console.log(`[${TAG}] Call finalized`)
  }
}
