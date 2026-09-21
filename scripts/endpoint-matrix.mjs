// scripts/endpoint-matrix.mjs — can level 0 be tuned further WITHOUT cutting callers off?
//
// endpoint-bench.mjs established that Soniox's default (level 0) is the fastest of the
// latency-adjustment levels, at ~830-860ms. This asks the narrower question: with level
// pinned at 0, do `endpoint_sensitivity` and `max_endpoint_delay_ms` buy anything?
//
// Latency alone cannot answer that. A setting that fires early looks excellent on a
// median and is unusable on a phone, because it turns
//
//     "Yes, I am interested."        into   "Yes."
//     "నేను actually అనుకుంటున్నది…"   into   "నేను."
//
// which does not save a second — it splits one turn into two and makes the agent answer
// half a sentence. So every configuration is scored on CORRECTNESS FIRST, and latency is
// only compared among the ones that pass.
//
// The corpus deliberately contains MID-SENTENCE PAUSES, because that is the case an
// endpointer gets wrong. A caller who says "I was thinking..." and pauses 600ms to
// think has not finished talking.
//
// Usage: node scripts/endpoint-matrix.mjs [reps]

import 'dotenv/config'
import WebSocket from 'ws'

const KEY = process.env.SONIOX_API_KEY
if (!KEY) { console.log('SONIOX_API_KEY is not set'); process.exit(1) }
const STT_MODEL = process.env.SONIOX_STT_MODEL || 'stt-rt-v5'
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'
const REPS = Number(process.argv[2] || 2)

// Real AnswerLabs conversation shapes across every language a Hyderabad number takes.
// `pause` splits the utterance in two and inserts that many ms of silence, which is the
// natural hesitation an endpointer must NOT treat as the end of a turn.
// `must` are the facts that have to survive: Soniox rewrites script freely (English
// inside a Telugu turn comes back in Telugu letters), so an edit-distance score would
// measure transliteration rather than hearing. These check the content survived.
const CORPUS = [
  // ── English ──
  { id: 'en-yes', lang: 'en', text: 'Yes.', must: [/yes/i] },
  { id: 'en-interested', lang: 'en', text: 'Yes, I am interested.', must: [/yes/i, /interest/i] },
  { id: 'en-property', lang: 'en', text: 'Yes, I am interested in the property.', must: [/yes/i, /interest/i, /propert/i] },
  {
    id: 'en-hesitate', lang: 'en', pause: 600,
    text: 'Actually I was thinking,', tail: ' maybe somewhere around Gachibowli.',
    must: [/think/i, /gachibowli|gachi/i],
  },
  { id: 'en-loan', lang: 'en', text: 'I need a home loan for around thirty lakhs.', must: [/loan/i, /thirty|30/i] },

  // ── Telugu ──
  { id: 'te-avunu', lang: 'te', text: 'అవును.', must: [/అవును|avunu/i] },
  { id: 'te-interest', lang: 'te', text: 'అవునండి, నాకు ఇంట్రెస్ట్ ఉంది.', must: [/అవును/, /ఇంట్రెస్ట్|interest/i] },
  { id: 'te-3bhk', lang: 'te', text: 'నాకు గచ్చిబౌలిలో త్రీ బీహెచ్‌కే కావాలి.', must: [/గచ్చిబౌలి|gachibowli/i, /బీహెచ్|bhk/i] },
  {
    id: 'te-hesitate', lang: 'te', pause: 600,
    text: 'నేను actually అనుకుంటున్నది,', tail: ' ఒక మంచి term insurance plan.',
    must: [/అనుకుంటున్న/, /insurance|ఇన్సూరెన్స్/i],
  },

  // ── Hindi ──
  { id: 'hi-haan', lang: 'hi', text: 'हाँ.', must: [/हाँ|हां|haan/i] },
  { id: 'hi-interest', lang: 'hi', text: 'हाँ जी, मुझे इंटरेस्ट है.', must: [/हाँ|हां/, /इंटरेस्ट|interest/i] },
  { id: 'hi-loan', lang: 'hi', text: 'मुझे लगभग तीस लाख का होम लोन चाहिए.', must: [/लोन|loan/i, /तीस|30/i] },

  // ── Code-mixed, which is how these calls actually sound ──
  { id: 'tinglish-1', lang: 'te', text: 'అవునండి, నాకు property మీద interest ఉంది.', must: [/property|ప్రాపర్టీ/i, /interest|ఇంట్రెస్ట్/i] },
  { id: 'tinglish-2', lang: 'te', text: 'Budget around one crore వరకు చూస్తున్నాను.', must: [/budget|బడ్జెట్/i, /crore|కోటి|కోట్ల/i] },
  { id: 'hinglish-1', lang: 'hi', text: 'Haan ji, mujhe property mein interest hai.', must: [/property|प्रॉपर्टी/i, /interest|इंटरेस्ट/i] },
  { id: 'hinglish-2', lang: 'hi', text: 'Budget around one crore hai.', must: [/budget|बजट/i, /crore|करोड़/i] },
]

