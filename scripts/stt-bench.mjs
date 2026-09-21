// scripts/stt-bench.mjs — which STT can actually hear your callers.
//
// STT is the risky half of a cascaded pipeline: whatever it gets wrong, the agent
// answers wrong. Today's S2S logs show Telugu being transcribed as Italian and
// Korean — harmless now (Gemini hears the real audio), fatal in a pipeline where
// text is the only input.
//
// Input: 8kHz µ-law WAVs (telephony band) plus the reference text of each.
// By default it reads what the TTS bench produced. That is SYNTHETIC audio — clean,
// no background noise, no phone codec artefacts on a human voice — so treat the
// numbers as a ceiling. The honest test is real call recordings:
//   node scripts/stt-bench.mjs <dir-of-recordings> <manifest.json>
// where manifest.json is { "<file>": "<what was actually said>" }.
//
// Usage: node scripts/stt-bench.mjs [audioDir] [manifest.json]

import 'dotenv/config'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { LINES } from './bench-lines.mjs'

// ── µ-law → PCM16, so every vendor gets the same linear audio ────────────────
const MULAW = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  let t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  MULAW[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function wavPcm16(mulawBytes, rate = 8000) {
  const pcm = Buffer.alloc(mulawBytes.length * 2)
  for (let i = 0; i < mulawBytes.length; i++) pcm.writeInt16LE(MULAW[mulawBytes[i]], i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}
// Strip the WAV header off a µ-law file written by tts-stream-bench.mjs.
function mulawPayload(buf) {
  const i = buf.indexOf('data')
  return i > 0 ? buf.subarray(i + 8) : buf
}

// ── Word error rate (Levenshtein over words) ─────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[.,?!;:।॥"'()]/g, '').replace(/\s+/g, ' ').trim()
function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean), h = norm(hyp).split(' ').filter(Boolean)
  if (!r.length) return null
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  }
  return Math.round((d[r.length][h.length] / r.length) * 100)
}

// ── Engines ──────────────────────────────────────────────────────────────────
async function deepgram(wav, { lang }) {
  const t0 = Date.now()
  const res = await fetch(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=${lang}`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
    body: wav,
  })
  const body = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 200))
  return { ms: Date.now() - t0, text: body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '' }
}

async function sarvamSTT(wav, { model, lang, translate }) {
  const t0 = Date.now()
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  if (!translate && lang) form.append('language_code', lang)
  const res = await fetch(`https://api.sarvam.ai/speech-to-text${translate ? '-translate' : ''}`, {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
    body: form,
  })
  const body = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 200))
  return { ms: Date.now() - t0, text: body.transcript ?? '', extra: body.language_code || '' }
}


// Cartesia Ink — websocket only. Cheapest STT of the three (~$0.0022/min) and ships
// native turn detection, which is exactly the piece a cascaded pipeline has to build
// by hand. Audio goes up as raw µ-law binary chunks; 'finalize' closes the utterance.
async function cartesiaSTT(mulaw, { model = process.env.CARTESIA_STT_MODEL || 'ink-whisper', lang = 'en' }) {
  const { default: WebSocket } = await import('ws')
  const qs = new URLSearchParams({
    model, encoding: 'pcm_mulaw', sample_rate: '8000',
    cartesia_version: process.env.CARTESIA_VERSION || '2026-08-14',
    language: lang,
  })
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${qs}`, {
      headers: { 'X-API-Key': process.env.CARTESIA_API_KEY },
    })
    let text = '', idle = null
    const finish = () => { clearTimeout(idle); try { ws.close() } catch {} ; resolve({ ms: Date.now() - t0, text: text.trim() }) }
    const fail = (e) => { try { ws.close() } catch {} ; reject(new Error(String(e).slice(0, 200))) }
    ws.on('open', () => {
      // ~100ms of 8k µ-law per chunk, as the docs ask for.
      for (let i = 0; i < mulaw.length; i += 800) ws.send(mulaw.subarray(i, i + 800))
      ws.send('finalize')
    })
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'transcript' && m.text) {
        text = m.is_final ? (text + ' ' + m.text).trim() : text
        clearTimeout(idle); idle = setTimeout(finish, 1200)
      }
      else if (m.type === 'error') fail(m.message || 'error')
      else if (m.type === 'done') finish()
    })
    ws.on('error', (e) => fail(e.message))
    setTimeout(() => { try { ws.close() } catch {} ; resolve({ ms: Date.now() - t0, text: text.trim() }) }, 20000)
  })
}

const ENGINES = [
  { name: `cartesia-${process.env.CARTESIA_STT_MODEL || 'ink-whisper'}`, on: !!process.env.CARTESIA_API_KEY, run: (w, l, raw) => cartesiaSTT(raw, { lang: (l.lang || 'en-IN').split('-')[0] }) },
  { name: 'deepgram-nova3-multi', on: !!process.env.DEEPGRAM_API_KEY, run: (w) => deepgram(w, { lang: 'multi' }) },
  { name: 'deepgram-nova3-en', on: !!process.env.DEEPGRAM_API_KEY, run: (w) => deepgram(w, { lang: 'en' }) },
  { name: `sarvam-${process.env.SARVAM_STT_MODEL || 'saarika:v2.5'}`, on: !!process.env.SARVAM_API_KEY, run: (w, l) => sarvamSTT(w, { model: process.env.SARVAM_STT_MODEL || 'saarika:v2.5', lang: l.lang }) },
  { name: `sarvam-${process.env.SARVAM_TRANSLATE_MODEL || 'saaras:v2.5'}-translate`, on: !!process.env.SARVAM_API_KEY, run: (w) => sarvamSTT(w, { model: process.env.SARVAM_TRANSLATE_MODEL || 'saaras:v2.5', translate: true }) },
]

const audioDir = process.argv[2] || 'voice-bench-out'
const manifestPath = process.argv[3]
const manifest = manifestPath && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null

const files = readdirSync(audioDir).filter(f => f.endsWith('.wav') && (manifest ? manifest[f] : f.includes('sarvam-ws-8k')))
if (!files.length) { console.log(`no audio in ${audioDir}`); process.exit(0) }
if (!manifest) console.log('⚠️  Synthetic TTS audio — clean speech, no phone noise. Real recordings will score worse.\n')

const rows = []
for (const file of files) {
  const id = basename(file).split('__')[0]
  const line = LINES.find(l => l.id === id)
  const reference = manifest ? manifest[file] : line?.text
  const raw = readFileSync(join(audioDir, file))
  const wav = wavPcm16(mulawPayload(raw))
  console.log(`\n── ${file}\n   said: ${reference}`)
  for (const e of ENGINES) {
    if (!e.on) continue
    try {
      const r = await e.run(wav, line || { lang: 'te-IN' }, mulawPayload(raw))
      const score = wer(reference, r.text)
      rows.push({ file: id, engine: e.name, ms: r.ms, wer: score, chars: r.text.length })
      console.log(`   ${e.name.padEnd(34)} ${String(r.ms).padStart(5)}ms  WER ${score === null ? '—' : score + '%'}  "${r.text.slice(0, 110)}"`)
    } catch (err) {
      rows.push({ file: id, engine: e.name, ms: null, wer: null, chars: 0 })
      console.log(`   ${e.name.padEnd(34)} FAILED: ${String(err.message).slice(0, 140)}`)
    }
  }
}
console.log('\n── Summary (lower WER is better) ──')
console.table(rows)
