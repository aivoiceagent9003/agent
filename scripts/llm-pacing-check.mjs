// scripts/llm-pacing-check.mjs — is the candidate slow, or is the account being throttled?
//
// The screening pass put gpt-4.1-mini at 689ms. The deep pass, hammering the same model
// with 76 back-to-back requests, put it at 2062ms — but with a MINIMUM of 617ms. A model
// does not have a bimodal speed; an account under rate limiting does.
//
// This settles it by pacing requests the way a real call does. One AnswerLabs call sends
// roughly one LLM request every 10 seconds (endpoint → model → speak → listen). The
// benchmark was sending eight per second, which is not one call — it is closer to eighty
// concurrent ones. If TTFT recovers at realistic spacing, the deep numbers measured this
// account's rate limit rather than the model.
//
// Also prints the provider's own rate-limit headers, which say plainly what the ceiling is.
//
// Usage: node scripts/llm-pacing-check.mjs [gapSeconds] [n]

import 'dotenv/config'
import { performance } from 'node:perf_hooks'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES } from '../src/services/soniox-cascade.js'

const GAP_S = Number(process.argv[2] || 10)
const N = Number(process.argv[3] || 8)

const { data: tenant } = await supabase.from('tenants').select('*').ilike('name', 'GSK insurance').single()
const tenantConfig = { ...(tenant.config || {}), tenant_id: tenant.id }
const SYSTEM = buildSystemPrompt(tenantConfig, {
  channel: 'voice', whatsapp: whatsappReady(tenantConfig), language: { modelLed: true },
}) + '\n\n' + VOICE_OUTPUT_RULES
const TOOLS = (buildAgentTools(tenantConfig)[0]?.functionDeclarations || []).map(d => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } },
}))

const base = [
  { role: 'system', content: SYSTEM },
  { role: 'assistant', content: 'Namaste, this is Aruna from GSK insurance. How can I help you?' },
  { role: 'user', content: 'I am looking into term insurance.' },
  { role: 'assistant', content: 'Of course. We have a few term insurance options. What would you like to know?' },
]
// Two shapes, because they are gated by different things: an ordinary reply is gated by
// TTFT, a knowledge turn by how fast the model decides it needs a lookup.
const MESSAGES = [...base, { role: 'user', content: 'I already have insurance. Why would I need another policy?' }]
const TOOL_MESSAGES = [...base, { role: 'user', content: 'What is your claim settlement ratio?' }]

const MODELS = [
  { id: 'gpt-4.1-mini', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, effort: null },
  { id: 'gpt-4.1-nano', url: 'https://api.openai.com/v1/chat/completions', key: process.env.OPENAI_API_KEY, effort: null },
  { id: 'gemini-3.5-flash-lite', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GOOGLE_AI_API_KEY, effort: 'minimal' },
]

/** Raw fetch rather than the SDK, so the rate-limit response headers are readable. */
async function once(m, messages = MESSAGES) {
  const body = {
    model: m.id, messages, max_tokens: 200, temperature: 0.3,
    stream_options: { include_usage: true },
    stream: true, tools: TOOLS, tool_choice: 'auto',
    ...(m.effort ? { reasoning_effort: m.effort } : {}),
  }
  const t0 = performance.now()
  const res = await fetch(m.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${m.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const limits = {
    remainingReq: res.headers.get('x-ratelimit-remaining-requests'),
    remainingTok: res.headers.get('x-ratelimit-remaining-tokens'),
    limitReq: res.headers.get('x-ratelimit-limit-requests'),
    limitTok: res.headers.get('x-ratelimit-limit-tokens'),
    resetTok: res.headers.get('x-ratelimit-reset-tokens'),
  }
  if (!res.ok) return { ttft: null, error: `${res.status}: ${(await res.text()).slice(0, 120)}`, limits }

  // The whole stream is read, not just up to the first token: usage (and with it the
  // cached-token count) only arrives in the final frame.
  let buf = '', ttft = null, toolAt = null, sawTool = false
  let cached = null, promptTokens = null
  for await (const part of res.body) {
    buf += Buffer.from(part).toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      try {
        const j = JSON.parse(line.slice(5))
        if (j.usage) {
          promptTokens = j.usage.prompt_tokens ?? promptTokens
          cached = j.usage.prompt_tokens_details?.cached_tokens ?? cached
        }
        const d = j.choices?.[0]?.delta
        if (d?.tool_calls?.length) { sawTool = true; if (toolAt === null) toolAt = performance.now() - t0 }
        if ((d?.content || d?.tool_calls?.length) && ttft === null) ttft = performance.now() - t0
      } catch { /* partial frame */ }
    }
  }
  return {
    ttft: ttft === null ? null : Math.round(ttft),
    toolAt: toolAt === null ? null : Math.round(toolAt),
    sawTool, cached, promptTokens, limits,
  }
}

const med = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

console.log(`One request every ${GAP_S}s — the pace of a single live call — ${N} samples each.\n`)
for (const m of MODELS) {
  const runs = []
  let limits = null
  const toolRuns = []
  let cached = null, promptTokens = null
  for (let i = 0; i < N; i++) {
    const r = await once(m)
    if (r.error) { console.log(`  ${m.id}: ${r.error}`); break }
    runs.push(r.ttft)
    limits = r.limits
    if (r.cached != null) cached = r.cached
    if (r.promptTokens != null) promptTokens = r.promptTokens
    await new Promise(res => setTimeout(res, GAP_S * 1000))
    const t = await once(m, TOOL_MESSAGES)
    if (!t.error && t.sawTool) toolRuns.push(t.toolAt)
    if (i < N - 1) await new Promise(res => setTimeout(res, GAP_S * 1000))
  }
  if (!runs.length) continue
  const sorted = [...runs].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  console.log(`  ${m.id.padEnd(24)} TTFT median ${String(med(runs)).padStart(5)}ms  p95 ${String(p95).padStart(5)}ms  (${sorted[0]}–${sorted.at(-1)})  n=${runs.length}`)
  console.log(`  ${''.padEnd(24)} tool decision median ${String(med(toolRuns) ?? '—').padStart(5)}ms  (${toolRuns.length}/${N} called a tool)`)
  if (promptTokens != null) {
    console.log(`  ${''.padEnd(24)} prompt ${promptTokens} tokens, ${cached ?? 0} served from cache` +
      (cached ? ` (${Math.round(cached / promptTokens * 100)}%)` : ' — caching NOT firing'))
  }
  if (limits?.limitReq) {
    console.log(`  ${''.padEnd(24)} account limits: ${limits.limitReq} req/min, ${limits.limitTok} tok/min` +
      ` · remaining ${limits.remainingReq} req / ${limits.remainingTok} tok`)
  }
}
console.log(`
Compare with the back-to-back run. If the paced median is far lower, the deep benchmark
was measuring this ACCOUNT'S rate limit, not the model — and the relevant question becomes
what tier AnswerLabs would run on, not which model is faster.`)
