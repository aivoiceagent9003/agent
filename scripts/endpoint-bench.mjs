// scripts/endpoint-bench.mjs — how long Soniox waits before it admits the caller stopped.
//
// Endpointing is the one stage nothing downstream can hide: every millisecond Soniox
// spends deciding the turn is over is a millisecond before the LLM has even been asked.
// This measures it the same way soniox-cascade.js does on a live call:
//
//   speechEnd = wall time at which the byte holding the END of the last word was sent
//               (Soniox's own end_ms for the last final token, mapped back to wall time)
//   endpoint  = wall time the "<end>" token arrived
//
// so the number here is directly comparable to the "endpoint NNNms" in a call log.
//
// Audio is streamed at REAL TIME in 20ms frames, then mu-law silence continues, exactly
// like a phone line that has gone quiet. Speech is synthesised by Soniox TTS: clean,
// no room noise, no human trailing breath, so treat these as a FLOOR. Real callers
// will be a little slower. What it does measure honestly is the DIFFERENCE between
// settings, which is what we are choosing between.
//
// Usage: node scripts/endpoint-bench.mjs [repeats]

import 'dotenv/config'
import WebSocket from 'ws'

const KEY = process.env.SONIOX_API_KEY
if (!KEY) { console.log('SONIOX_API_KEY is not set'); process.exit(1) }
const STT_MODEL = process.env.SONIOX_STT_MODEL || 'stt-rt-v5'
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'
const REPEATS = Number(process.argv[2] || 3)

// The two shapes that matter. A short answer is where endpointing latency is most
// audible (the caller said one word and waits a full second), a long one is where a
// too-eager endpoint would cut them off mid-sentence.
const UTTERANCES = [
  { id: 'short-te', lang: 'te', text: 'అవునండి.' },
  { id: 'short-en', lang: 'en', text: 'Yes, I am interested.' },
  { id: 'long-te', lang: 'te', text: 'నాకు term insurance గురించి తెలుసుకోవాలి అండి, నా వయసు 25 సంవత్సరాలు.' },
  { id: 'long-en', lang: 'en', text: 'I want to know about your term insurance plans for a five crore cover.' },
]

// What we are choosing between. Level/sensitivity/maxDelay per Soniox docs:
// level 0-3, sensitivity -1..1, maxDelay 500-3000.
//
// The docs read as though higher level means lower latency. MEASURED, IT IS THE
// OPPOSITE: level 2 cost 350ms against the default, and level 3 both cost more again
// and chopped "Yes, I am interested" down to "Yes." — an endpoint firing mid-sentence,
// which does not save time, it just splits one turn into two. Run this before trusting
// any of these knobs.
const SETS = {
  // The original question: is the tuning we ship helping?
  levels: [
    { id: 'default (level 0)', level: undefined, sens: undefined, maxDelay: undefined },
    { id: 'current PROD', level: 2, sens: 0.3, maxDelay: undefined },
    { id: 'prod + cap 1500', level: 2, sens: 0.3, maxDelay: 1500 },
    { id: 'aggressive', level: 3, sens: 0.3, maxDelay: 1000 },
    { id: 'max aggressive', level: 3, sens: 0.6, maxDelay: 800 },
  ],
  // Given level 0 won, how far down can the remaining two knobs go?
  floor: [
    { id: 'level 0 bare', level: 0, sens: undefined, maxDelay: undefined },
    { id: 'level 0 + cap 800', level: 0, sens: undefined, maxDelay: 800 },
    { id: 'level 0 + cap 500', level: 0, sens: undefined, maxDelay: 500 },
    { id: 'level 0 sens 0.6', level: 0, sens: 0.6, maxDelay: 800 },
    { id: 'level 1 + cap 800', level: 1, sens: undefined, maxDelay: 800 },
  ],
}
// Soniox's own endpoint has a floor around 830ms that no setting goes below. The
// documented alternative is to decide for ourselves and force the issue:
//   {"type":"finalize"}  →  every pending token comes back is_final, then "<fin>"
// The docs recommend calling it "only after sending approximately 200ms of silence
// following the end of speech". These rows measure what that actually buys.
const VAD_SETS = {
  vad: [
    { id: 'soniox <end> (level 0)', level: 0 },
    { id: 'VAD + finalize @150ms', level: 0, vadSilenceMs: 150 },
    { id: 'VAD + finalize @200ms', level: 0, vadSilenceMs: 200 },
    { id: 'VAD + finalize @300ms', level: 0, vadSilenceMs: 300 },
    { id: 'VAD + finalize @400ms', level: 0, vadSilenceMs: 400 },
  ],
}
const CONFIGS = SETS[process.argv[3] || 'levels'] || VAD_SETS[process.argv[3]] || SETS.levels

