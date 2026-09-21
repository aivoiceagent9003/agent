// scripts/llm-provider-bench.mjs — is another model fast enough to be worth migrating to?
//
// LLM first-token latency is the largest controllable leg of an AnswerLabs turn:
// ~1300-1450ms of a ~2.7s ordinary turn, against a Soniox endpoint floor of ~870ms and
// a TTS floor of ~420ms. Prompt size is not the cause (measured: ~10ms per 1000 tokens,
// no cliff), so the only lever left is the model itself.
//
// This isolates the model and NOTHING else. No STT, no TTS, no telephony. Every
// candidate gets the same production system prompt, the same tool schemas, the same
// conversation history and the same user turn — a candidate handed a simplified 2K
// prompt against a 12K baseline would produce a number that means nothing.
//
// TWO latencies matter, and they are not the same:
//
//   TTFT            request → first generated token
//   tool decision   request → first tool-call delta
//
// The second one is what gates KB acknowledgement: masking cannot start until the model
// has decided it needs a lookup. A model with 400ms TTFT and 1300ms tool decision would
// not fix the knowledge turn at all.
//
// Usage:
//   node scripts/llm-provider-bench.mjs --screen           quick pass over all candidates
//   node scripts/llm-provider-bench.mjs --n=20 --models=a,b deep run on finalists
//   node scripts/llm-provider-bench.mjs --cold             cold-start numbers only

import 'dotenv/config'
import OpenAI from 'openai'
import { performance } from 'node:perf_hooks'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES } from '../src/services/soniox-cascade.js'

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const N = Number(arg('n', process.argv.includes('--screen') ? 3 : 10))
const ONLY = (arg('models', '') || '').split(',').filter(Boolean)
const COLD_ONLY = process.argv.includes('--cold')
const CATEGORIES = (arg('categories', '') || '').split(',').filter(Boolean)

// ── Candidates ───────────────────────────────────────────────────────────────
// Only models this repository can actually reach with the keys it has. Groq,
// Cerebras and Mistral are plausible low-latency hosts but there is no key for any
// of them here, so they are NOT benchmarked rather than guessed at.
//
// `effort` is each provider's way of saying "do not think before answering", which on
// a phone call is dead air. Set to the cheapest setting each model accepts.
const CANDIDATES = [
  // Baseline — production today.
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', effort: 'minimal', baseline: true },
  // Other Gemini lite/flash tiers not previously covered.
  { id: 'gemini-3.1-flash-lite', provider: 'gemini', model: 'gemini-3.1-flash-lite', effort: 'minimal' },
  { id: 'gemini-flash-lite-latest', provider: 'gemini', model: 'gemini-flash-lite-latest', effort: 'minimal' },
  { id: 'gemini-2.5-flash-lite', provider: 'gemini', model: 'gemini-2.5-flash-lite', effort: 'none' },
  { id: 'gemini-3.6-flash', provider: 'gemini', model: 'gemini-3.6-flash', effort: 'minimal' },
  // OpenAI nano/mini tiers — the low-latency end of that catalogue.
  { id: 'gpt-4.1-nano', provider: 'openai', model: 'gpt-4.1-nano', effort: null },
  { id: 'gpt-4.1-mini', provider: 'openai', model: 'gpt-4.1-mini', effort: null },
  { id: 'gpt-5.4-nano', provider: 'openai', model: 'gpt-5.4-nano', effort: 'none', reasoningTier: true },
  { id: 'gpt-5-nano', provider: 'openai', model: 'gpt-5-nano', effort: 'minimal', reasoningTier: true },
  { id: 'gpt-5.4-mini', provider: 'openai', model: 'gpt-5.4-mini', effort: 'none', reasoningTier: true },
  // Anthropic's fast tiers.
  { id: 'claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: null },
  { id: 'claude-fable-5-1', provider: 'anthropic', model: 'claude-fable-5-1', effort: null },
]
const RUNNING = ONLY.length ? CANDIDATES.filter(c => ONLY.includes(c.id)) : CANDIDATES

// ── The production prompt, verbatim ──────────────────────────────────────────
const tenantName = arg('tenant', 'GSK insurance')
const { data: tenant, error } = await supabase.from('tenants').select('*').ilike('name', tenantName).single()
if (error || !tenant) { console.log(`tenant "${tenantName}" not found`); process.exit(1) }
const tenantConfig = { ...(tenant.config || {}), tenant_id: tenant.id }

const SYSTEM = buildSystemPrompt(tenantConfig, {
  channel: 'voice', whatsapp: whatsappReady(tenantConfig), language: { modelLed: true },
}) + '\n\n' + VOICE_OUTPUT_RULES

const TOOL_DECLS = buildAgentTools(tenantConfig)[0]?.functionDeclarations || []
const OPENAI_TOOLS = TOOL_DECLS.map(d => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } },
}))
// Same schemas, Anthropic's field names. A format conversion, not a simplification.
const ANTHROPIC_TOOLS = TOOL_DECLS.map(d => ({
  name: d.name,
  description: d.description,
  input_schema: d.parameters || { type: 'object', properties: {} },
}))

