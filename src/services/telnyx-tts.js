// telnyx-tts.js — Telnyx Ultra, the voice every call is spoken in.
//
// WHY. Soniox's TTS generates speech barely faster than real time, and whenever it
// dips the caller hears the agent stop between sentences and carry on — replaying real
// replies, 59s of silence across 12 of them during one slow stretch. Telnyx Ultra had
// none (0 gaps in 12 replies), starting ~0.1s later (median 774ms vs 637ms). Ultra is
// Cartesia's Sonic-3 resold: its Telugu voice ids are Cartesia's own. Pay-as-you-go at
// $0.000032 a character — about ₹4.8 of voice on a 3-minute call against ₹2.15 on
// Soniox.
//
// HOW. Ultra is REST only (no WebSocket) and returns MP3 whatever format is asked for,
// so one finished sentence is one request, and the MP3 is decoded as it streams in —
// in-process (WebAssembly), about 3-10ms for a 3-second sentence — into what the call
// needs: 8kHz µ-law for a phone, 16-bit PCM for a browser. Telnyx encodes at exactly the
// sampling_rate asked for (measured: 8000, 16000, 24000, mono), so there is no resampling.
//
//   POST https://api.telnyx.com/v2/text-to-speech/speech   (chunked audio/mpeg back)
//   { text, voice: 'Telnyx.Ultra.<id>', voice_settings: { sampling_rate, language_boost } }

export const TELNYX_TTS_URL = 'https://api.telnyx.com/v2/text-to-speech/speech'

// scriptLanguage codes → Ultra's language_boost names (only the ones it lists).
const BOOST = { te: 'Telugu', hi: 'Hindi', ta: 'Tamil', bn: 'Bengali', gu: 'Gujarati', mr: 'Marathi', pa: 'Punjabi', en: 'English' }

/** G.711 µ-law, one 16-bit sample to one byte. */
export function linearToMulaw(sample) {
  const BIAS = 0x84
  const CLIP = 32635
  let s = sample
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { /* find the segment */ }
  const mantissa = (s >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

const toInt16 = (f) => (f >= 1 ? 32767 : f <= -1 ? -32768 : Math.round(f * 32767))

function encode(samples, format) {
  if (format === 'pcm_s16le') {
    const out = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i++) out.writeInt16LE(toInt16(samples[i]), i * 2)
    return out
  }
  const out = Buffer.alloc(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(toInt16(samples[i]))
  return out
}

let decoderModule = null
const loadDecoder = () => (decoderModule ||= import('mpg123-decoder'))

/** Compile the decoder at server start (~150ms), so a call's first sentence does not. */
export async function preloadMp3Decoder() {
  const { MPEGDecoder } = await loadDecoder()
  const d = new MPEGDecoder()
  await d.ready
  d.free()
}

/**
 * Speak one sentence, yielding audio buffers as they are decoded.
 *
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.voice         e.g. 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'
 * @param {string} o.text
 * @param {string} o.format        'pcm_mulaw' (phone) or 'pcm_s16le' (browser)
 * @param {number} o.sampleRate
 * @param {string} [o.language]    a scriptLanguage code; sets Ultra's language_boost
 * @param {AbortSignal} [o.signal]
 * @throws {Error} with `.status` on an HTTP refusal, so a 429 can be retried
 */
export async function* streamTelnyxSpeech({ apiKey, voice, text, format, sampleRate, language, signal, fetchImpl = fetch }) {
  const voiceSettings = { sampling_rate: sampleRate }
  if (BOOST[language]) voiceSettings.language_boost = BOOST[language]
  const res = await fetchImpl(TELNYX_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, voice_settings: voiceSettings }),
    signal,
  })
  if (!res.ok) {
    const err = new Error(`Telnyx TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const { MPEGDecoder } = await loadDecoder()
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) return
      const { channelData, samplesDecoded } = decoder.decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
      // Mono is what Ultra sends; take the first channel either way.
      if (samplesDecoded) yield encode(channelData[0].subarray(0, samplesDecoded), format)
    }
  } finally {
    decoder.free()
  }
}
