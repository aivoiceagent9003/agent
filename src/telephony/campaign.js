// telephony/campaign.js — OUTBOUND campaign call handling (API process).
//
// The dialer (worker) originates a call and stashes context in Redis keyed by a
// correlation_id (campaign-registry.js). When the provider connects the media
// stream here, we resolve that context and either:
//   • AI Sales  → createCascadeConnection with the campaign's merged config
//   • Broadcast → stream the rendered TTS message, then hang up
//
// This is the OUTBOUND counterpart to the inbound src/telephony/plivo.js and is kept
// deliberately separate so the two flows never entangle. Every call row written here
// is tagged direction='outbound' with campaign linkage.

import { createCascadeConnection, PIPELINE } from '../services/cascade.js'
import { clearHistory } from '../services/llm.js'
import { extractLead, saveLead } from '../services/leads.js'
import { CallRecorder, uploadRecording } from '../services/recording.js'
import { runBroadcast } from '../services/campaigns/broadcast.js'
import { scheduleRetry } from '../services/campaigns/execute.js'
import { takePending, peekPending } from './campaign-registry.js'
import { enqueueAnalytics } from '../queue/queues.js'
import { supabase } from '../api/db.js'
import telemetry from '../services/telemetry.js'
import { webhookQuery } from '../api/webhook-auth.js'
import { createPlayoutTracker } from './playout.js'
import { hangUpCall } from './hangup.js'
import 'dotenv/config'

// Margin left after the caller should have heard everything, before the line drops.
// It covers the provider's own jitter buffer so the last syllable is never clipped.
// Tunable, because a provider that buffers more deeply needs more of it.
const TAIL_MS = Number(process.env.HANGUP_TAIL_MS || 700)


// Extract the correlation id from Plivo's 'start' frame.
function extractCorrelation(msg) {
  return (
    msg.start?.correlation_id ||
    msg.correlation_id ||
    parseExtraHeaders(msg.extra_headers || msg.start?.extra_headers).correlation_id ||
    parseExtraHeaders(msg.extra_headers || msg.start?.extra_headers).callkey ||
    null
  )
}

