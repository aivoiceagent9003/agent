// scripts/ttft-bench.mjs — what is inside the model's first-token latency?
//
// latency-bench.mjs says the brain is the largest single leg of a caller's wait
// (~1150ms to its first token on an ordinary turn, with no tool call involved).
// That number is useless on its own: it could be thinking, the tool schemas, the
// prompt, the OpenAI-compatibility shim, or simply the distance to the datacentre.
// This isolates each one against the REAL system prompt of a REAL tenant.
//
// Every variant runs the same conversation, so the only thing that differs is the
// thing being tested.
//
// Usage: node scripts/ttft-bench.mjs [tenantName] [--n=5]

import 'dotenv/config'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES } from '../src/services/soniox-cascade.js'

const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').slice(4) || 5)
const tenantName = process.argv.slice(2).find(a => !a.startsWith('--')) || 'GSK insurance'

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

// An ordinary mid-call turn: greeting, one exchange behind it, a question that needs
// no lookup. The shape most turns of a real call actually have.
const MESSAGES = [
  { role: 'system', content: systemPrompt },
  { role: 'assistant', content: tenantConfig.greeting || 'Namaste, GSK insurance నుంచి Aruna మాట్లాడుతున్నాను.' },
  { role: 'user', content: 'ఆ, నేను term insurance గురించి చూస్తున్నాను.' },
  { role: 'assistant', content: 'అవును అండి, మా దగ్గర term insurance options ఉన్నాయి. మీకు ఏ విషయం గురించి తెలుసుకోవాలి?' },
  { role: 'user', content: 'ఆ, నేను బాగున్నాను అండి. చెప్పండి.' },
]

const promptChars = MESSAGES.reduce((n, m) => n + (m.content || '').length, 0)
console.log(`tenant "${tenant.name}" · prompt ${promptChars} chars (~${Math.round(promptChars / 3.5)} tokens) · ${tools.length} tools · n=${N}\n`)

const compat = new OpenAI({ apiKey: process.env.GOOGLE_AI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' })
const genai = process.env.GOOGLE_AI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY }) : null

/** First token through the OpenAI-compatible endpoint. */
async function viaCompat({ model, effort, withTools, messages = MESSAGES }) {
  const params = { model, messages, temperature: 0.3, max_tokens: 200, stream: true }
  if (withTools && tools.length) { params.tools = tools; params.tool_choice = 'auto' }
  if (effort) params.reasoning_effort = effort
  const t0 = Date.now()
  const stream = await compat.chat.completions.create(params)
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta
    if (d?.content || d?.tool_calls?.length) return Date.now() - t0
  }
  return null
}

/** First token through Google's own SDK, which the compat shim sits in front of. */
async function viaNative({ model, effort, withTools, messages = MESSAGES }) {
  if (!genai) return null
  const sys = messages.find(m => m.role === 'system')?.content
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const config = { systemInstruction: sys, temperature: 0.3, maxOutputTokens: 200 }
  if (effort === 'none') config.thinkingConfig = { thinkingBudget: 0 }
  else if (effort) config.thinkingConfig = { thinkingBudget: effort === 'minimal' ? 128 : 512 }
  if (withTools && tools.length) {
    config.tools = [{ functionDeclarations: buildAgentTools(tenantConfig)[0].functionDeclarations }]
  }
  const t0 = Date.now()
  const stream = await genai.models.generateContentStream({ model, contents, config })
  for await (const chunk of stream) {
    if (chunk.text || chunk.functionCalls?.length) return Date.now() - t0
  }
  return null
}

const med = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

async function measure(label, fn, opts) {
  const runs = []
  for (let i = 0; i < N; i++) {
    try { const ms = await fn(opts); if (ms != null) runs.push(ms) } catch (e) {
      console.log(`  ${label.padEnd(44)} FAILED ${String(e.message).slice(0, 70)}`)
      return null
    }
    await new Promise(r => setTimeout(r, 150))
  }
  const m = med(runs)
  const lo = Math.min(...runs), hi = Math.max(...runs)
  console.log(`  ${label.padEnd(44)} ${String(m).padStart(5)}ms   (${lo}–${hi})`)
  return m
}

const MODEL = process.env.CASCADE_LLM_MODEL || 'gemini-3.5-flash-lite'