// ── mu-law energy VAD ────────────────────────────────────────────────────────
// Telephony mu-law decodes to linear PCM16; RMS over a 20ms frame is enough to tell
// speech from a quiet line. The threshold is deliberately low: this bench feeds
// DIGITAL silence after the utterance, which is the easy case. A real line carries
// room noise and comfort noise, so on a live call this needs to be calibrated
// against actual recordings before it can be trusted — see the note at the end.
const MULAW_TO_PCM = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  MULAW_TO_PCM[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function frameRms(buf) {
  let sum = 0
  for (const byte of buf) { const s = MULAW_TO_PCM[byte]; sum += s * s }
  return Math.sqrt(sum / buf.length)
}
const VAD_RMS_THRESHOLD = Number(process.env.VAD_RMS_THRESHOLD || 300)

const MULAW_SILENCE = 0xff
const FRAME = 160          // 20ms of 8kHz mu-law
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function tts(text, language) {
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: VOICE, language, text, audio_format: 'pcm_mulaw', sample_rate: 8000 }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Stream one utterance plus trailing silence, and time the endpoint.
 * Mirrors the wall-clock bookkeeping in soniox-cascade.js: remember when each byte
 * range was actually sent, then map Soniox's audio-time end_ms back onto it.
 */
function run(pcm, cfg, tailMs = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    const sentAt = []              // [cumulativeBytes, wallMs]
    let streamed = 0
    let text = ''
    let lastFinalEndMs = 0
    let firstPartialAt = null, firstFinalAt = null, endpointAt = null, startedAt = null
    let lastFinalAt = null         // when the text stopped changing — see transcriptMs
    let lastPartialText = '', stableSince = null, stableText = ''
    let stableAt = null, stableMatched = false, stableGuess = ''
    let settled = false
    let vadFiredAt = null
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
        stableText: (text + lastPartialText).trim(),
        endpointMs: endpointAt && speechEndWall ? endpointAt - speechEndWall : null,
        // When the transcript last CHANGED — i.e. the earliest moment we already knew
        // everything the caller said. The gap between this and endpointMs is dead time
        // the pipeline is allowed to use.
        transcriptMs: stableAt && speechEndWall ? stableAt - speechEndWall : null,
        stableMatched,
        stableGuess,
        vadMs: vadFiredAt && lastFinalEndMs ? vadFiredAt - audioMsToWall(lastFinalEndMs) : null,
        firstPartialMs: firstPartialAt && startedAt ? firstPartialAt - startedAt : null,
        finalToEndpointMs: endpointAt && firstFinalAt ? endpointAt - firstFinalAt : null,
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
      startedAt = Date.now()
      // Real-time pacing: one 20ms frame every 20ms, speech then silence.
      const silence = Buffer.alloc(FRAME, MULAW_SILENCE)
      const total = pcm.length + tailMs * 8
      const t0 = Date.now()
      let spoke = false, silentMs = 0, finalizeSent = false
      for (let off = 0; off < total; off += FRAME) {
        const frame = off < pcm.length ? pcm.subarray(off, off + FRAME) : silence
        if (ws.readyState !== 1 || endpointAt) break
        ws.send(frame)
        streamed += frame.length
        sentAt.push([streamed, Date.now()])
        // Client-side VAD: once the caller has actually spoken, count the quiet and
        // force finalization rather than waiting for Soniox to make up its mind.
        if (cfg.vadSilenceMs && !finalizeSent) {
          if (frameRms(frame) > VAD_RMS_THRESHOLD) { spoke = true; silentMs = 0 }
          else if (spoke) {
            silentMs += 20
            if (silentMs >= cfg.vadSilenceMs) {
              finalizeSent = true
              vadFiredAt = Date.now()
              ws.send(JSON.stringify({ type: 'finalize' }))
            }
          }
        }
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
      // Soniox delivers the finals in the SAME message as "<end>", so the stability
      // clock has to be read as it stood BEFORE this message was merged — otherwise
      // every run reports zero.
      const stableBefore = stableSince
      const textBefore = stableText
      let partial = ''
      for (const tok of m.tokens || []) {
        // "<fin>" answers manual finalization, "<end>" is Soniox's own endpoint.
        // Whichever this run is waiting for is the one that stops the clock.
        if (tok.text === '<fin>') { if (cfg.vadSilenceMs) endpointAt ||= Date.now(); continue }
        if (tok.text === '<end>') { if (!cfg.vadSilenceMs) endpointAt ||= Date.now(); continue }
        if (tok.is_final) {
          firstFinalAt ||= Date.now()
          lastFinalAt = Date.now()
          text += tok.text
          if (tok.end_ms) lastFinalEndMs = tok.end_ms
        } else { firstPartialAt ||= Date.now(); partial += tok.text }
      }
      // How long the caller's words (finals so far + the live partial) have been
      // unchanged. This is the signal speculative generation would fire on.
      const whole = text + partial
      if (whole !== lastPartialText) { lastPartialText = whole; stableText = whole; stableSince = Date.now() }
      if (endpointAt && !stableAt) {
        stableAt = stableBefore
        // Did the partial we would have gambled on actually match the final text?
        stableMatched = textBefore.trim() === text.trim()
        stableGuess = textBefore.trim()
      }
      if (endpointAt) done()
    })
    ws.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
  })
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

