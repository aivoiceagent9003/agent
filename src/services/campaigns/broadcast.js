// services/campaigns/broadcast.js — TTS broadcast (no AI).
//
// Renders a template to speech via the existing Sarvam TTS (fetchTTSAudio →
// base64 μ-law 8k, the exact wire format telephony wants) and streams it over the
// campaign sink, then signals completion so the call is hung up. No Gemini session
// is opened, so a single box can fan out thousands of these cheaply.

import { fetchTTSAudio } from '../tts.js'

// Fill {placeholders} from the contact (name + custom_fields).
export function renderTemplate(template, contact = {}) {
  const vars = { name: contact.name || '', ...(contact.custom_fields || {}) }
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''))
}

// Stream a rendered broadcast message over `sink`, then call onDone() after the
// audio has had time to play. `sink.send` accepts a Twilio-style media frame; the
// Vobiz/campaign sink re-chunks as needed.
export async function runBroadcast(sink, streamId, text, { onDone } = {}) {
  const done = () => { try { onDone?.() } catch {} }
  if (!text?.trim()) { done(); return }
  try {
    const payload = await fetchTTSAudio(text)                 // base64 μ-law 8k
    if (sink.readyState === 1) {
      sink.send(JSON.stringify({ event: 'media', streamId, media: { payload } }))
    }
    const bytes = Buffer.from(payload, 'base64').length
    const playbackMs = Math.round((bytes / 8000) * 1000)     // 8000 μ-law bytes/sec
    console.log(`[BROADCAST] streamed ${bytes}B (${playbackMs}ms) to ${streamId}`)
    setTimeout(done, playbackMs + 1500).unref?.()            // let it finish, then hang up
  } catch (e) {
    console.error('[BROADCAST] failed:', e.message)
    done()
  }
}
