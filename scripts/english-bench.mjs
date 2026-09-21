// scripts/english-bench.mjs — which vendor can run the ENGLISH tier?
//
// Case 1 of the two-tier plan: English-speaking clients on one vendor for STT + TTS.
// A greeting transcribed perfectly proves nothing; what decides it is whether rupee
// amounts, customer IDs, plan names and phone numbers survive — on Indian-accented
// English, at 8kHz telephony band.
//
// Method: render each line with an en-IN TTS voice (Indian accent, 8k µ-law — what a
// caller actually sounds like), feed that same audio to every STT, and score the
// transcripts against what was said. Each TTS renders the line too, so its latency
// and its voice can be compared on identical text.
//
// Synthetic speech is CLEANER than a real phone call, so treat these as a ceiling:
// if a token fails here it will fail worse live.
//
// Usage: node scripts/english-bench.mjs [outDir]
// Engines switch themselves on when their key is present:
//   CARTESIA_API_KEY    → Ink (STT) + Sonic (TTS)
//   ELEVENLABS_API_KEY  → Scribe v2 (STT) + Flash v2.5 and v3 Conversational (TTS)

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ENGLISH } from './bench-lines.mjs'

const V = process.env.CARTESIA_VERSION || '2026-08-14'
const outDir = process.argv[2] || 'voice-bench-out/english'
mkdirSync(outDir, { recursive: true })

// ── Audio helpers ───────────────────────────────────────────────────────────
function mulawWav(pcm) {
  const h = Buffer.alloc(58)
  h.write('RIFF', 0); h.writeUInt32LE(50 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
  h.writeUInt16LE(0, 36); h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(pcm.length, 46)
  h.write('data', 50); h.writeUInt32LE(pcm.length, 54)
  return Buffer.concat([h, pcm])
}
// Some STT APIs take a file upload rather than raw frames — give them linear PCM.
const MULAW = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  MULAW[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function pcm16Wav(mulaw, rate = 8000) {
  const pcm = Buffer.alloc(mulaw.length * 2)
  for (let i = 0; i < mulaw.length; i++) pcm.writeInt16LE(MULAW[mulaw[i]], i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

// ── Scoring ─────────────────────────────────────────────────────────────────
// Numbers are the point of this test, so "15,960" and "fifteen thousand nine hundred
// and sixty" must not count as errors against each other — compare on VALUE.
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
function canon(s) {
  const words = String(s || '').toLowerCase().replace(/[.,?!;:"'()%-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  const out = []
  let cur = 0, total = 0, active = false
  const flush = () => { if (active) { out.push(String(total + cur)); total = 0; cur = 0; active = false } }
  for (const w of words) {
    if (w in NUM) { cur += NUM[w]; active = true; continue }
    if (w === 'hundred') { cur = (cur || 1) * 100; active = true; continue }
    if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; active = true; continue }
    if (w === 'lakh' || w === 'lakhs') { total += (cur || 1) * 100000; cur = 0; active = true; continue }
    if (w === 'crore' || w === 'crores') { total += (cur || 1) * 10000000; cur = 0; active = true; continue }
    if (w === 'and' && active) continue
    flush()
    if (/^\d[\d,.]*$/.test(w)) { out.push(w.replace(/,/g, '')); continue }
    if (w === 'percent') continue   // "98.4%" and "98.4 percent" are the same thing
    out.push(w)
  }
  flush()
  return out
}
function wer(ref, hyp) {
  const r = canon(ref), h = canon(hyp)
  if (!r.length) return null
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  }
  return Math.round((d[r.length][h.length] / r.length) * 100)
}

// ── The caller's voice: Sarvam en-IN, so every STT hears the same audio ─────
async function indianVoice(text) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: 'en-IN', model: 'bulbul:v3', speaker: 'priya', speech_sample_rate: 8000, output_audio_codec: 'mulaw' }),
  })
  const body = await res.json()
  if (!body.audios?.[0]) throw new Error(JSON.stringify(body).slice(0, 200))
  return Buffer.from(body.audios[0], 'base64')
}

// ── TTS engines ─────────────────────────────────────────────────────────────
async function sonic(text) {
  const t0 = Date.now()
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`, 'Cartesia-Version': V, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: process.env.CARTESIA_TTS_MODEL || 'sonic-3.6',
      transcript: text,
      voice: { id: process.env.CARTESIA_VOICE_ID || 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4' },
      language: 'en',
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return readStream(res, t0)
}

async function elevenTts(text, model) {
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'
  const t0 = Date.now()
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=ulaw_8000`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return readStream(res, t0)
}

// Time to FIRST byte is what a caller feels; total is how long the line took.
async function readStream(res, t0) {
  const reader = res.body.getReader()
  const chunks = []
  let ttfb = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttfb === null) ttfb = Date.now() - t0
    chunks.push(Buffer.from(value))
  }
  return { ttfb, total: Date.now() - t0, buf: Buffer.concat(chunks) }
}

