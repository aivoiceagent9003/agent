// scripts/latency-bench.mjs — where the caller's wait actually goes.
//
// Replays real caller turns through the REAL system prompt, the REAL tools, the REAL
// knowledge base and the REAL streaming TTS socket, and times every leg the way a live
// call does. What it cannot do is speak into a phone, so endpointing is measured
// separately by scripts/endpoint-bench.mjs and added here as a constant — set
// ENDPOINT_MS to whatever that script reports for the settings you are shipping.
//
//   endpoint      caller stops → Soniox emits "<end>"        (endpoint-bench.mjs)
//   llm ttft      request sent → first token back
//   chunker       first token → first clause worth speaking
//   tts ttfa      clause sent → first audio byte back
//   ───────────────────────────────────────────────────────
//   perceived     what the caller experiences as the pause
//
// Tool rounds are counted separately, because a turn that searches the knowledge base
// pays the model twice and that is a different problem from a slow model.
//
// Usage: node scripts/latency-bench.mjs [tenantName] [--turns=3]

import 'dotenv/config'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { retrieveKnowledge, warmupRAG } from '../src/services/rag.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools, noKnowledgeInstruction } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES, createBrainClient } from '../src/services/soniox-cascade.js'
import { createStreamChunker, normalizeForTts, scriptLanguage } from '../src/services/tts-text.js'
import { createTtsSocket } from '../src/services/soniox-tts-stream.js'
import { acknowledgementFor } from '../src/services/acknowledgements.js'

const KEY = process.env.SONIOX_API_KEY
const LLM_PROVIDER = String(process.env.CASCADE_LLM_PROVIDER || 'openai').toLowerCase()
const LLM_MODEL = process.env.CASCADE_LLM_MODEL || (LLM_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini')
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const TTS_VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'
const KB_CHUNKS = Number(process.env.CASCADE_KB_CHUNKS || 6)
// Must mirror soniox-cascade.js, or the bench measures a chunker the engine does not use.
const FIRST_CLAUSE_CHARS = Number(process.env.CASCADE_FIRST_CLAUSE_CHARS || 25)
// Measured by scripts/endpoint-bench.mjs on Soniox defaults. Not a guess, but not
// measured HERE either — this script never touches STT.
const ENDPOINT_MS = Number(process.env.ENDPOINT_MS || 830)

const REPEATS = Number((process.argv.find(a => a.startsWith('--turns=')) || '').slice(8) || 1)
const tenantName = process.argv.slice(2).find(a => !a.startsWith('--')) || 'GSK insurance'

// A spread of turn shapes: one that needs nothing, one that needs the knowledge base,
// one that needs a figure out of it. The mix is what decides the average call.
const TURNS = [
  { id: 'chat', text: 'ఆ, నేను బాగున్నాను అండి.', expectTool: false },
  { id: 'kb', text: 'మీ దగ్గర term insurance options ఏమైనా ఉన్నాయా?', expectTool: true },
  { id: 'figure', text: 'నా వయసు 25, five crore cover కి premium ఎంత అవుతుంది?', expectTool: true },
  { id: 'short-en', text: 'Yes, tell me more about that one.', expectTool: false },
]

const { data: tenant, error } = await supabase.from('tenants').select('*').ilike('name', tenantName).single()
if (error || !tenant) { console.log(`tenant "${tenantName}" not found`); process.exit(1) }
const tenantConfig = { ...(tenant.config || {}), tenant_id: tenant.id }

const systemPrompt = buildSystemPrompt(tenantConfig, {
  channel: 'voice', whatsapp: whatsappReady(tenantConfig), language: { modelLed: true },
}) + '\n\n' + VOICE_OUTPUT_RULES
const tools = (buildAgentTools(tenantConfig)[0]?.functionDeclarations || []).map(d => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } },
}))
const greeting = tenantConfig.greeting || 'Namaste, I am Aruna from GSK insurance. How can I help you?'