const GREETING = tenantConfig.greeting || 'Namaste, GSK insurance నుంచి Aruna మాట్లాడుతున్నాను.'

// ── Corpus ───────────────────────────────────────────────────────────────────
// Real AnswerLabs turns. "Hello" would measure nothing: every model is fast at it and
// none of the behaviour that matters is exercised.
//
// `tool` is what SHOULD happen: a tool name, null for "must answer without a lookup",
// or 'either' where both are defensible and scoring it would be the benchmark imposing
// an opinion. "That sounds expensive" is the clearest example — looking up the premium
// is a reasonable thing to do there, and so is answering the objection directly. A
// first pass scored those as failures and put every model at 20-60%, which said more
// about the corpus than about the models. Only unambiguous cases count toward
// tool-correctness; the rest are reported but not graded.
// The history is in the SAME language as the turn under test. This matters: language
// adherence cannot be scored against a mismatched conversation. A first pass gave every
// case a Telugu history, then marked an English case "wrong script" when the model
// replied in Telugu — which, mid-Telugu-conversation, is arguably the correct thing to
// do. That measured the benchmark's confusion, not the model's.
const HISTORIES = {
  en: [
    { role: 'assistant', content: 'Namaste, this is Aruna from GSK insurance. How can I help you?' },
    { role: 'user', content: 'I am looking into term insurance.' },
    { role: 'assistant', content: 'Of course. We have a few term insurance options. What would you like to know?' },
  ],
  te: [
    { role: 'assistant', content: GREETING },
    { role: 'user', content: 'ఆ, నేను term insurance గురించి చూస్తున్నాను.' },
    { role: 'assistant', content: 'అవును అండి, మా దగ్గర term insurance options ఉన్నాయి. మీకు ఏ విషయం గురించి తెలుసుకోవాలి?' },
  ],
  hi: [
    { role: 'assistant', content: 'नमस्ते, मैं GSK insurance से Aruna बोल रही हूँ. मैं आपकी क्या मदद कर सकती हूँ?' },
    { role: 'user', content: 'मैं term insurance के बारे में देख रहा हूँ.' },
    { role: 'assistant', content: 'जी ज़रूर. हमारे पास term insurance के कुछ options हैं. आप क्या जानना चाहेंगे?' },
  ],
}

