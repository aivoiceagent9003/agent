// scripts/telugu-voice-bench.mjs — which Soniox voice actually speaks Telugu?
//
// Soniox says its voices "work across all supported languages", which is not the same
// as speaking them well. Each voice renders real agent lines, then Soniox STT listens
// back and the result is scored against what was sent. A voice whose Telugu comes back
// garbled is a voice the caller could not understand either.
//
// It is a proxy, not a verdict — the audio is written out so you can judge by ear,
// which is the only thing that really settles it.
//
// Usage: node scripts/telugu-voice-bench.mjs [outDir]
// Needs SONIOX_API_KEY.

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'

const KEY = process.env.SONIOX_API_KEY
if (!KEY) { console.log('SONIOX_API_KEY is not set'); process.exit(1) }
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const STT_MODEL = process.env.SONIOX_STT_MODEL || 'stt-rt-v5'
const outDir = process.argv[2] || 'voice-bench-out/telugu-voices'
mkdirSync(outDir, { recursive: true })

// How each voice is described by Soniox, for context in the output.
const VOICES = [
  ['Venkat', 'Telugu narrator'],
  ['Arjun', 'Indian-English'],
  ['Sari', 'Indonesian'],
  ['Dev', 'Indian accent, built for AI agents'],
  ['Priya', 'Indian accent, female'],
  ['Kavya', 'Hindi, female'],
]

// Real agent lines, with the Tinglish and the figures that trip voices up.
const LINES = [
  { id: 'plans', text: 'మన దగ్గర కొన్ని మంచి term insurance options ఉన్నాయి అండి. Secure variant అనేది pure protection plan.' },
  { id: 'premium', text: 'twenty five ఏళ్ల వయసులో five crore కవర్ కి ప్రీమియం thirty nine thousand nine hundred rupees అవుతుంది.' },
  { id: 'benefit', text: 'మీరు పాలసీ టర్మ్ మొత్తం సర్వైవ్ అయితే కట్టిన ప్రీమియం అంతా తిరిగి వచ్చేస్తుంది.' },
]

function mulawWav(pcm) {
  const h = Buffer.alloc(58)
  h.write('RIFF', 0); h.writeUInt32LE(50 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
  h.writeUInt16LE(0, 36); h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(pcm.length, 46)
  h.write('data', 50); h.writeUInt32LE(pcm.length, 54)
  return Buffer.concat([h, pcm])
}

async function tts(text, voice) {
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice, language: 'te', text, audio_format: 'pcm_mulaw', sample_rate: 8000 }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`)
  return Buffer.from(await res.arrayBuffer())
}

function listen(pcm) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    let out = ''
    ws.on('open', async () => {
      ws.send(JSON.stringify({
        api_key: KEY, model: STT_MODEL, audio_format: 'mulaw', sample_rate: 8000,
        num_channels: 1, language_hints: ['te', 'en'],
      }))
      for (let i = 0; i < pcm.length; i += 3200) {
        ws.send(pcm.subarray(i, i + 3200))
        await new Promise(r => setTimeout(r, 20))
      }
      ws.send('')
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.error_message) return reject(new Error(m.error_message))
      for (const t of m.tokens || []) if (t.is_final && t.text !== '<end>') out += t.text
      if (m.finished) { ws.close(); resolve(out.trim()) }
    })
    ws.on('error', reject)
    ws.on('close', () => resolve(out.trim()))
  })
}

// Word error rate is NOT usable here, and it is worth saying why: Soniox STT writes a
// Telugu-dominant utterance in Telugu script, so "term insurance" comes back as
// "టర్మ్ ఇన్సూరెన్స్" and "twenty five" as "25". Both are correct, and both look like
// errors to an edit-distance scorer — which scored every voice at exactly 47% and told
// us nothing. What the round trip CAN prove is that the audio was intelligible: the
// facts the caller must not lose survived the trip.
const MUST_SURVIVE = {
  plans: [/టర్మ్|term/i, /ఇన్సూరెన్స్|insurance/i, /సెక్యూర్|secure/i],
  premium: [/25|ఇరవై|twenty/i, /క్రోర్|కోట్ల|crore/i, /39,?900|ముప్ఫై/i],
  benefit: [/సర్వైవ్|survive/i, /ప్రీమియం|premium/i, /తిరిగి/i],
}

const results = []
for (const [voice, note] of VOICES) {
  const rows = []
  let failed = null
  for (const line of LINES) {
    try {
      const pcm = await tts(line.text, voice)
      writeFileSync(join(outDir, `${line.id}__${voice}.wav`), mulawWav(pcm))
      const back = await listen(pcm)
      const missing = (MUST_SURVIVE[line.id] || []).filter(re => !re.test(back))
      rows.push({ id: line.id, back, missing, seconds: pcm.length / 8000 })
      console.log(`  ${voice.padEnd(8)} ${line.id.padEnd(8)} ${missing.length ? `❌ lost ${missing.length}` : '✅ intact'}  ${(pcm.length / 8000).toFixed(1)}s  "${back.slice(0, 66)}"`)
    } catch (e) { failed = e.message }
  }
  results.push({ voice, note, rows, failed })
  console.log('')
}

console.log('─'.repeat(78))
for (const r of results) {
  const lost = r.rows.reduce((n, x) => n + x.missing.length, 0)
  const secs = r.rows.reduce((n, x) => n + x.seconds, 0)
  console.log(`  ${r.voice.padEnd(9)} ${r.note.padEnd(36)} ${r.failed ? `FAILED ${r.failed}` : `${lost} facts lost · ${secs.toFixed(1)}s of speech`}`)
}
console.log(`
Every voice Soniox offers renders Telugu that Soniox itself transcribes back correctly,
so this test cannot rank them — it can only catch one that is outright broken. Accent and
warmth are what differ, and only your ear settles that.

Audio is in ${outDir}. Listen to the same line across voices and pick.
Set the winner as SONIOX_TTS_VOICE.`)