const client = createBrainClient(LLM_PROVIDER)
const effort = process.env.CASCADE_LLM_REASONING_EFFORT || (LLM_PROVIDER === 'gemini' ? 'minimal' : null)

// One concurrency gate, exactly as the engine has, so TTFA is measured under the same
// cap the caller is subject to.
let inFlight = 0
const waiters = []
const acquire = () => inFlight < 2 ? (inFlight++, Promise.resolve()) : new Promise(r => waiters.push(r))
const release = () => { const n = waiters.shift(); if (n) n(); else inFlight-- }

const ttsSocket = createTtsSocket({
  apiKey: KEY, model: TTS_MODEL, voice: TTS_VOICE, acquire, release, retries: 3,
  onError: (m) => console.log(`    tts error: ${m}`),
})
await ttsSocket.warm()

// CASCADE_ACK=false measures the BEFORE state on the same code path, so the two runs
// differ by the feature and nothing else.
const ACK = process.env.CASCADE_ACK !== 'false'
const LANG = process.env.BENCH_ACK_LANG || 'te'

// The acknowledgement is cached audio in production (rendered once per process), so
// the honest thing to measure is a cache HIT — which is what every call after the
// first one gets. Rendered once here, before the clock starts on any turn.
const ackCache = new Map()
async function renderAck(text, language) {
  const key = `${language}|${text}`
  if (!ackCache.has(key)) {
    ackCache.set(key, (async () => {
      const res = await fetch('https://tts-rt.soniox.com/tts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, language, text, audio_format: 'pcm_mulaw', sample_rate: 8000 }),
      })
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null
    })())
  }
  return ackCache.get(key)
}

/** Queue the acknowledgement the way the engine does, and time its first audio. */
function sayAck(ack, t) {
  renderAck(ack.text, ack.language).then(buf => {
    t.ackFirstAudio ||= Date.now()
    // 8kHz µ-law: one byte per sample, so bytes ARE milliseconds × 8.
    if (buf) t.ackAudioMs = Math.round(buf.length / 8)
  })
}

async function runTool(name, args) {
  if (name === 'search_knowledge') {
    return (await retrieveKnowledge(tenant.id, args?.query || '', KB_CHUNKS, { mode: args?.mode })) || noKnowledgeInstruction(tenantConfig)
  }
  if (name === 'end_call') return 'The call will end as soon as you finish speaking.'
  return 'No matching record found.'
}