// ── STT engines ─────────────────────────────────────────────────────────────
async function ink(mulaw) {
  const { default: WebSocket } = await import('ws')
  const qs = new URLSearchParams({ model: process.env.CARTESIA_STT_MODEL || 'ink-whisper', encoding: 'pcm_mulaw', sample_rate: '8000', cartesia_version: V, language: 'en' })
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${qs}`, { headers: { 'X-API-Key': process.env.CARTESIA_API_KEY } })
    let text = '', idle = null
    const finish = () => { clearTimeout(idle); try { ws.close() } catch {}; resolve({ ms: Date.now() - t0, text: text.trim() }) }
    ws.on('open', () => {
      for (let i = 0; i < mulaw.length; i += 800) ws.send(mulaw.subarray(i, i + 800))
      ws.send('finalize')
    })
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'transcript' && m.text && m.is_final) { text = (text + ' ' + m.text).trim(); clearTimeout(idle); idle = setTimeout(finish, 1200) }
      else if (m.type === 'error') { try { ws.close() } catch {}; reject(new Error(m.message || 'error')) }
      else if (m.type === 'done') finish()
    })
    ws.on('error', (e) => reject(new Error(e.message)))
    setTimeout(finish, 25000)
  })
}

async function scribe(mulaw) {
  const t0 = Date.now()
  const form = new FormData()
  form.append('file', new Blob([pcm16Wav(mulaw)], { type: 'audio/wav' }), 'audio.wav')
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v2')
  form.append('language_code', 'eng')
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return { ms: Date.now() - t0, text: body.text ?? '' }
}

const HAS_CARTESIA = !!process.env.CARTESIA_API_KEY
const HAS_ELEVEN = !!process.env.ELEVENLABS_API_KEY

const TTS = [
  { name: 'cartesia-sonic', on: HAS_CARTESIA, run: sonic, inrPerChar: 3.36 / 1000 },
  { name: 'eleven-flash-v2.5', on: HAS_ELEVEN, run: (t) => elevenTts(t, 'eleven_flash_v2_5'), inrPerChar: 4.8 / 1000 },
  { name: 'eleven-v3-convo', on: HAS_ELEVEN, run: (t) => elevenTts(t, 'eleven_v3_conversational'), inrPerChar: 4.8 / 1000 },
]
const STT = [
  { name: 'cartesia-ink', on: HAS_CARTESIA, run: ink },
  { name: 'eleven-scribe-v2', on: HAS_ELEVEN, run: scribe },
]

for (const e of [...TTS, ...STT]) if (!e.on) console.log(`skip ${e.name} — no API key`)

const ttsRows = []
const sttRows = []
const errors = []

for (const line of ENGLISH) {
  // 1. Every TTS renders the line — latency, cost, and a file to listen to.
  for (const e of TTS) {
    if (!e.on) continue
    try {
      const r = await e.run(line.text)
      writeFileSync(join(outDir, `${line.id}__${e.name}-8k.wav`), mulawWav(r.buf))
      ttsRows.push({ engine: e.name, line: line.id, ttfbMs: r.ttfb, totalMs: r.total, inr: +(line.text.length * e.inrPerChar).toFixed(3) })
    } catch (err) {
      ttsRows.push({ engine: e.name, line: line.id, ttfbMs: 'FAIL', totalMs: String(err.message).slice(0, 60), inr: 0 })
      console.log(`✗ ${e.name} ${line.id}: ${String(err.message).slice(0, 160)}`)
    }
  }

  // 2. One caller-voice rendering, transcribed by every STT.
  let audio
  try {
    audio = await indianVoice(line.text)
    writeFileSync(join(outDir, `${line.id}__spoken-en-IN-8k.wav`), mulawWav(audio))
  } catch (err) { console.log(`✗ caller voice ${line.id}: ${err.message}`); continue }

  console.log(`\n${line.id}\n  said : ${line.text}`)
  for (const e of STT) {
    if (!e.on) continue
    try {
      const r = await e.run(audio)
      const score = wer(line.text, r.text)
      sttRows.push({ engine: e.name, line: line.id, ms: r.ms, wer: score })
      console.log(`  ${e.name.padEnd(18)} WER ${String(score).padStart(3)}%  ${r.text}`)
      if (score > 0) errors.push({ engine: e.name, id: line.id, said: line.text, heard: r.text, wer: score })
    } catch (err) {
      sttRows.push({ engine: e.name, line: line.id, ms: null, wer: 'FAIL' })
      console.log(`  ${e.name.padEnd(18)} FAILED: ${String(err.message).slice(0, 160)}`)
    }
  }
}

const avg = (rows, key, engine) => {
  const v = rows.filter(r => r.engine === engine && typeof r[key] === 'number').map(r => r[key])
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
}

console.log('\n── TTS: latency and cost ──')
console.table(TTS.filter(e => e.on).map(e => ({
  engine: e.name,
  avgTtfbMs: avg(ttsRows, 'ttfbMs', e.name),
  avgTotalMs: avg(ttsRows, 'totalMs', e.name),
  // An agent speaks roughly 300 characters per minute of CALL (~40% talk time).
  inrPerCallMin: +(300 * e.inrPerChar).toFixed(2),
})))

console.log('\n── STT: accuracy on Indian-accented English ──')
console.table(STT.filter(e => e.on).map(e => {
  const mine = sttRows.filter(r => r.engine === e.name && typeof r.wer === 'number')
  return {
    engine: e.name,
    avgWer: avg(sttRows, 'wer', e.name),
    perfectLines: `${mine.filter(r => r.wer === 0).length}/${mine.length}`,
    avgMs: avg(sttRows, 'ms', e.name),
  }
}))

if (errors.length) {
  console.log('\n── Every error, by engine (this is what would go wrong on a call) ──')
  for (const e of STT.filter(x => x.on)) {
    const mine = errors.filter(x => x.engine === e.name)
    if (!mine.length) { console.log(`\n${e.name}: no errors`); continue }
    console.log(`\n${e.name}:`)
    for (const w of mine) console.log(`  [${w.wer}%] ${w.id}\n    said : ${w.said}\n    heard: ${w.heard}`)
  }
}
console.log(`\nAudio in ${outDir} — *__spoken-en-IN-8k.wav is the STT input; the rest are each TTS voice.`)