// Level stays at 0 — it is the measured winner and this is not re-litigating it.
const CONFIGS = [
  { id: 'BASELINE (bare level 0)', level: 0 },
  { id: 'sens 0.1 / cap 1500', level: 0, sens: 0.1, maxDelay: 1500 },
  { id: 'sens 0.2 / cap 1500', level: 0, sens: 0.2, maxDelay: 1500 },
  { id: 'sens 0.3 / cap 1500', level: 0, sens: 0.3, maxDelay: 1500 },
  { id: 'sens 0.1 / cap 1000', level: 0, sens: 0.1, maxDelay: 1000 },
  { id: 'sens 0.2 / cap 1000', level: 0, sens: 0.2, maxDelay: 1000 },
]

const FRAME = 160                 // 20ms of 8kHz µ-law
const MULAW_SILENCE = 0xff
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function tts(text, language) {
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: VOICE, language, text, audio_format: 'pcm_mulaw', sample_rate: 8000 }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 140)}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Build one utterance's audio. With `pause`, the head and tail are rendered separately
 * and joined by real silence — a hesitation in the middle of a sentence, not a gap
 * between two sentences.
 * @returns {{pcm: Buffer, speechEndsAt: number}} speechEndsAt = byte offset after which
 *          nothing but trailing silence remains, i.e. the true end of the turn.
 */
async function build(u) {
  const head = await tts(u.text, u.lang)
  if (!u.pause) return { pcm: head, speechEndsAt: head.length, pauseFrom: null, pauseTo: null }
  const tail = await tts(u.tail, u.lang)
  const gap = Buffer.alloc(u.pause * 8, MULAW_SILENCE)
  return {
    pcm: Buffer.concat([head, gap, tail]),
    speechEndsAt: head.length + gap.length + tail.length,
    pauseFrom: head.length,                    // an <end> inside this window is PREMATURE
    pauseTo: head.length + gap.length,
  }
}

/** Stream one utterance in real time and record where the endpoint landed. */
function run(built, cfg, tailMs = 3500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    const sentAt = []
    let streamed = 0, text = '', lastFinalEndMs = 0
    let endpointAt = null, endpointAtBytes = null, settled = false
    const audioMsToWall = (ms) => {
      const target = ms * 8
      for (let i = sentAt.length - 1; i >= 0; i--) if (sentAt[i][0] < target) return (sentAt[i + 1] || sentAt[i])[1]
      return sentAt[0]?.[1] ?? null
    }
    const done = () => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* already gone */ }
      const speechEndWall = lastFinalEndMs ? audioMsToWall(lastFinalEndMs) : null
      resolve({
        text: text.trim(),
        endpointMs: endpointAt && speechEndWall ? endpointAt - speechEndWall : null,
        endpointAtBytes,
        missed: !endpointAt,
      })
    }
    ws.on('open', async () => {
      const config = {
        api_key: KEY, model: STT_MODEL, audio_format: 'mulaw', sample_rate: 8000, num_channels: 1,
        language_hints: ['te', 'hi', 'en'], enable_language_identification: true,
        enable_endpoint_detection: true,
      }
      if (cfg.level !== undefined) config.endpoint_latency_adjustment_level = cfg.level
      if (cfg.sens !== undefined) config.endpoint_sensitivity = cfg.sens
      if (cfg.maxDelay !== undefined) config.max_endpoint_delay_ms = cfg.maxDelay
      ws.send(JSON.stringify(config))
      const silence = Buffer.alloc(FRAME, MULAW_SILENCE)
      const total = built.pcm.length + tailMs * 8
      const t0 = Date.now()
      for (let off = 0; off < total; off += FRAME) {
        const frame = off < built.pcm.length ? built.pcm.subarray(off, off + FRAME) : silence
        if (ws.readyState !== 1 || endpointAt) break
        ws.send(frame)
        streamed += frame.length
        sentAt.push([streamed, Date.now()])
        const due = t0 + (off / FRAME + 1) * 20
        const lag = due - Date.now()
        if (lag > 0) await sleep(lag)
      }
      if (!endpointAt) done()
    })
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.error_message) { settled = true; return reject(new Error(`${m.error_code}: ${m.error_message}`)) }
      for (const tok of m.tokens || []) {
        if (tok.text === '<end>') {
          if (!endpointAt) { endpointAt = Date.now(); endpointAtBytes = streamed }
          continue
        }
        if (tok.is_final) { text += tok.text; if (tok.end_ms) lastFinalEndMs = tok.end_ms }
      }
      if (endpointAt) done()
    })
    ws.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
  })
}

const median = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const pct95 = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null }