/** One turn, timed end to end, through the same code the engine uses. */
async function turn(messages, userText) {
  messages.push({ role: 'user', content: userText })
  const turnMessages = [...messages]
  const t = {
    start: Date.now(), firstToken: null, firstChunk: null, firstAudio: null,
    rounds: 0, toolMs: 0, tools: [], reply: '', llmMs: 0,
    ackAt: null, ackFirstAudio: null, ackText: null, ackAudioMs: 0,
  }
  const chunker = createStreamChunker({ firstClauseMinChars: FIRST_CLAUSE_CHARS })
  let open = null
  const items = []

  const feed = ({ text, final }) => {
    const spoken = normalizeForTts(text).join(' ')
    if (spoken) {
      if (!open) {
        t.firstChunk ||= Date.now()
        open = { chunks: [], done: false, cancelled: false, notify: null, requestedAt: Date.now(), firstByteAt: 0 }
        items.push(open)
        open.notify = () => { if (open?.firstByteAt) t.firstAudio ||= open.firstByteAt }
        ttsSocket.begin(open, scriptLanguage(spoken))
        ttsSocket.push(open, spoken)
      } else ttsSocket.push(open, ' ' + spoken)
    }
    if (final && open) { ttsSocket.end(open); open = null }
    for (const it of items) if (it.firstByteAt) t.firstAudio ||= it.firstByteAt
  }

  for (let round = 0; round < 4; round++) {
    t.rounds++
    const params = { model: LLM_MODEL, messages: turnMessages, temperature: 0.3, max_tokens: 400, stream: true, stream_options: { include_usage: true } }
    if (tools.length && round < 3) { params.tools = tools; params.tool_choice = 'auto' }
    if (effort) params.reasoning_effort = effort
    const roundStart = Date.now()
    const stream = await client.chat.completions.create(params)
    const calls = []
    let roundText = ''
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      if (!choice) continue
      for (const tc of choice.delta?.tool_calls || []) {
        const k = tc.index ?? 0
        calls[k] ||= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) calls[k].id = tc.id
        if (tc.function?.name) calls[k].function.name += tc.function.name
        if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments
        if (tc.extra_content) calls[k].extra_content = tc.extra_content
        // Mirrors soniox-cascade.js: speak the moment the tool NAME arrives, and only
        // when the model has not written its own lead-in.
        if (ACK && tc.function?.name && !t.ackAt && !t.firstChunk && !roundText.trim()) {
          const ack = acknowledgementFor({ tool: calls[k].function.name, language: LANG, turn: 1, seed: 'bench' })
          if (ack) {
            t.ackAt = Date.now()
            t.ackText = ack.text
            sayAck(ack, t)
          }
        }
      }
      const tok = choice.delta?.content
      if (!tok) continue
      t.firstToken ||= Date.now()
      roundText += tok
      for (const p of chunker.push(tok)) feed(p)
    }
    t.llmMs += Date.now() - roundStart
    const toolCalls = calls.filter(Boolean)
    if (toolCalls.length) {
      for (const p of chunker.flush()) feed(p)
      turnMessages.push({ role: 'assistant', content: roundText || null, tool_calls: toolCalls })
      const tt = Date.now()
      for (const tc of toolCalls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed */ }
        t.tools.push(tc.function.name)
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: String(await runTool(tc.function.name, args)) })
      }
      t.toolMs += Date.now() - tt
      continue
    }
    for (const p of chunker.flush()) feed(p)
    t.reply += roundText
    break
  }

  // Wait for the first audio byte of the turn.
  const deadline = Date.now() + 15000
  while (!t.firstAudio && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
    for (const it of items) if (it.firstByteAt) t.firstAudio ||= it.firstByteAt
  }
  // …and then for the whole reply to finish synthesising. On a real call the caller
  // cannot speak again until they have heard it, so the next turn must not start with
  // this turn's sentences still holding the concurrency slots — that is a queue this
  // bench would otherwise invent and then blame on Soniox.
  const settle = Date.now() + 20000
  while (items.some(it => !it.done) && Date.now() < settle) await new Promise(r => setTimeout(r, 20))

  messages.length = 0
  messages.push(...turnMessages, { role: 'assistant', content: t.reply })
  return t
}

console.log(`tenant "${tenant.name}" · llm ${LLM_PROVIDER}/${LLM_MODEL}${effort ? ` (thinking: ${effort})` : ''} · tts ${TTS_MODEL}/${TTS_VOICE} · kb ${KB_CHUNKS} chunks`)
console.log(`endpoint constant ${ENDPOINT_MS}ms (from endpoint-bench.mjs)\n`)

// Everything the engine warms at call start. Without this the first knowledge turn
// pays 8.7s to load the tenant's index into memory and the whole run reads as an
// LLM problem it is not.
await warmupRAG(tenant.id)
await retrieveKnowledge(tenant.id, 'term insurance premium', KB_CHUNKS).catch(() => {})
await client.chat.completions.create({
  model: LLM_MODEL, max_tokens: 1,
  messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'hi' }],
  ...(effort ? { reasoning_effort: effort } : {}),
}).catch(() => {})

