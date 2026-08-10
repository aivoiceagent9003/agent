// telephony/vobiz.js — Vobiz adapter (Indian numbers, TRAI-compliant).
//
// Vobiz streams G.711 mu-law 8kHz over a bidirectional WebSocket, so the Gemini
// Live engine runs UNCHANGED. This module only adapts the TRANSPORT:
//   • /answer  webhook → returns Vobiz <Stream> XML
//   • /media-stream-vobiz WS → feeds Vobiz frames into the Gemini Live engine
//   • outbound audio → Vobiz 'playAudio' frames (re-chunked to 20ms/160 bytes)
//
// ⚠️ CONFIRM-ON-FIRST-CALL: the exact field names in Vobiz's 'start' event and how
// extraHeaders are delivered aren't fully documented. We log the raw 'start' frame
// and resolve the tenant defensively (extraHeaders key → number fields). Once you
// see a real start payload in the logs, tighten resolveTenantFromStart().

import { createGeminiLiveConnection } from '../services/gemini-live.js'
import { clearHistory, getHistory } from '../services/llm.js'

// Live calls run on Gemini Live speech-to-speech (the only engine).
const createVoiceConnection = createGeminiLiveConnection
import { extractLead, saveLead } from '../services/leads.js'
import { CallRecorder, uploadRecording } from '../services/recording.js'
import { supabase } from '../api/db.js'
import telemetry from '../services/telemetry.js'
import 'dotenv/config'

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