const CORPUS = [
  // A — ordinary conversation, no lookup needed
  { id: 'a-explain', cat: 'normal', lang: 'en', text: 'Yes, I am interested. Can you explain the plan?', tool: 'either' },
  { id: 'a-expensive', cat: 'normal', lang: 'en', text: 'That sounds expensive.', tool: 'either' },
  { id: 'a-simple', cat: 'normal', lang: 'en', text: 'Can you explain that in simple terms?', tool: 'either' },
  // B — sales / objection handling
  { id: 'b-objection', cat: 'sales', lang: 'en', text: 'I already have insurance. Why would I need another policy?', tool: 'either' },
  { id: 'b-notnow', cat: 'sales', lang: 'en', text: 'I am not interested right now.', tool: null },
  // H — short answers, where over-answering is the failure
  { id: 'h-yes', cat: 'short', lang: 'en', text: 'Yes.', tool: null },
  { id: 'h-te-avunu', cat: 'short', lang: 'te', text: 'అవును.', tool: null },
  { id: 'h-hi-haan', cat: 'short', lang: 'hi', text: 'हाँ.', tool: null },
  // D — Telugu
  { id: 'd-detail', cat: 'telugu', lang: 'te', text: 'నాకు ఈ ప్లాన్ గురించి కొంచెం వివరంగా చెప్పండి.', tool: 'either' },
  { id: 'd-budget', cat: 'telugu', lang: 'te', text: 'నా బడ్జెట్ ఒక కోటి వరకు ఉంది.', tool: 'either' },
  // E — Tinglish
  { id: 'e-interest', cat: 'tinglish', lang: 'te', text: 'అవునండి, నాకు ఈ plan మీద interest ఉంది.', tool: 'either' },
  { id: 'e-premium', cat: 'tinglish', lang: 'te', text: 'Premium ఎంత వస్తుందో ఒకసారి check చేయగలరా?', tool: 'search_knowledge' },
  // F — Hindi
  { id: 'f-detail', cat: 'hindi', lang: 'hi', text: 'मुझे इस प्लान के बारे में थोड़ा विस्तार से बताइए.', tool: 'either' },
  { id: 'f-budget', cat: 'hindi', lang: 'hi', text: 'मेरा बजट लगभग एक करोड़ तक है.', tool: 'either' },
  // G — Hinglish
  { id: 'g-interest', cat: 'hinglish', lang: 'hi', text: 'Haan ji, mujhe is plan mein interest hai.', tool: 'either' },
  { id: 'g-premium', cat: 'hinglish', lang: 'hi', text: 'Premium kitna aayega ek baar check kar sakte ho?', tool: 'search_knowledge' },
  // I/J — must reach for the knowledge base, and must get the query right
  { id: 'i-rate', cat: 'tool', lang: 'en', text: 'What premium would a five crore cover cost at age twenty five?', tool: 'search_knowledge' },
  { id: 'i-claim', cat: 'tool', lang: 'en', text: 'What is your claim settlement ratio?', tool: 'search_knowledge' },
  { id: 'j-generic', cat: 'tool', lang: 'en', text: 'What is term insurance, generally speaking?', tool: 'either' },
]
const CASES = CATEGORIES.length ? CORPUS.filter(c => CATEGORIES.includes(c.cat)) : CORPUS

