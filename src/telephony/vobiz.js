// telephony/vobiz.js — Vobiz adapter (Indian numbers, TRAI-compliant).
//
// Vobiz streams G.711 mu-law 8kHz over a bidirectional WebSocket — byte-for-byte
// the same audio format Twilio uses — so the whole STT→translate→LLM→lookup→TTS
// pipeline in createDeepgramConnection works UNCHANGED. This module only adapts
// the TRANSPORT:
//   • /answer  webhook → returns Vobiz <Stream> XML (like Twilio's TwiML)
//   • /media-stream-vobiz WS → maps Vobiz frames into createDeepgramConnection
//   • outbound audio → Vobiz 'playAudio' frames (re-chunked to 20ms/160 bytes)
//
// Twilio keeps working in parallel (different routes + WS path); the active
// provider is chosen by which webhook a given number points at.
//
// ⚠️ CONFIRM-ON-FIRST-CALL: the exact field names in Vobiz's 'start' event and how
// extraHeaders are delivered aren't fully documented. We log the raw 'start' frame
// and resolve the tenant defensively (extraHeaders key → number fields). Once you
// see a real start payload in the logs, tighten resolveTenantFromStart().

import { createDeepgramConnection } from '../services/deepgram.js'
import { clearHistory, getHistory } from '../services/llm.js'
import { extractLead, saveLead } from '../services/leads.js'
import { supabase } from '../api/db.js'
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
  const calledNumber = normalize(req.body.To || req.body.to || req.body.called_number || req.body.destination)
  const callerNumber = normalize(req.body.From || req.body.from || req.body.caller_number || req.body.source)
  console.log(`[VOBIZ] Incoming call to: ${calledNumber} from: ${callerNumber}`)

  const tenant = await findTenantByNumber(calledNumber)

  if (!tenant) {
    console.error('[VOBIZ] No tenant for number:', calledNumber)
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>')
    return
  }

  const { data: call } = await supabase
    .from('calls')
    .insert({ tenant_id: tenant.id, caller_number: callerNumber, status: 'active' })
    .select().single()

  const callkey = call?.id || `${callerNumber}-${Date.now()}`
  pendingCalls.set(callkey, { tenant, callId: call?.id || null, callerNumber })

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

// ─── Outbound sink ───────────────────────────────────────────────────────────
// Mimics the Twilio ws interface that streamTTSToTwilio expects, so deepgram.js
// stays Twilio-shaped. It translates the outbound frames:
//   {event:'media', media:{payload}}  → Vobiz 'playAudio' (re-chunked to 160B/20ms)
//   {event:'clear'}                    → Vobiz 'clearAudio' (barge-in)
function makeVobizSink(ws, getStreamId) {
  return {
    get readyState() { return ws.readyState },
    send(str) {
      let m
      try { m = JSON.parse(str) } catch { ws.send(str); return }

      if (m.event === 'media' && m.media?.payload) {
        // Re-frame to 20ms / 160-byte mulaw chunks — Vobiz ingress expects 20ms
        // framing; larger chunks cause jitter/robotic audio.
        const buf = Buffer.from(m.media.payload, 'base64')
        for (let off = 0; off < buf.length; off += 160) {
          const piece = buf.subarray(off, off + 160)
          ws.send(JSON.stringify({
            event: 'playAudio',
            media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: piece.toString('base64') },
          }))
        }
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
        ws.close()
        return
      }
      tenant = resolved.tenant
      callId = resolved.callId
      callerNumber = resolved.callerNumber || callerNumber
      callSid = streamId || callId || `vobiz-${Date.now()}`
      callStart = Date.now()

      const tenantConfig = { ...(tenant.config || {}), tenant_id: tenant.id }
      const sink = makeVobizSink(ws, getStreamId)

      dg = createDeepgramConnection(
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
      console.log(`[VOBIZ] Pipeline started for tenant: ${tenant.name}`)
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      const chunk = Buffer.from(msg.media.payload, 'base64')
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
    if (dg) dg.finish()

    if (callId) {
      const transcript = transcriptBuffer.map(t => `${t.role}: ${t.text}`).join('\n')
      const durationSeconds = callStart ? Math.round((Date.now() - callStart) / 1000) : 0
      await supabase.from('calls')
        .update({ status: 'completed', transcript, duration_seconds: durationSeconds })
        .eq('id', callId)

      if (tenant) {
        const history = getHistory(callSid)
        if (history && history.length > 0) {
          const lead = await extractLead(history, tenant.config || {})
          if (lead) await saveLead(supabase, { tenantId: tenant.id, callId, callerNumber, lead })
        }
      }
    }

    if (callSid) clearHistory(callSid)
    console.log('[VOBIZ] Call finalized')
  }
}
