// scripts/voice-bench.mjs — TTS shoot-out for the cascaded-pipeline decision.
//
// The question is not "does vendor X list Telugu". It is whether a vendor can speak
// the way this agent actually talks: Telugu script, romanized Tinglish, and English
// business words and rupee amounts inside one Telugu sentence. Vendor language lists
// do not answer that — listening does.
//
// Every line below is a REAL agent reply from a GSK insurance call log.
//
// Usage:  node scripts/voice-bench.mjs [outDir]
// Needs SARVAM_API_KEY; add ELEVENLABS_API_KEY to include ElevenLabs.
// Writes one audio file per line per engine, plus telephony-band (8k µ-law) copies,
// because 8k is what the caller actually hears — a voice that shines at 44.1kHz can
// fall apart there.

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Rates: set to YOUR plan. Sarvam Bulbul v3 is ₹30/10K chars (docs.sarvam.ai pricing).
// ElevenLabs varies by plan — Flash is half the per-character price of the standard
// models; override with ELEVENLABS_INR_PER_1K_CHARS once you know your tier.
const INR = {
  sarvamPerChar: Number(process.env.SARVAM_INR_PER_CHAR ?? 0.003),
  elevenPerChar: Number(process.env.ELEVENLABS_INR_PER_1K_CHARS ?? 4.8) / 1000,
  // Cartesia Sonic: ~$35 per 1M characters => ~₹3.36 per 1K chars.
  cartesiaPerChar: Number(process.env.CARTESIA_INR_PER_1K_CHARS ?? 3.36) / 1000,
}

const LINES = [
  { id: '1-telugu-script', lang: 'te-IN', text: 'వేవర్ ఆఫ్ ప్రీమియం రైడర్ అంటే, ఒకవేళ పాలసీదారునికి ఏదైనా ప్రమాదం జరిగి పని చేయలేని పరిస్థితి వస్తే, అప్పుడు కట్టాల్సిన ప్రీమియమ్స్ అన్నీ రద్దవుతాయండి.' },
  { id: '2-tinglish-roman', lang: 'te-IN', text: 'Term life insurance kosam chusthunnara? Mana daggarayite Vaayu LifeShield Secure, Amrit LifeShield Secure options unnayandi.' },
  { id: '3-mixed-numbers', lang: 'te-IN', text: 'Mee age 25 years, 2 crores sum assured ki, Supreme plan premium approx 15,960 rupees padthundhi andi. Taxes extra.' },
  { id: '4-hinglish', lang: 'hi-IN', text: 'Premium details chahie na aapko sir? Main abhi check karke batata hoon.' },
  { id: '5-greeting-en', lang: 'en-IN', text: 'Namaste, I am Aruna from GSK insurance. How can I help you?' },
]

const ms = (t) => `${Date.now() - t}ms`

async function sarvam(text, lang, { telephony }) {
  const t0 = Date.now()
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, target_language_code: lang, model: 'bulbul:v3', speaker: 'priya',
      ...(telephony ? { speech_sample_rate: 8000, output_audio_codec: 'mulaw' } : { speech_sample_rate: 22050 }),
    }),
  })
  const body = await res.json()
  if (!body.audios?.[0]) throw new Error(JSON.stringify(body).slice(0, 300))
  return { ms: Date.now() - t0, buf: Buffer.from(body.audios[0], 'base64'), ext: telephony ? 'ulaw' : 'wav' }
}

async function eleven(text, _lang, { telephony, model = 'eleven_flash_v2_5' }) {
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
  const t0 = Date.now()
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=${telephony ? 'ulaw_8000' : 'mp3_44100_128'}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  // Time to FIRST byte is what a caller feels; total is what the file costs.
  const reader = res.body.getReader()
  const chunks = []
  let ttfb = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttfb === null) ttfb = Date.now() - t0
    chunks.push(Buffer.from(value))
  }
  return { ms: Date.now() - t0, ttfb, buf: Buffer.concat(chunks), ext: telephony ? 'ulaw' : 'mp3' }
}