// ── Clients ──────────────────────────────────────────────────────────────────
const clients = {
  openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  gemini: new OpenAI({ apiKey: process.env.GOOGLE_AI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
}

/** Text that a TTS voice could actually start speaking — not whitespace, not punctuation. */
const isSpeakable = (s) => /[\p{L}\p{N}]/u.test(s)

/**
 * One request, fully timed.
 *
 * Every timestamp is performance.now(), taken as close to the wire as the SDK allows.
 * requestStart is immediately before the call; firstToken is the first chunk carrying
 * generated content, NOT the first chunk of any kind — providers send role headers and
 * empty deltas that would flatter the number.
 */
async function runOpenAIStyle(cand, testCase) {
  const client = clients[cand.provider]
  const params = {
    model: cand.model,
    messages: [{ role: 'system', content: SYSTEM }, ...HISTORIES[testCase.lang], { role: 'user', content: testCase.text }],
    stream: true,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
  }
  // The reasoning tiers renamed the output cap and fixed temperature at its default.
  // Both are the SAME request semantically — a 400-token ceiling and the provider's
  // nearest-available sampling — so this is a dialect difference, not a handicap.
  if (cand.reasoningTier) {
    params.max_completion_tokens = 400
  } else {
    params.max_tokens = 400
    params.temperature = 0.3
  }
  if (cand.effort) params.reasoning_effort = cand.effort
  const t0 = performance.now()
  const timeline = []
  let firstToken = null, firstSpeakable = null, firstToolDelta = null, toolArgsDone = null
  let text = '', toolName = '', toolArgs = '', outputChunks = 0

  const stream = await client.chat.completions.create(params)
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta
    if (!d) continue
    const now = performance.now()
    if (d.tool_calls?.length) {
      firstToken ??= now
      firstToolDelta ??= now
      for (const tc of d.tool_calls) {
        if (tc.function?.name) toolName += tc.function.name
        if (tc.function?.arguments) toolArgs += tc.function.arguments
      }
      try { if (toolArgs && JSON.parse(toolArgs)) toolArgsDone ??= now } catch { /* still streaming */ }
    }
    if (d.content) {
      firstToken ??= now
      if (isSpeakable(d.content)) firstSpeakable ??= now
      text += d.content
      outputChunks++
      if (timeline.length < 12) timeline.push({ at: Math.round(now - t0), n: d.content.length })
    }
  }
  const done = performance.now()
  return { t0, done, firstToken, firstSpeakable, firstToolDelta, toolArgsDone, text, toolName, toolArgs, outputChunks, timeline }
}

/** Same measurement, Anthropic's Messages API shape. */
async function runAnthropic(cand, testCase) {
  const body = {
    model: cand.model,
    max_tokens: 400,
    temperature: 0.3,
    system: SYSTEM,
    messages: [...HISTORIES[testCase.lang], { role: 'user', content: testCase.text }],
    tools: ANTHROPIC_TOOLS,
    stream: true,
  }
  const t0 = performance.now()
  const timeline = []
  let firstToken = null, firstSpeakable = null, firstToolDelta = null, toolArgsDone = null
  let text = '', toolName = '', toolArgs = '', outputChunks = 0
  let inputTokens = 0, outputTokens = 0

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)

  let buf = ''
  for await (const part of res.body) {
    buf += Buffer.from(part).toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      let ev
      try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
      const now = performance.now()
      if (ev.type === 'message_start') inputTokens = ev.message?.usage?.input_tokens || 0
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        firstToken ??= now
        firstToolDelta ??= now
        toolName = ev.content_block.name || ''
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta
        if (d?.type === 'text_delta' && d.text) {
          firstToken ??= now
          if (isSpeakable(d.text)) firstSpeakable ??= now
          text += d.text
          outputChunks++
          if (timeline.length < 12) timeline.push({ at: Math.round(now - t0), n: d.text.length })
        }
        if (d?.type === 'input_json_delta' && d.partial_json !== undefined) {
          toolArgs += d.partial_json
          try { if (toolArgs && JSON.parse(toolArgs)) toolArgsDone ??= now } catch { /* still streaming */ }
        }
      }
      if (ev.type === 'content_block_stop' && toolName && !toolArgsDone) {
        // An empty-argument tool call never produces a json delta.
        toolArgsDone ??= now
        if (!toolArgs) toolArgs = '{}'
      }
      if (ev.type === 'message_delta') outputTokens = ev.usage?.output_tokens || outputTokens
    }
  }
  const done = performance.now()
  return { t0, done, firstToken, firstSpeakable, firstToolDelta, toolArgsDone, text, toolName, toolArgs, outputChunks, timeline, inputTokens, outputTokens }
}

const runOne = (cand, testCase) =>
  cand.provider === 'anthropic' ? runAnthropic(cand, testCase) : runOpenAIStyle(cand, testCase)

// ── Deterministic quality checks ─────────────────────────────────────────────
// Judged by rules wherever a rule exists. An LLM judge is saved for naturalness, which
// is the only dimension here that genuinely needs one.
const SCRIPT = {
  te: /[ఀ-౿]/,
  hi: /[ऀ-ॿ]/,
  en: /[A-Za-z]/,
}
const WRONG_SCRIPT = {
  te: /[ऀ-ॿ]/,           // Devanagari in a Telugu turn
  hi: /[ఀ-౿]/,           // Telugu letters in a Hindi turn
  en: /[ఀ-౿ऀ-ॿ]/,
}
// Neighbouring Indic scripts the voice cannot read: Malayalam, Tamil, Kannada, Bengali.
const STRAY_SCRIPT = /[ഀ-ൿ஀-௿ಀ-೿ঀ-৿]/