// `node scripts/ttft-bench.mjs --cliff` runs only the prompt-size sweep, which is the
// question that decides whether cutting the prompt is worth any behavioural risk at all.
if (process.argv.includes('--cliff')) {
  // Real prompt content, cut at section boundaries, so each size is a plausible
  // prompt rather than padding. Trimming from the END keeps the highest-priority
  // rules (identity, language, safety) which is also how a real reduction would go.
  const SECTION_RE = /\n(?=[A-Z][A-Z0-9 ,'’/&#—-]{8,}\n)/
  const sections = systemPrompt.split(SECTION_RE)
  const estTokens = (s) => {
    const indic = (String(s).match(/[ऀ-ॿఀ-౿]/g) || []).length
    return Math.round((s.length - indic) / 4 + indic / 1.2)
  }
  /** The longest prefix of the real prompt that fits inside `target` tokens. */
  function promptOf(target) {
    let out = ''
    for (const s of sections) {
      if (estTokens(out + s) > target) break
      out += s
    }
    return out
  }

  // `--low` characterises the bottom end. It exists because an earlier comparison of
  // the full prompt against an 80-CHARACTER one showed ~380ms and was read as "the
  // prompt costs 380ms". It does not: the step is between a near-empty prompt and a
  // real one, and a real agent cannot live down there.
  const TARGETS = process.argv.includes('--low')
    ? [100, 300, 600, 1000, 1500, 2000, 3000]
    : [2000, 4000, 6000, 8000, 9000, 10000, 11000, 12000]
  console.log('── prompt size vs first token (real prompt content, cut at section boundaries)')
  console.log('  target   actual   TTFT median   p95      spread')
  const seen = []
  for (const target of TARGETS) {
    const body = promptOf(target)
    const actual = estTokens(body) + estTokens(JSON.stringify(tools))
    const msgs = [{ role: 'system', content: body || 'You are a helpful insurance agent.' }, ...MESSAGES.slice(1)]
    const runs = []
    for (let i = 0; i < N; i++) {
      try { const ms = await viaCompat({ model: MODEL, effort: 'minimal', withTools: true, messages: msgs }); if (ms) runs.push(ms) } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 150))
    }
    const sorted = [...runs].sort((a, b) => a - b)
    const m = sorted[Math.floor(sorted.length / 2)]
    const p = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    seen.push({ target, actual, median: m, p95: p })
    console.log(`  ${String(target).padStart(6)}  ${String(actual).padStart(6)}   ${String(m).padStart(8)}ms  ${String(p).padStart(6)}ms   ${sorted[0]}–${sorted.at(-1)}`)
  }
  const lo = seen[0], hi = seen.at(-1)
  const perK = (hi.median - lo.median) / ((hi.actual - lo.actual) / 1000)
  console.log(`\n  From ~${lo.actual} to ~${hi.actual} tokens: ${hi.median - lo.median}ms, i.e. ~${Math.round(perK)}ms per 1000 tokens.`)
  console.log(`  A cut to 8K would therefore be worth roughly ${Math.round(perK * (hi.actual - 8000) / 1000)}ms.`)
  console.log('  Weigh that against what the removed rules were doing before cutting anything.')
  process.exit(0)
}

console.log('── thinking budget (compat endpoint, tools attached, production shape)')
for (const effort of ['none', 'minimal', 'low', null]) {
  await measure(`${MODEL} · reasoning_effort=${effort ?? '(unset)'}`, viaCompat, { model: MODEL, effort, withTools: true })
}

console.log('\n── do the tool schemas cost anything?')
await measure(`${MODEL} · minimal · WITH ${tools.length} tools`, viaCompat, { model: MODEL, effort: 'minimal', withTools: true })
await measure(`${MODEL} · minimal · NO tools`, viaCompat, { model: MODEL, effort: 'minimal', withTools: false })

console.log('\n── does the prompt size matter?')
const tiny = [
  { role: 'system', content: 'You are a helpful insurance agent. Reply in Telugu script, one short sentence.' },
  ...MESSAGES.slice(1),
]
await measure(`${MODEL} · minimal · FULL prompt (${promptChars} chars)`, viaCompat, { model: MODEL, effort: 'minimal', withTools: false })
await measure(`${MODEL} · minimal · TINY prompt (80 chars)`, viaCompat, { model: MODEL, effort: 'minimal', withTools: false, messages: tiny })

console.log('\n── compat shim vs Google\'s own SDK')
await measure(`${MODEL} · minimal · OpenAI-compat`, viaCompat, { model: MODEL, effort: 'minimal', withTools: true })
await measure(`${MODEL} · minimal · native @google/genai`, viaNative, { model: MODEL, effort: 'minimal', withTools: true })

console.log('\n── other models, production shape (compat, tools, minimal)')
for (const m of ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.8-flash']) {
  if (m === MODEL) continue
  await measure(`${m}`, viaCompat, { model: m, effort: 'minimal', withTools: true })
}

console.log(`
Each row is the median of ${N} streamed requests against the same conversation.
The spread in brackets matters as much as the median: a model that is usually fast
and occasionally 2s is still a caller waiting 2s.`)