console.log(`Rendering ${CORPUS.length} utterances (${VOICE})…`)
const audio = {}
for (const u of CORPUS) {
  audio[u.id] = await build(u)
  console.log(`  ${u.id.padEnd(14)} ${(audio[u.id].pcm.length / 8000).toFixed(2)}s${u.pause ? ` (with a ${u.pause}ms pause mid-sentence)` : ''}`)
}

const LANG_OF = Object.fromEntries(CORPUS.map(u => [u.id, /tinglish/.test(u.id) ? 'tinglish' : /hinglish/.test(u.id) ? 'hinglish' : u.lang]))
const results = []

for (const cfg of CONFIGS) {
  console.log(`\n── ${cfg.id}`)
  const rows = []
  for (const u of CORPUS) {
    for (let i = 0; i < REPS; i++) {
      let r
      try { r = await run(audio[u.id], cfg) } catch (e) { console.log(`  ${u.id.padEnd(14)} FAILED ${e.message}`); continue }
      const built = audio[u.id]
      // PREMATURE: the endpoint fired during the mid-sentence pause, i.e. while the
      // caller was still going to say more.
      const premature = built.pauseFrom != null && r.endpointAtBytes != null &&
        r.endpointAtBytes >= built.pauseFrom && r.endpointAtBytes < built.pauseTo + FRAME * 2
      // TRUNCATED: a fact the caller stated did not survive into the transcript.
      const lost = u.must.filter(re => !re.test(r.text))
      rows.push({ id: u.id, lang: LANG_OF[u.id], ms: r.endpointMs, premature, truncated: lost.length > 0, missed: r.missed, text: r.text, lost })
      if (i === 0) {
        const flag = r.missed ? '⏳ no endpoint' : premature ? '✂️ PREMATURE' : lost.length ? `❌ lost ${lost.length}` : '✅'
        console.log(`  ${u.id.padEnd(14)} ${String(r.endpointMs ?? '—').padStart(5)}ms ${flag.padEnd(14)} "${r.text.slice(0, 44)}"`)
      }
      await sleep(150)
    }
  }
  const n = rows.length || 1
  const ok = rows.filter(r => !r.premature && !r.truncated && !r.missed)
  const byLang = (lang) => {
    const set = rows.filter(r => r.lang === lang)
    if (!set.length) return '—'
    return `${Math.round(set.filter(r => !r.premature && !r.truncated && !r.missed).length / set.length * 100)}%`
  }
  results.push({
    cfg: cfg.id,
    median: median(rows.map(r => r.ms)),
    p95: pct95(rows.map(r => r.ms)),
    premature: rows.filter(r => r.premature).length / n * 100,
    truncated: rows.filter(r => r.truncated).length / n * 100,
    missed: rows.filter(r => r.missed).length / n * 100,
    correct: ok.length / n * 100,
    en: byLang('en'), te: byLang('te'), hi: byLang('hi'), ting: byLang('tinglish'), hing: byLang('hinglish'),
  })
  const r = results.at(-1)
  console.log(`  → median ${r.median}ms · p95 ${r.p95}ms · premature ${r.premature.toFixed(0)}% · truncated ${r.truncated.toFixed(0)}%`)
}

console.log('\n' + '═'.repeat(108))
console.log('  config                     median     p95  premature  truncated  missed  |  EN    TE    HI    Ting  Hing')
for (const r of results) {
  console.log(
    `  ${r.cfg.padEnd(26)} ${String(r.median).padStart(5)}ms ${String(r.p95).padStart(6)}ms` +
    `  ${r.premature.toFixed(0).padStart(7)}%  ${r.truncated.toFixed(0).padStart(8)}%  ${r.missed.toFixed(0).padStart(5)}%` +
    `  |  ${r.en.padEnd(5)} ${r.te.padEnd(5)} ${r.hi.padEnd(5)} ${r.ting.padEnd(5)} ${r.hing}`
  )
}

// Correctness is a hard constraint, not a term in a score. Only configurations that do
// no more damage than the baseline are allowed to compete on speed.
const base = results[0]
const safe = results.filter(r => r.premature <= base.premature && r.truncated <= base.truncated + 1 && r.missed <= base.missed)
const best = safe.filter(r => r !== base).sort((a, b) => a.median - b.median)[0]
console.log(`\n  Baseline: ${base.median}ms, ${base.truncated.toFixed(0)}% truncated, ${base.premature.toFixed(0)}% premature.`)
if (!best) {
  console.log('  No configuration was both safe and faster.')
} else {
  const gain = base.median - best.median
  console.log(`  Best SAFE alternative: ${best.cfg} at ${best.median}ms (${gain > 0 ? `${gain}ms faster` : `${-gain}ms slower`}).`)
  console.log(gain >= 100
    ? '  → Worth adopting: over the 100ms bar with no extra truncation.'
    : '  → NOT worth adopting: under the 100ms bar. Soniox semantic endpointing is the\n    practical floor for this stack; stop tuning it and spend the effort elsewhere.')
}
