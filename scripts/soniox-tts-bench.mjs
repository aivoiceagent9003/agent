// scripts/soniox-tts-bench.mjs — does normalizeForTts stop Soniox saying "chukka"?
//
// Soniox TTS reads a Telugu full stop aloud as "chukka" (dot). This renders real
// agent replies twice — as the model wrote them, and through normalizeForTts (one
// request per sentence, silence between) — then LISTENS to its own output with
// Soniox STT, so a spoken punctuation mark is caught automatically rather than by
// ear. Audio is saved too, so you can confirm by listening.
//
// Usage: node scripts/soniox-tts-bench.mjs [outDir]
// Needs SONIOX_API_KEY. Optional: SONIOX_TTS_VOICE, SONIOX_TTS_MODEL, SONIOX_STT_MODEL.

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { normalizeForTts } from '../src/services/tts-text.js'

if (!process.env.SONIOX_API_KEY) {
  console.log('SONIOX_API_KEY is not set in .env')
  process.exit(1)
}

const KEY = process.env.SONIOX_API_KEY
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const STT_MODEL = process.env.SONIOX_STT_MODEL || 'stt-rt-v5'
const VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'
const outDir = process.argv[2] || 'voice-bench-out/soniox'
mkdirSync(outDir, { recursive: true })

// Real agent replies, chosen for the punctuation that trips engines up.
const LINES = [
  { id: 't1-full-stops', text: 'సరే అండి. GSK ఇన్సూరెన్స్ గురించి ఇంకేమైనా తెలుసుకోవాలనుకుంటే ఎప్పుడైనా కాల్ చేయండి. థాంక్యూ అండి, బాయ్.' },
  { id: 't2-rupees', text: 'Supreme ప్లాన్ కి సుమారుగా ₹15,960 పడుతుంది అండి. టాక్సెస్ ఎక్స్ట్రా.' },
  { id: 't3-decimal-percent', text: 'మా claim settlement ratio 98.4% అండి. ఇంకా ఏమైనా డౌట్స్ ఉన్నాయా?' },
  { id: 't4-glued-ellipsis', text: 'అవునండి.ఇందులో రైడర్స్ కూడా ఉన్నాయి... క్రిటికల్ ఇల్నెస్, యాక్సిడెంటల్ డెత్ బెనిఫిట్.' },
  { id: 't5-rs-abbrev', text: 'Rs.8,400 approx. అండి, 25 ఏళ్ల వయసుకి.' },
]

// Words that mean a punctuation mark or symbol was SPOKEN instead of obeyed.
const LEAKS = ['చుక్క', 'chukka', 'డాట్', ' dot', 'ఫుల్ స్టాప్', 'full stop', 'ప్రశ్నార్థకం', 'question mark', 'కామా', 'comma', 'రూపాయి గుర్తు']

function mulawWav(pcm) {
  const h = Buffer.alloc(58)
  h.write('RIFF', 0); h.writeUInt32LE(50 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
  h.writeUInt16LE(0, 36); h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(pcm.length, 46)
  h.write('data', 50); h.writeUInt32LE(pcm.length, 54)
  return Buffer.concat([h, pcm])
}
// 0xFF is silence in µ-law. 250ms between sentences = the pause the "." was for.
const GAP = Buffer.alloc(2000, 0xff)

async function tts(text) {
  const t0 = Date.now()
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, language: 'te', voice: VOICE, text, audio_format: 'pcm_mulaw', sample_rate: 8000 }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status} ${(await res.text()).slice(0, 200)}`)
  return { buf: Buffer.from(await res.arrayBuffer()), ms: Date.now() - t0 }
}

function stt(mulaw) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    let text = ''
    ws.on('open', () => {
      ws.send(JSON.stringify({ api_key: KEY, model: STT_MODEL, audio_format: 'mulaw', sample_rate: 8000, num_channels: 1, language_hints: ['te', 'en'] }))
      for (let i = 0; i < mulaw.length; i += 1600) ws.send(mulaw.subarray(i, i + 1600))
      ws.send(Buffer.alloc(0))   // empty frame = end of audio
    })
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.error_code || m.error_message) { ws.close(); reject(new Error(`STT ${m.error_code}: ${m.error_message}`)); return }
      for (const tok of m.tokens || []) if (tok.is_final) text += tok.text
      if (m.finished) { ws.close(); resolve(text.trim()) }
    })
    ws.on('error', (e) => reject(e))
    setTimeout(() => { try { ws.close() } catch {}; resolve(text.trim()) }, 30000)
  })
}

const leaksIn = (s) => LEAKS.filter(w => s.toLowerCase().includes(w.toLowerCase()))

const VARIANTS = [
  { name: 'raw', render: async (text) => (await tts(text)).buf },
  {
    name: 'normalized',
    render: async (text) => {
      const parts = []
      for (const sentence of normalizeForTts(text)) { parts.push((await tts(sentence)).buf, GAP) }
      return Buffer.concat(parts)
    },
  },
]

const rows = []
for (const line of LINES) {
  console.log(`\n── ${line.id}\n   text      : ${line.text}\n   normalized: ${JSON.stringify(normalizeForTts(line.text))}`)
  for (const v of VARIANTS) {
    try {
      const audio = await v.render(line.text)
      writeFileSync(join(outDir, `${line.id}__${v.name}.wav`), mulawWav(audio))
      const heard = await stt(audio)
      const leaks = leaksIn(heard)
      rows.push({ line: line.id, variant: v.name, spokenPunctuation: leaks.length ? leaks.join(', ') : 'none' })
      console.log(`   ${v.name.padEnd(10)}: ${leaks.length ? '❌ SPOKE ' + leaks.join(', ') : '✅ clean'}  — heard: ${heard}`)
    } catch (e) {
      rows.push({ line: line.id, variant: v.name, spokenPunctuation: `ERROR ${String(e.message).slice(0, 60)}` })
      console.log(`   ${v.name.padEnd(10)}: ERROR ${e.message}`)
    }
  }
}

console.log('\n── Spoken punctuation, raw vs normalized ──')
console.table(rows)
console.log(`Audio in ${outDir} — compare *__raw.wav with *__normalized.wav.`)