// Cartesia Sonic. Billed per character (~$35/1M chars) and the fastest of the three
// on paper (sub-90ms claimed, ~166ms median in their own changelog). Supports 9
// Indian languages including Telugu, so it is a candidate for BOTH tiers, not just
// English. Untested here until CARTESIA_API_KEY exists.
async function cartesia(text, lang, { telephony, model = process.env.CARTESIA_TTS_MODEL || 'sonic-3.6' }) {
  const t0 = Date.now()
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
      'Cartesia-Version': process.env.CARTESIA_VERSION || '2026-08-14',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: model,
      transcript: text,
      voice: { id: process.env.CARTESIA_VOICE_ID || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' },
      language: (lang || 'en-IN').split('-')[0],
      output_format: telephony
        ? { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 }
        : { container: 'wav', encoding: 'pcm_s16le', sample_rate: 22050 },
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  const reader = res.body.getReader()
  const chunks = []
  let ttfb = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttfb === null) ttfb = Date.now() - t0
    chunks.push(Buffer.from(value))
  }
  return { ms: Date.now() - t0, ttfb, buf: Buffer.concat(chunks), ext: telephony ? 'ulaw' : 'wav' }
}

const ENGINES = [
  { name: 'sarvam-bulbul-v3', run: sarvam, rate: INR.sarvamPerChar, enabled: !!process.env.SARVAM_API_KEY },
  { name: 'eleven-flash-v2.5', run: eleven, rate: INR.elevenPerChar, enabled: !!process.env.ELEVENLABS_API_KEY },
  { name: 'cartesia-sonic', run: cartesia, rate: INR.cartesiaPerChar, enabled: !!process.env.CARTESIA_API_KEY },
  { name: 'eleven-v3-convo', run: (t, l, o) => eleven(t, l, { ...o, model: 'eleven_v3_conversational' }), rate: INR.elevenPerChar, enabled: !!process.env.ELEVENLABS_API_KEY },
]

const outDir = process.argv[2] || 'voice-bench-out'
mkdirSync(outDir, { recursive: true })
const rows = []

for (const engine of ENGINES) {
  if (!engine.enabled) { console.log(`skip ${engine.name} — no API key`); continue }
  for (const line of LINES) {
    for (const telephony of [false, true]) {
      const label = `${engine.name} ${line.id}${telephony ? ' [8k]' : ''}`
      try {
        const r = await engine.run(line.text, line.lang, { telephony })
        const file = join(outDir, `${line.id}__${engine.name}${telephony ? '__8k' : ''}.${r.ext}`)
        writeFileSync(file, r.buf)
        rows.push({ engine: engine.name, line: line.id, band: telephony ? '8k' : 'hifi', latency: r.ttfb ? `${r.ttfb}/${r.ms}` : `${r.ms}`, chars: line.text.length, inr: +(line.text.length * engine.rate).toFixed(3), file })
        console.log(`✓ ${label} ${r.ttfb ? `ttfb ${r.ttfb}ms, ` : ''}total ${r.ms}ms → ${file}`)
      } catch (e) {
        console.log(`✗ ${label}: ${String(e.message).slice(0, 200)}`)
        rows.push({ engine: engine.name, line: line.id, band: telephony ? '8k' : 'hifi', latency: 'FAILED', chars: line.text.length, inr: 0, file: String(e.message).slice(0, 80) })
      }
    }
  }
}

console.log('\n── Latency (ttfb/total ms) and cost per line ──')
console.table(rows)
const perEngine = {}
for (const r of rows) {
  if (r.latency === 'FAILED') continue
  const e = (perEngine[r.engine] ||= { lines: 0, chars: 0, inr: 0 })
  e.lines++; e.chars += r.chars; e.inr += r.inr
}
// An agent speaks roughly 360 characters per minute of CALL (~40% talk time).
for (const [name, e] of Object.entries(perEngine)) {
  console.log(`${name}: ₹${(360 * (ENGINES.find(x => x.name === name).rate)).toFixed(2)} per call-minute (at ~360 chars/min of call)`)
}
console.log(`\nListen to the 8k files — that is what the caller hears. Files in: ${outDir}`)
