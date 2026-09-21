// soniox-tts-stream.js — Soniox real-time TTS over one websocket per call.
//
// The REST endpoint cannot start until it has the whole sentence, so a long opening
// sentence is paid for twice: once waiting for the model to finish writing it, and
// again waiting for audio. Measured warm, clock starting at the model's first token:
//
//   "Supreme variant మంచి ఆప్షన్ అండి."            REST  626ms   stream  542ms
//   "చాలా ఆప్షన్స్ ఉన్నాయిండి."                      REST  604ms   stream  476ms
//   a 130-character sentence with a premium in it   REST 1558ms   stream  741ms
//
// The gap grows with the sentence because REST's first byte scales with input length
// and the stream's does not — it starts speaking the opening words while the rest is
// still arriving.
//
// One socket carries every sentence of a call, each as its own stream_id. Audio comes
// back tagged with that id and is appended to the caller's item, so the playback queue
// in soniox-cascade.js keeps the exact same contract it had with REST:
//   item.chunks[]  µ-law buffers, in order      item.done   no more audio coming
//   item.cancelled drop whatever still arrives  item.notify wake the pump
//
// Protocol: https://soniox.com/docs/api-reference/tts/websocket-api
//   → { api_key, model, voice, language, audio_format, sample_rate, stream_id }
//   → { text, text_end, stream_id }          (repeatable; text_end closes the stream)
//   ← { audio, audio_end, terminated, stream_id }

import WebSocket from 'ws'

export const TTS_WS_URL = 'wss://tts-rt.soniox.com/tts-websocket'

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.voice
 * @param {(msg: string) => void} [opts.onError] called with a human-readable reason
 * @param {() => Promise<void>} [opts.acquire] concurrency gate — Soniox caps streams
 *        per ORGANISATION, and without this a five-sentence reply opened five at once
 *        and the caller lost whole sentences to 429s.
 * @param {() => void} [opts.release] returns the slot taken by acquire
 * @param {number} [opts.retries] attempts after a 429 before giving up on a sentence
 * @param {typeof WebSocket} [opts.WebSocketImpl] injected in tests
 */
export function createTtsSocket({
  apiKey, model, voice, url = TTS_WS_URL, onError, WebSocketImpl = WebSocket,
  acquire = () => Promise.resolve(), release = () => {}, retries = 2,
  // A phone line takes 8kHz mu-law; a browser has no reason to. See AUDIO_PROFILES
  // in soniox-cascade.js.
  audioFormat = 'pcm_mulaw', sampleRate = 8000,
}) {
  let ws = null
  let opening = null
  let seq = 0
  let closed = false
  const streams = new Map()   // stream_id → item

  function finish(item) {
    if (!item || item.done) return
    item.done = true
    if (item.slot) { item.slot = false; release() }
    item.notify?.()
  }

  function open() {
    if (closed) return Promise.reject(new Error('tts socket closed'))
    if (ws && ws.readyState === 1) return Promise.resolve(ws)
    if (opening) return opening
    opening = new Promise((resolve, reject) => {
      const sock = new WebSocketImpl(url)
      ws = sock
      sock.on('open', () => { opening = null; resolve(sock) })
      sock.on('message', (raw) => {
        let m
        try { m = JSON.parse(raw.toString()) } catch { return }
        const item = m.stream_id ? streams.get(m.stream_id) : null
        if (m.error_code || m.error_message) {
          onError?.(`${m.error_code || 'error'}: ${m.error_message || ''}`)
          if (!item) return
          streams.delete(m.stream_id)
          // A 429 means the organisation is at its stream limit right now, not that
          // this sentence is unspeakable. Give the slot back, wait for one to free up,
          // and say it again — losing a sentence mid-reply is what the caller hears.
          if (Number(m.error_code) === 429 && item.attempt < retries && !item.cancelled) {
            if (item.slot) { item.slot = false; release() }
            setTimeout(() => { if (!item.cancelled && !item.done) startStream(item) }, 250 * item.attempt)
            return
          }
          finish(item)
          return
        }
        if (m.audio && item && !item.cancelled) {
          if (!item.firstByteAt) item.firstByteAt = Date.now()
          item.chunks.push(Buffer.from(m.audio, 'base64'))
          item.notify?.()
        }
        if ((m.audio_end || m.terminated) && item) {
          streams.delete(m.stream_id)
          finish(item)
        }
      })
      sock.on('error', (e) => {
        opening = null
        onError?.(e.message)
        // Nothing more is coming for anything in flight; release the pump.
        for (const item of streams.values()) finish(item)
        streams.clear()
        reject(e)
      })
      sock.on('close', () => {
        if (ws === sock) ws = null
        opening = null
        for (const item of streams.values()) finish(item)
        streams.clear()
      })
    })
    return opening
  }

  function send(payload) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(payload)); return true }
    return false
  }

  /**
   * Take a concurrency slot, open a stream, and write everything written so far.
   * Everything pushed lives in item.outbox, so a retry after a 429 replays the whole
   * sentence rather than resuming half-way through one Soniox never accepted.
   */
  async function startStream(item) {
    item.attempt = (item.attempt || 0) + 1
    try {
      // The sentence a caller is waiting on in silence outranks one that is queued
      // behind speech they are already hearing — see acquireTts in soniox-cascade.js.
      if (!item.slot) { await acquire(item.priority || 0); item.slot = true }
      await open()
    } catch {
      finish(item)
      return
    }
    if (item.cancelled || item.done || closed) { finish(item); return }
    const id = `s${++seq}`
    item.streamId = id
    item.live = true
    streams.set(id, item)
    send({ api_key: apiKey, model, voice, language: item.language, audio_format: audioFormat, sample_rate: sampleRate, stream_id: id })
    for (const text of item.outbox) send({ text, text_end: false, stream_id: id })
    if (item.ended) send({ text: '', text_end: true, stream_id: id })
  }

  return {
    /** Open the socket ahead of the first sentence, so its handshake is not on the clock. */
    warm() { return open().catch(() => null) },

    /**
     * Start a stream for this item. Text can be pushed before this resolves — it is
     * buffered and flushed in order, so callers never have to await it.
     */
    begin(item, language, priority = 0) {
      item.language = language
      item.priority = priority
      item.outbox = []     // every fragment written for this sentence, for replay
      item.ended = false
      item.live = false
      item.attempt = 0
      startStream(item)    // deliberately not awaited: text can queue behind it
      return item
    },

    /** Append text. Safe before the stream is live — it is written when it opens. */
    push(item, text) {
      if (!text || item.cancelled || item.ended || item.done) return
      item.outbox.push(text)
      if (item.live) send({ text, text_end: false, stream_id: item.streamId })
    },

    /** No more text for this item; audio keeps arriving until audio_end. */
    end(item) {
      if (item.ended || item.cancelled || item.done) return
      item.ended = true
      if (item.live) send({ text: '', text_end: true, stream_id: item.streamId })
    },

    /**
     * Barge-in. Soniox has no per-stream cancel, and a stream left running is audio
     * we are billed for and nobody hears — so the socket is dropped and the next
     * sentence opens a new one. That reconnect happens while the caller is talking,
     * which is time we were not using anyway.
     */
    reset() {
      const sock = ws
      ws = null
      opening = null
      for (const item of streams.values()) finish(item)
      streams.clear()
      try { sock?.close() } catch { /* already gone */ }
    },

    close() {
      closed = true
      this.reset()
    },

    /** For tests and logging. */
    get inFlight() { return streams.size },
  }
}