function score(testCase, r) {
  const out = { }
  const called = r.toolName || null
  out.toolExpected = testCase.tool
  out.toolActual = called
  out.graded = testCase.tool !== 'either'
  out.toolCorrect = out.graded ? (testCase.tool || null) === (called || null) : null
  out.falseTool = out.graded && !testCase.tool && !!called
  out.missedTool = out.graded && !!testCase.tool && !called
  // Tool arguments must be valid JSON, and a knowledge search must carry a query.
  if (called) {
    try {
      const args = JSON.parse(r.toolArgs || '{}')
      out.argsValid = true
      out.ragQuery = args.query || null
      // Retrieval measured worse on raw Telugu than on a model-written English query,
      // so a Telugu-language turn should still produce an ENGLISH search query.
      out.ragQueryEnglish = out.ragQuery ? !/[ఀ-౿ऀ-ॿ]/.test(out.ragQuery) : null
    } catch { out.argsValid = false; out.ragQuery = null; out.ragQueryEnglish = null }
  }
  // Language adherence on spoken text only.
  const spoken = (r.text || '').trim()
  out.replyChars = spoken.length
  if (spoken && !called) {
    const want = SCRIPT[testCase.lang]
    out.languageOk = want ? want.test(spoken) : true
    out.wrongScript = WRONG_SCRIPT[testCase.lang]?.test(spoken) || false
    out.strayScript = STRAY_SCRIPT.test(spoken)
    // A short answer answered with a paragraph is a voice-agent failure even when the
    // content is right — the caller said one word and is now listening to an essay.
    out.overAnswered = testCase.cat === 'short' && spoken.length > 220
  }
  return out
}

// ── Stats ────────────────────────────────────────────────────────────────────
const q = (a, p) => {
  const s = a.filter(n => n != null).sort((x, y) => x - y)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : null
}
const med = (a) => q(a, 0.5)

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(`tenant "${tenant.name}" · system prompt ${SYSTEM.length} chars · ${TOOL_DECLS.length} tools`)
console.log(`${CASES.length} cases × ${N} reps × ${RUNNING.length} models${COLD_ONLY ? ' (COLD only)' : ''}\n`)