const rows = []
for (let rep = 0; rep < REPEATS; rep++) {
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'assistant', content: greeting }]
  for (const spec of TURNS) {
    const t = await turn(messages, spec.text)
    const ttft = t.firstToken ? t.firstToken - t.start : null
    const chunk = t.firstToken && t.firstChunk ? t.firstChunk - t.firstToken : null
    const ttfa = t.firstChunk && t.firstAudio ? t.firstAudio - t.firstChunk : null
    const pipeline = t.firstAudio ? t.firstAudio - t.start : null
    // On a masked turn the caller's SILENCE ends at the acknowledgement, while the
    // ANSWER still arrives when it always did. Two different numbers; reporting only
    // one of them tells the wrong story in either direction.
    const ackAudio = t.ackFirstAudio ? t.ackFirstAudio - t.start : null
    const silence = (ackAudio ?? pipeline) != null ? (ackAudio ?? pipeline) + ENDPOINT_MS : null
    const answer = pipeline != null ? pipeline + ENDPOINT_MS : null
    // Did the acknowledgement still have audio left to play when the answer was ready?
    const heldBy = t.ackFirstAudio && t.firstAudio
      ? Math.max(0, (t.ackFirstAudio + t.ackAudioMs) - t.firstAudio)
      : null
    rows.push({
      id: spec.id, rep, ttft, chunk, ttfa, pipeline, rounds: t.rounds, toolMs: t.toolMs,
      tools: t.tools, reply: t.reply, silence, answer, heldBy, ackAudioMs: t.ackAudioMs,
    })
    console.log(
      `  ${spec.id.padEnd(9)} rounds ${t.rounds} ${t.tools.length ? `[${t.tools.join(',')}]` : ''}\n` +
      `            llm ttft ${String(ttft ?? '?').padStart(5)}ms · chunker ${String(chunk ?? '?').padStart(4)}ms · tts ttfa ${String(ttfa ?? '?').padStart(4)}ms` +
      `${t.toolMs ? ` · tools ${t.toolMs}ms` : ''}\n` +
      (t.ackText
        ? `            💬 "${t.ackText}" at ${silence}ms (${t.ackAudioMs}ms long) · answer ${answer}ms` +
          `${heldBy ? ` · HELD ANSWER ${heldBy}ms` : ' · did not delay the answer'}\n`
        : `            SILENCE ${silence}ms → answer ${answer}ms\n`) +
      `            "${t.reply.replace(/\s+/g, ' ').slice(0, 78)}"`
    )
  }
}

ttsSocket.close()

const med = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const noTool = rows.filter(r => !r.tools.length)
const withTool = rows.filter(r => r.tools.length)
const p95 = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null }
const bucket = (name, set) => {
  if (!set.length) return
  const p = med(set.map(r => r.pipeline))
  console.log(
    `  ${name.padEnd(18)} ttft ${String(med(set.map(r => r.ttft))).padStart(5)}ms · chunker ${String(med(set.map(r => r.chunk))).padStart(4)}ms · ` +
    `ttfa ${String(med(set.map(r => r.ttfa))).padStart(4)}ms · SILENCE ${String(med(set.map(r => r.silence))).padStart(5)}ms ` +
    `(p95 ${String(p95(set.map(r => r.silence))).padStart(5)}ms) · ANSWER ${String(med(set.map(r => r.answer))).padStart(5)}ms`
  )
}
console.log('\n' + '═'.repeat(96))
bucket('no tool call', noTool)
bucket('with tool call', withTool)
bucket('all turns', rows)

const all = med(rows.map(r => r.pipeline)) + ENDPOINT_MS
const legs = [
  ['ENDPOINTING', ENDPOINT_MS],
  ['LLM_TTFT', med(rows.map(r => r.ttft))],
  ['TEXT_CHUNKING', med(rows.map(r => r.chunk))],
  ['SONIOX_TTS', med(rows.map(r => r.ttfa))],
].sort((a, b) => b[1] - a[1])
console.log(`\n  PRIMARY BOTTLENECK: ${legs[0][0]} (${legs[0][1]}ms of ${all}ms)`)
console.log(`  then: ${legs.slice(1).map(([n, v]) => `${n} ${v}ms`).join(' · ')}`)
