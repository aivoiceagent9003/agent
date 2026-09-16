// scripts/tts-stream-bench.mjs — the latency number that actually matters.
//
// scripts/voice-bench.mjs measures the REST call, which renders the WHOLE line
// before returning (1.2–3.6s — unusable live). In a real pipeline TTS streams: the
// first audio chunk is what the caller waits for. This measures that, over the
// WebSocket, at telephony band (8k µ-law) — the format the caller actually hears.
//
// Usage: node scripts/tts-stream-bench.mjs [outDir]

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'

// Raw µ-law does not open in a normal player. Wrap it as a WAV (format 7, 8kHz mono)
// so the files can just be double-clicked — the whole point is to LISTEN to them.
function mulawWav(pcm) {
  const h = Buffer.alloc(58)
  h.write('RIFF', 0); h.writeUInt32LE(50 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
  h.writeUInt16LE(0, 36)
  h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(pcm.length, 46)
  h.write('data', 50); h.writeUInt32LE(pcm.length, 54)
  return Buffer.concat([h, pcm])
}

const LINES = [
  { id: '1-telugu-script', lang: 'te-IN', text: 'వేవర్ ఆఫ్ ప్రీమియం రైడర్ అంటే, ఒకవేళ పాలసీదారునికి ఏదైనా ప్రమాదం జరిగి పని చేయలేని పరిస్థితి వస్తే, అప్పుడు కట్టాల్సిన ప్రీమియమ్స్ అన్నీ రద్దవుతాయండి.' },
  { id: '2-tinglish-roman', lang: 'te-IN', text: 'Term life insurance kosam chusthunnara? Mana daggarayite Vaayu LifeShield Secure, Amrit LifeShield Secure options unnayandi.' },
  { id: '3-mixed-numbers', lang: 'te-IN', text: 'Mee age 25 years, 2 crores sum assured ki, Supreme plan premium approx 15,960 rupees padthundhi andi. Taxes extra.' },
  { id: '4-hinglish', lang: 'hi-IN', text: 'Premium details chahie na aapko sir? Main abhi check karke batata hoon.' },
  { id: '5-greeting-en', lang: 'en-IN', text: 'Namaste, I am Aruna from GSK insurance. How can I help you?' },
]

function speak(line) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3', {
      headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY },
    })
    const chunks = []
    let t0, ttfb = null, connectedAt = null, idle = null
    const started = Date.now()
    // The documented 'final' event does not arrive from bulbul:v3, so the stream is
    // treated as done once no chunk has landed for 800ms.
    const done = () => { clearTimeout(idle); try { ws.close() } catch {}; resolve({ ttfb, total: Date.now() - t0, connectedAt, buf: Buffer.concat(chunks) }) }

    ws.on('open', () => {
      connectedAt = Date.now() - started
      ws.send(JSON.stringify({ type: 'config', data: {
        language_code: line.lang, speaker: 'priya', model: 'bulbul:v3',
        speech_sample_rate: '8000', output_audio_codec: 'mulaw',
      } }))
      t0 = Date.now()
      ws.send(JSON.stringify({ type: 'text', data: { text: line.text } }))
      ws.send(JSON.stringify({ type: 'flush' }))
    })

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'audio' && m.data?.audio) {
        if (ttfb === null) ttfb = Date.now() - t0
        chunks.push(Buffer.from(m.data.audio, 'base64'))
        clearTimeout(idle); idle = setTimeout(done, 800)
      } else if (m.type === 'error') {
        resolve({ error: m.data?.message || 'error', connectedAt })
        ws.close()
      } else if (m.type === 'event' && m.data?.event_type === 'final') {
        done()
      }
    })
    ws.on('error', (e) => resolve({ error: e.message, connectedAt }))
    setTimeout(() => { try { ws.close() } catch {}; resolve({ error: 'timeout', connectedAt, ttfb, buf: Buffer.concat(chunks) }) }, 20000)
  })
}

const outDir = process.argv[2] || 'voice-bench-out'
mkdirSync(outDir, { recursive: true })
const rows = []
for (const line of LINES) {
  const r = await speak(line)
  if (r.error && !r.buf?.length) { console.log(`✗ ${line.id}: ${r.error}`); rows.push({ line: line.id, ttfb: 'FAILED', note: r.error }); continue }
  const file = join(outDir, `${line.id}__sarvam-ws-8k.wav`)
  if (r.buf?.length) writeFileSync(file, mulawWav(r.buf))
  // 8k µ-law = 8000 bytes per second of speech.
  const speechSec = +(r.buf.length / 8000).toFixed(1)
  rows.push({ line: line.id, wsConnectMs: r.connectedAt, ttfbMs: r.ttfb, totalMs: r.total, speechSec, chars: line.text.length })
  console.log(`✓ ${line.id}: connect ${r.connectedAt}ms, first audio ${r.ttfb}ms, full ${r.total}ms for ${speechSec}s of speech`)
}
console.table(rows)
console.log(`\nFiles: ${outDir} — 8kHz µ-law WAVs: exactly what the caller hears. Just play them.`)