const all = []
for (const cand of RUNNING) {
  const rows = []
  let errors = 0, firstAttemptOk = 0, attempts = 0
  let coldTtft = null

  // COLD: the very first request on a fresh client, reported separately because
  // production warms the client at call start and never pays this again.
  try {
    const warm = await runOne(cand, CASES[0])
    coldTtft = warm.firstToken ? Math.round(warm.firstToken - warm.t0) : null
  } catch (e) {
    console.log(`  ${cand.id.padEnd(24)} UNAVAILABLE — ${String(e.message).slice(0, 90)}`)
    all.push({ cand, unavailable: String(e.message).slice(0, 120) })
    continue
  }
  if (COLD_ONLY) { console.log(`  ${cand.id.padEnd(24)} COLD TTFT ${coldTtft}ms`); continue }

  for (const testCase of CASES) {
    for (let i = 0; i < N; i++) {
      attempts++
      try {
        const r = await runOne(cand, testCase)
        firstAttemptOk++
        rows.push({
          case: testCase, cat: testCase.cat, lang: testCase.lang,
          ttft: r.firstToken ? r.firstToken - r.t0 : null,
          speakable: r.firstSpeakable ? r.firstSpeakable - r.t0 : null,
          toolDelta: r.firstToolDelta ? r.firstToolDelta - r.t0 : null,
          toolArgs: r.toolArgsDone ? r.toolArgsDone - r.t0 : null,
          total: r.done - r.t0,
          chunks: r.outputChunks,
          outChars: (r.text || '').length,
          ...score(testCase, r),
          sample: (r.text || '').replace(/\s+/g, ' ').slice(0, 90),
        })
      } catch (e) {
        errors++
        rows.push({ case: testCase, cat: testCase.cat, lang: testCase.lang, error: String(e.message).slice(0, 80) })
      }
      await new Promise(r => setTimeout(r, 120))
    }
    process.stdout.write('.')
  }

  const ok = rows.filter(r => !r.error)
  const noTool = ok.filter(r => !r.toolActual)
  const withTool = ok.filter(r => r.toolActual)
  const summary = {
    cand, coldTtft, errors, attempts,
    firstAttemptRate: Math.round(firstAttemptOk / attempts * 100),
    ttft: med(ok.map(r => r.ttft)), ttftP75: q(ok.map(r => r.ttft), 0.75), ttftP95: q(ok.map(r => r.ttft), 0.95),
    ttftMin: q(ok.map(r => r.ttft), 0), ttftMax: q(ok.map(r => r.ttft), 1),
    speakable: med(noTool.map(r => r.speakable)),
    toolDelta: med(withTool.map(r => r.toolDelta)),
    toolDeltaP95: q(withTool.map(r => r.toolDelta), 0.95),
    toolArgsMs: med(withTool.map(r => r.toolArgs)),
    tokPerSec: med(ok.filter(r => r.outChars > 40).map(r => (r.outChars / 4) / ((r.total - (r.ttft || 0)) / 1000))),
    toolCorrect: Math.round(ok.filter(r => r.toolCorrect === true).length / (ok.filter(r => r.graded).length || 1) * 100),
    falseTools: ok.filter(r => r.falseTool).length,
    missedTools: ok.filter(r => r.missedTool).length,
    argsValid: Math.round(withTool.filter(r => r.argsValid).length / (withTool.length || 1) * 100),
    ragEnglish: withTool.filter(r => r.ragQueryEnglish === true).length,
    ragTotal: withTool.filter(r => r.ragQueryEnglish !== null && r.ragQueryEnglish !== undefined).length,
    wrongScript: noTool.filter(r => r.wrongScript).length,
    strayScript: noTool.filter(r => r.strayScript).length,
    overAnswered: noTool.filter(r => r.overAnswered).length,
    rows,
  }
  all.push(summary)
  console.log(` ${cand.id.padEnd(24)} warm TTFT ${String(summary.ttft).padStart(5)}ms (cold ${coldTtft}ms) · tool ${String(summary.toolDelta).padStart(5)}ms · errors ${errors}`)
}

// ── Tables ───────────────────────────────────────────────────────────────────
const live = all.filter(a => !a.unavailable && a.rows)
if (!live.length) { console.log('\nNo candidate produced results.'); process.exit(0) }
const baseline = live.find(a => a.cand.baseline)

console.log('\n' + '═'.repeat(112))
console.log('NORMAL RESPONSE (WARM)')
console.log('  model                      TTFT    P75    P95    min    max  speakable   tok/s  cold   1st-try')
for (const a of live.sort((x, y) => (x.ttft ?? 9e9) - (y.ttft ?? 9e9))) {
  console.log(
    `  ${(a.cand.id + (a.cand.baseline ? ' *' : '')).padEnd(24)} ${String(a.ttft).padStart(5)}ms ${String(a.ttftP75).padStart(5)} ${String(a.ttftP95).padStart(6)} ` +
    `${String(a.ttftMin).padStart(6)} ${String(a.ttftMax).padStart(6)} ${String(a.speakable).padStart(8)}ms ${String(Math.round(a.tokPerSec || 0)).padStart(7)} ${String(a.coldTtft).padStart(5)}ms ${String(a.firstAttemptRate).padStart(5)}%`
  )
}

console.log('\nTOOL CALL — what gates KB acknowledgement')
console.log('  model                    decision    P95   full args   correct tool%   args valid%   false  missed')
for (const a of live.sort((x, y) => (x.toolDelta ?? 9e9) - (y.toolDelta ?? 9e9))) {
  console.log(
    `  ${(a.cand.id + (a.cand.baseline ? ' *' : '')).padEnd(24)} ${String(a.toolDelta).padStart(6)}ms ${String(a.toolDeltaP95).padStart(6)} ` +
    `${String(a.toolArgsMs).padStart(9)}ms ${String(a.toolCorrect).padStart(12)}% ${String(a.argsValid).padStart(12)}% ${String(a.falseTools).padStart(6)} ${String(a.missedTools).padStart(7)}`
  )
}

