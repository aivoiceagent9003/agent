// sarvam-stt.js — Sarvam's realtime speech-to-text: how the voice engine hears callers.
//
// WHY. Soniox decides a turn is over with a semantic model, and on real calls that
// model stopped deciding: a Telugu call waited 2.4-7.8s on five of six turns, and a
// replay of that call's own lines (same audio into both, same moment) had Soniox end
// the turn anywhere from 0.5s to 4.3s — once not at all within 5s — while Sarvam ended
// every one in 1.1-1.3s. Sarvam's end of turn is a plain silence timer
// (silence_duration_ms), which is predictable, and its code-mix mode wrote the
// English in those lines as English ("term insurance", "sum assured") where Soniox
// wrote "some assured" and put a Telugu sentence's product name in Hindi script.
//
// HOW. The cascade's STT handling works on a simple token stream — tokens marked
// final or not, and "<end>" when the turn is over — and that handling (barge-in,
// language tracking, latency measurement) is what matters, not the wire format. So
// this translates Sarvam's events in both directions:
//
//   Sarvam transcript.partial {text}         → { tokens: [{ text, is_final: false }] }
//   Sarvam transcript.final   {text, end_s}  → { tokens: [{ text, is_final: true, end_ms }, { text: '<end>' }] }
//   Sarvam error                             → { error_code, error_message }
//   audio Buffer from the cascade            → { event: 'audio_input', audio: <base64> }
//
// A partial is Sarvam's whole current guess at the utterance, so it is passed on as
// the non-final tokens as-is, without accumulation.
//
// Protocol: wss://api.sarvam.ai/speech-to-text-realtime/ws, key in API-SUBSCRIPTION-KEY.

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

export const SARVAM_STT_URL = 'wss://api.sarvam.ai/speech-to-text-realtime/ws'

// The cascade's audio profiles name formats their own way; Sarvam's names differ.
const ENCODING = { mulaw: 'mulaw', pcm_s16le: 'linear16' }

/** 'te-IN' → 'te', which is what the cascade's language tracking keys on. */
const shortLang = (code) => (code ? String(code).split('-')[0].toLowerCase() : undefined)

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.format        the profile's sttFormat: 'mulaw' (phone) or 'pcm_s16le' (browser)
 * @param {number} o.sampleRate    8000 or 16000 — Sarvam accepts nothing else
 * @param {number} o.silenceMs     silence that ends a turn
 * @param {string} [o.model]
 * @param {string} [o.mode]        'codemix' writes English words in English letters
 * @param {string|string[]} [o.keyterms]  domain words to favour. Sarvam takes them only on
 *        saaras:v4, as a JSON array — a comma list, or keyterms on v3, makes it refuse
 *        the WHOLE session (measured), so they are dropped rather than sent wrong.
 * @param {string} [o.prompt]      a context hint (works on v3): the product names to expect
 * @returns an object with the slice of the `ws` interface the cascade uses
 */
export function openSarvamStt({
  apiKey, format, sampleRate, silenceMs = 600, model = 'saaras:v3-realtime', mode = 'codemix',
  keyterms = '', prompt = '', WebSocketImpl = WebSocket,
}) {
  const params = new URLSearchParams({
    language_code: 'auto', model, mode, stream_type: 'fast',
    encoding: ENCODING[format] || 'mulaw', sample_rate: String(sampleRate),
    endpointing: 'vad', silence_duration_ms: String(silenceMs),
    // end_s is what the cascade measures "how long after the last word" from.
    return_timestamps: 'true',
  })
  const terms = Array.isArray(keyterms) ? keyterms : String(keyterms || '').split(',').map(t => t.trim()).filter(Boolean)
  if (terms.length && /^saaras:v4/.test(model)) params.set('keyterms', JSON.stringify(terms))
  else if (terms.length) console.warn(`[SARVAM] keyterms need saaras:v4 (this is ${model}) — ignored so the session is not refused`)
  if (prompt) params.set('prompt', prompt)
  const ws = new WebSocketImpl(`${SARVAM_STT_URL}?${params}`, { headers: { 'API-SUBSCRIPTION-KEY': apiKey } })
  const out = new EventEmitter()
  const relay = (msg) => out.emit('message', Buffer.from(JSON.stringify(msg)))

  ws.on('open', () => out.emit('open'))
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.event === 'transcript.partial') {
      if (m.text) relay({ tokens: [{ text: m.text, is_final: false, language: shortLang(m.language) }] })
    } else if (m.event === 'transcript.final') {
      const tokens = []
      const text = String(m.text || '').trim()
      if (text) {
        // end_s is where Sarvam's VAD closed the segment, silence window included —
        // measured 640-720ms past the real end of speech at a 600ms window. The cascade
        // times "how long after the last word" from end_ms, so the window comes off
        // here; left in, a 1.3s wait was logged as 293ms.
        const endS = parseFloat(m.end_s)
        const startS = parseFloat(m.start_s)
        const floor = Number.isFinite(startS) ? Math.round(startS * 1000) : 0
        tokens.push({
          text, is_final: true, language: shortLang(m.language),
          ...(Number.isFinite(endS) ? { end_ms: Math.max(floor, Math.round(endS * 1000) - silenceMs) } : {}),
        })
      }
      tokens.push({ text: '<end>', is_final: true })
      relay({ tokens })
    } else if (m.event === 'error') {
      relay({ error_code: m.code || m.status_code || 'error', error_message: m.message || '' })
    }
  })
  // A refused handshake (bad key, bad parameter) arrives here, not as an error event.
  // With this listener attached, `ws` neither errors nor closes on its own, so both are
  // reported here — the cascade's reconnect runs off 'close'.
  let closed = false
  const closeOnce = (code) => { if (!closed) { closed = true; out.emit('close', code) } }
  ws.on('unexpected-response', (_req, res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => {
      out.emit('error', new Error(`Sarvam STT refused the connection: HTTP ${res.statusCode} ${body.slice(0, 200)}`))
      closeOnce(1006)
    })
  })
  ws.on('error', (e) => out.emit('error', e))
  ws.on('close', (code) => closeOnce(code))

  return {
    get readyState() { return ws.readyState },
    on(event, fn) { out.on(event, fn); return this },
    send(data) {
      if (ws.readyState !== 1) return
      // Audio is the only thing the cascade sends. Anything else is dropped.
      if (Buffer.isBuffer(data)) ws.send(JSON.stringify({ event: 'audio_input', audio: data.toString('base64') }))
    },
    close() { try { ws.close() } catch { /* already gone */ } },
    /** Change settings mid-call, e.g. a vocabulary prompt that was not ready at connect. */
    configure(fields) { if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'config.update', ...fields })) },
  }
}