console.log(`Rendering ${UTTERANCES.length} utterances (${VOICE}, ${TTS_MODEL})…`)
const audio = {}
for (const u of UTTERANCES) {
  audio[u.id] = await tts(u.text, u.lang)
  console.log(`  ${u.id.padEnd(9)} ${(audio[u.id].length / 8000).toFixed(2)}s`)
}

const table = []
for (const cfg of CONFIGS) {
  console.log(`\n── ${cfg.id} ${JSON.stringify({ level: cfg.level, sens: cfg.sens, maxDelay: cfg.maxDelay })}`)
  const all = []
  const allKnown = []
  const matchTotal = []
  for (const u of UTTERANCES) {
    const runs = []
    const known = []
    let matches = 0, tries = 0
    for (let i = 0; i < REPEATS; i++) {
      try {
        const r = await run(audio[u.id], cfg)
        if (r.endpointMs != null) runs.push(r.endpointMs)
        if (r.transcriptMs != null) { known.push(r.transcriptMs); tries++; if (r.stableMatched) matches++ }
        if (i === 0) {
          console.log(`  ${u.id.padEnd(9)} heard "${r.text.slice(0, 48)}"`)
          if (!r.stableMatched) console.log(`  ${''.padEnd(9)}   partial differed: "${r.stableGuess.slice(0, 48)}"`)
          // The finalize round-trip on its own: how long Soniox took to answer once
          // we stopped waiting for it. This is the number that says whether manual
          // finalization is worth wiring into the engine.
          if (r.vadMs != null && r.endpointMs != null) {
            console.log(`  ${''.padEnd(9)}   VAD fired ${r.vadMs}ms after speech end → <fin> ${r.endpointMs - r.vadMs}ms later`)
          }
        }
      } catch (e) { console.log(`  ${u.id.padEnd(9)} FAILED ${e.message}`); break }
      await sleep(200)
    }
    if (tries) matchTotal.push([matches, tries])
    const med = median(runs)
    const medKnown = median(known)
    if (med != null) {
      all.push(...runs)
      allKnown.push(...known)
      const waste = medKnown != null ? ` · text complete at ${medKnown}ms → ${med - medKnown}ms WAITING on <end>` : ''
      console.log(`  ${u.id.padEnd(9)} endpoint ${runs.map(n => n + 'ms').join(' ')} → median ${med}ms${waste}`)
    }
  }
  const med = median(all)
  const sorted = [...all].sort((a, b) => a - b)
  const medKnown = median(allKnown)
  table.push({
    cfg: cfg.id, median: med, n: all.length, known: medKnown,
    p95: all.length ? sorted[Math.min(sorted.length - 1, Math.floor(all.length * 0.95))] : null,
  })
  const mt = matchTotal.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0])
  console.log(`  OVERALL median ${med}ms · partial stable at ${medKnown}ms · HEAD START ${med != null && medKnown != null ? med - medKnown : "?"}ms · partial matched final ${mt[0]}/${mt[1]}`)
}

console.log('\n' + '═'.repeat(62))
console.log('  setting              endpoint    p95   text ready   dead time')
for (const r of table) {
  const dead = r.median != null && r.known != null ? r.median - r.known : null
  console.log(`  ${r.cfg.padEnd(20)} ${String(r.median ?? '-').padStart(6)}ms ${String(r.p95 ?? '-').padStart(5)}ms ${String(r.known ?? '-').padStart(8)}ms ${String(dead ?? '-').padStart(9)}ms`)
}
console.log(`
Measured from the end of the last word (Soniox's own end_ms) to the "<end>" token,
which is exactly the "endpoint NNNms" a call log prints. Synthetic speech, so this is
a floor — but the gap between settings is the real decision.`)