// Pending calls set by /answer, recovered by the WS 'start' event via a callkey
// we pass through extraHeaders. Keyed by the call row id.
const pendingCalls = new Map()

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
  console.log(`[VOBIZ] Incoming call to: ${calledNumber} from: ${callerNumber} callUuid: ${providerCallId || 'n/a'}`)

  telemetry.incr('calls_incoming')
  const tResolve0 = Date.now()
  const tenant = await findTenantByNumber(calledNumber)
  const tenantResolveMs = Date.now() - tResolve0
  telemetry.recordLatency('tenant_resolution', tenantResolveMs)

  if (!tenant) {
    console.error('[VOBIZ] No tenant for number:', calledNumber)
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

  const callkey = call?.id || `${callerNumber}-${Date.now()}`
  pendingCalls.set(callkey, {
    tenant, callId: call?.id || null, callerNumber, providerCallId,
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

  const wsUrl = `wss://${process.env.NGROK_URL}/media-stream-vobiz`
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
  res.type('text/xml')
  if (!to) {
    console.error('[VOBIZ] transfer XML requested without a destination number')
    return res.send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>')
  }
  const callerAttr = callerId ? ` callerId="${callerId}"` : ''
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Please hold while I connect you to a team member.</Speak>
  <Dial${callerAttr} timeout="30">
    <Number>${to}</Number>
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
function makeVobizSink(ws, getStreamId, recorder, trace) {
  return {
    get readyState() { return ws.readyState },
    send(str) {
      let m
      try { m = JSON.parse(str) } catch { ws.send(str); return }

      if (m.event === 'media' && m.media?.payload) {
        // Re-frame to 20ms / 160-byte mulaw chunks — Vobiz ingress expects 20ms
        // framing; larger chunks cause jitter/robotic audio.
        const buf = Buffer.from(m.media.payload, 'base64')
        recorder?.addOutbound(buf)   // capture the agent's audio for the recording
        let frames = 0
        for (let off = 0; off < buf.length; off += 160) {
          const piece = buf.subarray(off, off + 160)
          ws.send(JSON.stringify({
            event: 'playAudio',
            media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: piece.toString('base64') },
          }))
          frames++
        }
        trace?.packet('out', frames)   // count outbound audio frames (non-emitting)
        return
      }

      if (m.event === 'clear') {
        ws.send(JSON.stringify({ event: 'clearAudio', streamId: getStreamId() }))
        return
      }

      ws.send(str)
    },
  }
}

// Vobiz delivers extra headers as a STRING like "{X-VH-callkey: <value>, X-VH-x: y}"
// (not JSON, and it prefixes our keys with "X-VH-"). Parse it back into an object
// with the prefix stripped.
function parseExtraHeaders(raw) {
  const out = {}
  if (!raw) return out
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) out[String(k).replace(/^X-VH-/i, '')] = v
    return out
  }
  const inner = String(raw).trim().replace(/^\{/, '').replace(/\}$/, '')
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim().replace(/^X-VH-/i, '')
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

// Best-effort tenant recovery from the 'start' frame. Prefer the callkey we
// injected via extraHeaders; fall back to the called number if present.
async function resolveTenantFromStart(msg) {
  const headers = parseExtraHeaders(
    msg.extra_headers || msg.start?.extra_headers || msg.extraHeaders || msg.start?.extraHeaders
  )
  const callkey = headers.callkey || msg.start?.callkey || msg.callkey
  if (callkey && pendingCalls.has(callkey)) {
    const pending = pendingCalls.get(callkey)
    pendingCalls.delete(callkey)
    return pending
  }
  const called = normalize(msg.start?.to || msg.to || msg.start?.called_number || '')
  if (called) {
    const tenant = await findTenantByNumber(called)
    if (tenant) return { tenant, callId: null, callerNumber: normalize(msg.start?.from || msg.from || '') }
  }
  return null
}

// ─── WS connection handler ───────────────────────────────────────────────────
export function handleVobizConnection(ws) {
  console.log('[VOBIZ] WebSocket connected')

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

  const getStreamId = () => streamId

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.event === 'start') {
      // Log the raw start frame so the exact field names can be confirmed and
      // resolveTenantFromStart() tightened after the first real call.
      console.log('[VOBIZ] start:', JSON.stringify(msg))
      streamId = msg.streamId || msg.start?.streamId || msg.stream_id || null

      const resolved = await resolveTenantFromStart(msg)
      if (!resolved?.tenant) {
        console.error('[VOBIZ] Could not resolve tenant for stream — closing')
        telemetry.incr('media_stream_failures')
        telemetry.recordServiceEvent({ component: 'telephony', severity: 'error', kind: 'media_stream_unresolved', detail: { streamId } })
        ws.close()
        return
      }
      telemetry.incr('calls_answered')
      tenant = resolved.tenant
      callId = resolved.callId
      callerNumber = resolved.callerNumber || callerNumber
      callSid = streamId || callId || `vobiz-${Date.now()}`
      callStart = Date.now()

      // ── Telemetry: open the trace for this call. Engines (gemini-live) look it
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
        engine: 'gemini',
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
        provider: 'vobiz',
        provider_call_id:
          resolved.providerCallId ||
          msg.start?.callUuid || msg.start?.CallUUID || msg.callUuid || msg.CallUUID || null,
        business_number: tm.calledNumber || null,
      }
      recorder = new CallRecorder()
      const sink = makeVobizSink(ws, getStreamId, recorder, trace)

      dg = createVoiceConnection(
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
      console.log(`[VOBIZ] Pipeline started for tenant: ${tenant.name} (engine: gemini)`)
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      const chunk = Buffer.from(msg.media.payload, 'base64')
      recorder?.addInbound(chunk)   // capture the caller's audio for the recording
      trace?.packet('in')           // count inbound audio frames (non-emitting)
      if (!dg) return
      if (!dgReady) audioBuffer.push(chunk)
      else dg.send(chunk)
      return
    }

    if (msg.event === 'stop') {
      console.log('[VOBIZ] stop')
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
          console.error('[VOBIZ] recording upload failed:', e.message)
          recSpan?.end({ error: e })
          telemetry.recordServiceEvent({ component: 'storage', severity: 'error', kind: 'recording_upload', detail: { error: e.message, callSid } })
        }
      }

      const updSpan = trace?.span('db_call_update', { latencyOp: 'supabase' })
      await supabase.from('calls')
        .update({ status: 'completed', transcript, duration_seconds: durationSeconds, recording_path: recordingPath })
        .eq('id', callId)
      updSpan?.end()

      if (tenant) {
        const history = getHistory(callSid)
        if (history && history.length > 0) {
          const leadSpan = trace?.span('lead_extraction')
          try {
            const lead = await extractLead(history, tenant.config || {})
            if (lead) await saveLead(supabase, { tenantId: tenant.id, callId, callerNumber, lead })
            leadSpan?.end({ attrs: { extracted: !!lead, intent: lead?.intent || null } })
          } catch (e) {
            leadSpan?.end({ error: e })
          }
        }
      }
    }
    finSpan?.end()

    if (callSid) clearHistory(callSid)
    if (callSid) { telemetry.unregisterControl(callSid); telemetry.endTrace(callSid, { status: 'completed' }) }
    console.log('[VOBIZ] Call finalized')
  }
}