// Reuse the inbound extraHeaders parsing convention ("{X-PH-key: val}") — see the
// note in plivo.js.
function parseExtraHeaders(raw) {
  const out = {}
  if (!raw) return out
  if (typeof raw === 'object') { for (const [k, v] of Object.entries(raw)) out[String(k).replace(/^X-PH-/i, '')] = v; return out }
  const inner = String(raw).trim().replace(/^\{/, '').replace(/\}$/, '')
  for (const part of inner.split(',')) {
    const idx = part.indexOf(':'); if (idx === -1) continue
    const key = part.slice(0, idx).trim().replace(/^X-PH-/i, ''); const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

// Outbound sink. Plivo wants 20ms/160-byte playAudio frames. Mirrors makePlivoSink.
function makeSink(ws, getStreamId, recorder, trace, getProviderCallId) {
  let ending = false
  const playout = createPlayoutTracker()
  return {
    get readyState() { return ws.readyState },
    /** Milliseconds of agent speech the callee has not heard yet. */
    msRemaining() { return playout.msRemaining() },
    send(str) {
      let m
      try { m = JSON.parse(str) } catch { ws.send(str); return }
      if (m.event === 'media' && m.media?.payload) {
        const buf = Buffer.from(m.media.payload, 'base64')
        recorder?.addOutbound(buf)
        let frames = 0
        for (let off = 0; off < buf.length; off += 160) {
          ws.send(JSON.stringify({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: buf.subarray(off, off + 160).toString('base64') } }))
          frames++
        }
        trace?.packet('out', frames)
        playout.queued(buf.length)
        return
      }
      if (m.event === 'clear') {
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
      console.log(`[CAMPAIGN] 👋 ending call in ${wait}ms (${reason}) — letting the last words play out`)
      setTimeout(() => {
        hangUpCall(getProviderCallId?.()).catch(() => {})
        try { ws.close() } catch { /* already gone */ }
      }, wait)
    },
  }
}

// ─── /answer-campaign webhook (Plivo outbound answer_url) ─────────────────────
// Plivo fetches this when the callee answers; we return <Stream> XML pointing at
// the campaign WS, carrying the correlation id through extraHeaders (like inbound).
export async function answerCampaign(req, res) {
  const cid = req.query.cid || req.body?.correlation_id || req.body?.cid || ''
  const ctx = cid ? await peekPending(cid) : null
  if (!ctx) {
    console.error('[CAMPAIGN] answer: unknown correlation', cid)
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>')
    return
  }
  const wsUrl = `wss://${process.env.PUBLIC_HOST || process.env.NGROK_URL}/media-stream-campaign?${webhookQuery()}`
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" extraHeaders="correlation_id=${cid}">
    ${wsUrl}
  </Stream>
</Response>`)
}

// ─── WS handler ────────────────────────────────────────────────────────────────
export function handleCampaignConnection(ws) {
  console.log('[CAMPAIGN] WS connected')
  let ctx = null, dg = null, streamId = null
  let callSid = null, callId = null, ready = false, finalized = false
  let providerCallId = null   // the REST control handle, for hanging the call up
  let audioBuffer = [], transcriptBuffer = [], recorder = null, trace = null, callStart = null

  const getStreamId = () => streamId

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.event === 'start') {
      streamId = msg.streamId || msg.start?.streamId || null
      const cid = extractCorrelation(msg)
      ctx = cid ? await takePending(cid) : null
      if (!ctx) { console.error('[CAMPAIGN] no context for correlation', cid); ws.close(); return }

      callId = ctx.callId || null
      // Same fallback chain as inbound: the dialer knows the uuid, but take it off
      // the start frame too in case the campaign row predates it.
      providerCallId = callId || msg.start?.callId || msg.start?.CallUUID || msg.callUuid || msg.CallUUID || null
      callSid = streamId || callId || `campaign-${Date.now()}`
      callStart = Date.now()
      // Opt-in, same as inbound — see the note in plivo.js.
      const recordingOn = (ctx.config || {}).recording_enabled === true
      recorder = recordingOn ? new CallRecorder() : null
      trace = telemetry.startTrace({
        callSid, tenantId: ctx.tenantId, tenantName: ctx.tenantName,
        callerNumber: ctx.phone, businessNumber: ctx.fromNumber,
        engine: ctx.type === 'broadcast' ? 'broadcast' : PIPELINE.label,
      })
      trace?.set('direction', 'outbound')
      trace?.set('campaignId', ctx.campaignId)
      trace?.set('conversationState', 'active')

      const sink = makeSink(ws, getStreamId, recorder, trace, () => providerCallId)

      await logCampaign(ctx, 'answered', { callSid })

      if (ctx.type === 'broadcast') {
        runBroadcast(sink, streamId, ctx.message, { onDone: () => { finalize('completed'); try { ws.close() } catch {} } })
        return
      }

      // AI Sales — reuse the exact live engine, with the campaign's merged config.
      dg = createCascadeConnection(
        callSid,
        ctx.config,
        sink,
        streamId || 'campaign',
        (text, role = 'user') => { transcriptBuffer.push({ role, text }) },
        () => { ready = true; audioBuffer.forEach(c => dg.send(c)); audioBuffer = [] },
        ctx.phone,
      )
      console.log(`[CAMPAIGN] AI pipeline started (campaign ${ctx.campaignId}, engine gemini)`)
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      const chunk = Buffer.from(msg.media.payload, 'base64')
      recorder?.addInbound(chunk)
      trace?.packet('in')
      if (!dg) return
      if (!ready) audioBuffer.push(chunk); else dg.send(chunk)
      return
    }

    if (msg.event === 'stop') { await finalize('completed'); return }
  })

  ws.on('close', () => finalize('completed'))

  async function finalize(status) {
    if (finalized) return
    finalized = true
    trace?.set('conversationState', 'finalizing')
    if (dg) dg.finish()
    if (!ctx) { if (callSid) telemetry.endTrace(callSid, { status: 'completed' }); return }

    const durationSeconds = callStart ? Math.round((Date.now() - callStart) / 1000) : 0
    const answered = durationSeconds > 0
    const disposition = answered ? 'answered' : 'no_answer'

    try {
      let recordingPath = null
      if (recorder && !recorder.isEmpty()) {
        try { const wav = recorder.toWav(); if (wav) recordingPath = await uploadRecording(ctx.tenantId, callId, wav) } catch {}
      }
      const transcript = transcriptBuffer.map(t => `${t.role === 'assistant' ? 'Agent' : 'Caller'}: ${t.text}`).join('\n')

      // Update the outbound call row created by the dialer worker.
      if (callId) {
        await supabase.from('calls').update({
          status: 'completed', transcript, duration_seconds: durationSeconds,
          recording_path: recordingPath,
          ...telemetry.callQuality(trace),   // avg reply time + knowledge hit/ask counts
        }).eq('id', callId)
      }

      // Lead extraction (AI Sales only) — reuse the existing extractor. saveLead
      // only persists calls that qualify as leads (identifiable interest), so
      // `savedLead` reflects whether an actual lead was recorded.
      let savedLead = false
      if (ctx.type !== 'broadcast') {
        // Built from the turns collected for the transcript, NOT llm.js getHistory() —
        // only the retired speech-to-speech engine wrote to that store, so reading it
        // has returned [] (and skipped extraction, silently) since the engine swap.
        // See the matching note in plivo.js finalize().
        const history = transcriptBuffer.map(t => ({ role: t.role, content: t.text }))
        if (history.length > 0) {
          // Same measured language the inbound path uses. The live classifier heard
          // the audio; the extractor would only be inferring language from text, and
          // it landed on Hindi far too often when left to do that.
          const lead = await extractLead(history, ctx.config || {}, {
            knownLanguage: trace?.state?.dominantLanguage || trace?.state?.language || null,
          })
          if (lead) savedLead = await saveLead(supabase, { tenantId: ctx.tenantId, callId, callerNumber: ctx.phone, lead })
        } else {
          console.warn(`[CAMPAIGN] no conversation turns — skipping lead extraction (call ${callId})`)
        }
      }

      // Update contact + campaign log so analytics + retry can act.
      // Answered → terminal. No answer → schedule a retry per the campaign's
      // retry_policy (delay_minutes, default 60); only terminal once exhausted.
      // Instant calls (no campaign/contact) skip all of this — the calls row +
      // lead extraction above are their full record.
      if (ctx.contactId) {
        let contactStatus = 'completed'
        if (!answered) {
          const [{ data: campaign }, { data: contact }] = await Promise.all([
            supabase.from('campaigns').select('id, type, retry_policy').eq('id', ctx.campaignId).single(),
            supabase.from('campaign_contacts').select('id, phone, attempts').eq('id', ctx.contactId).single(),
          ])
          if (campaign && contact) {
            const job = { tenantId: ctx.tenantId, campaignId: ctx.campaignId, contactId: ctx.contactId, runId: ctx.runId }
            const retried = await scheduleRetry(job, campaign, contact, 'no_answer', contact.attempts || 0)
            if (retried) contactStatus = 'no_answer'
          }
        }
        await supabase.from('campaign_contacts').update({
          status: contactStatus, disposition, last_contacted_at: new Date().toISOString(),
          call_id: callId,
        }).eq('id', ctx.contactId)
        await logCampaign(ctx, answered ? 'completed' : 'no_answer', { durationSeconds, hasLead: savedLead, disposition })
        enqueueAnalytics(ctx.campaignId)   // refresh metrics (fire-and-forget)
      }
    } catch (e) {
      console.error('[CAMPAIGN] finalize error:', e.message)
    }

    if (callSid) { clearHistory(callSid); telemetry.endTrace(callSid, { status: 'completed' }) }
    console.log('[CAMPAIGN] finalized', callSid)
  }
}

async function logCampaign(ctx, event, detail = {}) {
  if (!ctx?.campaignId) return   // instant calls have no campaign to log against
  try {
    await supabase.from('campaign_logs').insert({
      tenant_id: ctx.tenantId, campaign_id: ctx.campaignId, run_id: ctx.runId,
      contact_id: ctx.contactId, event, detail,
    })
  } catch (e) { /* logging best-effort */ }
}