console.log('\nMULTILINGUAL — per language, correctness not averaged away')
console.log('  model                    lang   n   wrong-script  stray  over-answered  tool-correct')
for (const a of live) {
  for (const lang of ['en', 'te', 'hi']) {
    const set = a.rows.filter(r => !r.error && r.lang === lang)
    if (!set.length) continue
    const spoken = set.filter(r => !r.toolActual)
    console.log(
      `  ${a.cand.id.padEnd(24)} ${lang.padEnd(5)} ${String(set.length).padStart(3)} ${String(spoken.filter(r => r.wrongScript).length).padStart(13)} ` +
      `${String(spoken.filter(r => r.strayScript).length).padStart(6)} ${String(spoken.filter(r => r.overAnswered).length).padStart(14)} ` +
      `${set.filter(r => r.graded).length ? String(Math.round(set.filter(r => r.toolCorrect === true).length / set.filter(r => r.graded).length * 100)).padStart(12) + '%' : '           —'}`
    )
  }
}

console.log('\nRAG QUERY — a Telugu turn should still search in English')
for (const a of live) {
  console.log(`  ${a.cand.id.padEnd(24)} ${a.ragEnglish}/${a.ragTotal} English queries`)
  const eg = a.rows.find(r => r.ragQuery && r.lang === 'te')
  if (eg) console.log(`  ${''.padEnd(24)} e.g. "${eg.ragQuery}"`)
}

// ── Projection ───────────────────────────────────────────────────────────────
// Measured elsewhere in this repo, NOT re-measured here.
const ENDPOINT_MS = Number(process.env.ENDPOINT_MS || 870)
const CHUNKER_MS = 104
const TTS_MS = 422
console.log('\nPROJECTED ordinary first-audio latency (NOT measured end to end)')
console.log(`  endpoint ${ENDPOINT_MS}ms + candidate TTFT + chunker ${CHUNKER_MS}ms + TTS ${TTS_MS}ms`)
console.log('  model                    projected   vs baseline')
for (const a of live.sort((x, y) => (x.ttft ?? 9e9) - (y.ttft ?? 9e9))) {
  const projected = ENDPOINT_MS + (a.ttft || 0) + CHUNKER_MS + TTS_MS
  const baseProjected = ENDPOINT_MS + (baseline?.ttft || 0) + CHUNKER_MS + TTS_MS
  const delta = baseProjected - projected
  console.log(`  ${(a.cand.id + (a.cand.baseline ? ' *' : '')).padEnd(24)} ${String(projected).padStart(7)}ms ${a.cand.baseline ? '   (baseline)' : `   ${delta >= 0 ? '−' : '+'}${Math.abs(delta)}ms`}`)
}

// Also project where KB acknowledgement could start, since that is gated by the tool
// decision rather than by TTFT.
console.log('\nPROJECTED KB acknowledgement start (endpoint + tool decision)')
for (const a of live.sort((x, y) => (x.toolDelta ?? 9e9) - (y.toolDelta ?? 9e9))) {
  console.log(`  ${(a.cand.id + (a.cand.baseline ? ' *' : '')).padEnd(24)} ${String(ENDPOINT_MS + (a.toolDelta || 0)).padStart(7)}ms`)
}

if (baseline) {
  console.log(`\n  Baseline ${baseline.cand.id}: TTFT ${baseline.ttft}ms (p95 ${baseline.ttftP95}ms), tool decision ${baseline.toolDelta}ms.`)
  const better = live.filter(a => !a.cand.baseline && a.ttft != null && baseline.ttft - a.ttft >= 300)
  console.log(better.length
    ? `  ${better.length} candidate(s) beat it by 300ms+ on TTFT: ${better.map(b => `${b.cand.id} (−${baseline.ttft - b.ttft}ms)`).join(', ')}`
    : '  No candidate beat the baseline by the 300ms that would make a migration worth it.')
}
console.log('\nSample sizes are small by design in --screen mode. Re-run finalists with --n=20.')
