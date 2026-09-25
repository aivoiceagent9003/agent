import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { streamTelnyxSpeech, linearToMulaw, TELNYX_TTS_URL } from '../src/services/telnyx-tts.js'

// A real MP3 — half a second of 440Hz, 8kHz mono, 64kbps, the shape Telnyx Ultra sends
// for a phone call — so the decoding is exercised for real, not stubbed.
const MP3 = fs.readFileSync(new URL('./fixtures/tone-8k.mp3', import.meta.url))
const bodyIn = (size) => (async function* () { for (let i = 0; i < MP3.length; i += size) yield MP3.subarray(i, i + size) })()
const opts = (fetchImpl, extra = {}) => ({
  apiKey: 'KEY', voice: 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565', text: 'నమస్తే అండి',
  format: 'pcm_mulaw', sampleRate: 8000, language: 'te', fetchImpl, ...extra,
})
const collect = async (gen) => { const out = []; for await (const b of gen) out.push(b); return Buffer.concat(out) }

// Reference G.711 µ-law decoder, to check the encoder round-trips.
const mulawToLinear = (u) => { u = ~u & 0xff; const t = ((u & 0x0f) << 3) + 0x84; const v = (t << ((u & 0x70) >> 4)) - 0x84; return u & 0x80 ? -v : v }

describe('linearToMulaw', () => {
  it('matches G.711 at the anchor points', () => {
    expect(linearToMulaw(0)).toBe(0xff)
    expect(linearToMulaw(32767)).toBe(0x80)
    expect(linearToMulaw(-32768)).toBe(0x00)
  })
  it('round-trips within µ-law\'s own quantisation error', () => {
    for (const x of [-30000, -8000, -1000, -100, -8, 8, 100, 1000, 8000, 30000]) {
      const back = mulawToLinear(linearToMulaw(x))
      expect(Math.abs(back - x)).toBeLessThanOrEqual(Math.max(8, Math.abs(x) * 0.07))
    }
  })
})

describe('streamTelnyxSpeech', () => {
  it('asks Ultra for 8kHz with a Telugu boost, and turns the MP3 into 8kHz µ-law', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, body: bodyIn(MP3.length) }))
    const audio = await collect(streamTelnyxSpeech(opts(fetchImpl)))
    expect(audio.length).toBe(4000)                        // 0.5s at 8000 one-byte samples
    const [url, req] = fetchImpl.mock.calls[0]
    expect(url).toBe(TELNYX_TTS_URL)
    expect(req.headers.Authorization).toBe('Bearer KEY')
    expect(JSON.parse(req.body)).toEqual({
      text: 'నమస్తే అండి', voice: 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565',
      voice_settings: { sampling_rate: 8000, language_boost: 'Telugu' },
    })
  })

  it('decodes the same audio however the network splits the MP3', async () => {
    const whole = await collect(streamTelnyxSpeech(opts(async () => ({ ok: true, body: bodyIn(MP3.length) }))))
    for (const size of [1000, 97, 13]) {
      const pieces = await collect(streamTelnyxSpeech(opts(async () => ({ ok: true, body: bodyIn(size) }))))
      expect(pieces.equals(whole)).toBe(true)
    }
  })

  it('gives a browser caller 16-bit PCM and leaves out an unknown language', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, body: bodyIn(MP3.length) }))
    const audio = await collect(streamTelnyxSpeech(opts(fetchImpl, { format: 'pcm_s16le', language: 'xx' })))
    expect(audio.length).toBe(8000)                        // 4000 samples, 2 bytes each
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).voice_settings).toEqual({ sampling_rate: 8000 })
  })

  it('throws with the HTTP status, so a 429 can be retried and a 402 falls back', async () => {
    const fetchImpl = async () => ({ ok: false, status: 402, text: async () => 'insufficient balance' })
    await expect(collect(streamTelnyxSpeech(opts(fetchImpl)))).rejects.toMatchObject({ status: 402 })
  })
})
