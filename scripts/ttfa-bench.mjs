// scripts/ttfa-bench.mjs — does a shorter first clause reach the caller's ear sooner?
//
// The engine holds the model's opening words until it has a clause worth speaking
// (createStreamChunker's clauseMinChars, 60 by default). That wait is only worth
// paying if Soniox actually answers a short clause faster than a long one. If its
// time-to-first-audio is flat, the threshold is pure added latency and should drop.
//
// Measures, on ONE warm socket, exactly as a call does:
//   clause sent → first audio byte back
//
// Usage: node scripts/ttfa-bench.mjs [n]

import 'dotenv/config'
import { createTtsSocket } from '../src/services/soniox-tts-stream.js'
import { scriptLanguage } from '../src/services/tts-text.js'

const KEY = process.env.SONIOX_API_KEY
if (!KEY) { console.log('SONIOX_API_KEY is not set'); process.exit(1) }
const MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'
const N = Number(process.argv[2] || 5)

// The same opening sentence cut at different points, so length is the only variable.
const FULL = 'అవును అండి, మన దగ్గర term insurance options చాలానే ఉన్నాయి, ముఖ్యంగా LifeShield అనేది చాలా మంచి plan అండి.'
const CUTS = [
  ['12 chars', 'అవును అండి,'],
  ['25 chars', 'అవును అండి, మన దగ్గర term'],
  ['40 chars', 'అవును అండి, మన దగ్గర term insurance opt'],
  ['60 chars (current)', FULL.slice(0, 60)],
  ['full sentence', FULL],
]

let inFlight = 0
const waiters = []
const acquire = () => inFlight < 2 ? (inFlight++, Promise.resolve()) : new Promise(r => waiters.push(r))
const release = () => { const n = waiters.shift(); if (n) n(); else inFlight-- }

const socket = createTtsSocket({
  apiKey: KEY, model: MODEL, voice: VOICE, acquire, release, retries: 3,
  onError: (m) => console.log(`  tts error: ${m}`),
})
await socket.warm()

/**
 * One clause through the live socket; resolves with ms to the first audio byte AND
 * only once that clause has finished streaming. A long clause holds its concurrency
 * slot for longer, so without waiting here the next measurement inherits this one's
 * queue and every later row looks slower than it is.
 */
function say(text) {
  return new Promise((resolve) => {
    const item = { chunks: [], done: false, cancelled: false, notify: null, firstByteAt: 0 }
    const t0 = Date.now()
    let ttfa = null
    item.notify = () => {
      if (ttfa === null && item.firstByteAt) ttfa = item.firstByteAt - t0
      if (item.done) resolve(ttfa)
    }
    socket.begin(item, scriptLanguage(text))
    socket.push(item, text)
    socket.end(item)
    setTimeout(() => { if (!item.done) { item.done = true; resolve(ttfa) } }, 15000)
  })
}

// One throwaway request so the first measurement is not a cold model load.
await say('ఒక్క నిమిషం.')

const med = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

console.log(`tts ${MODEL}/${VOICE} · one warm socket · n=${N}\n`)
// Round-robin rather than all of one length then all of the next, so a drift in
// Soniox's own latency during the run cannot masquerade as an effect of length.
const collected = new Map(CUTS.map(([label]) => [label, []]))
for (let i = 0; i < N; i++) {
  for (const [label, text] of CUTS) {
    collected.get(label).push(await say(text))
    await new Promise(r => setTimeout(r, 300))
  }
}

console.log('  first clause            ttfa    spread')
const rows = []
for (const [label] of CUTS) {
  const runs = collected.get(label)
  const m = med(runs)
  rows.push([label, m])
  const ok = runs.filter(n => n != null)
  console.log(`  ${label.padEnd(22)} ${String(m ?? '-').padStart(4)}ms   (${ok.length ? `${Math.min(...ok)}–${Math.max(...ok)}` : 'all failed'})`)
}
socket.close()

const short = rows[0][1]
const long = rows[rows.length - 1][1]
console.log(`
A 12-character clause answered in ${short}ms, a full sentence in ${long}ms.
${Math.abs(long - short) < 80
    ? 'Time-to-first-audio is essentially FLAT in input length, so holding the model back\nfor a longer clause buys nothing — the chunker threshold is pure latency.'
    : 'Time-to-first-audio scales with input length, so a shorter opening clause is a real\nwin on top of sending it sooner.'}`)
