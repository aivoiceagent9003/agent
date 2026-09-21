// scripts/brain-bench.mjs — which LLM should be the brain of the cascaded engine?
//
// On the first real Soniox call, gpt-4o-mini was half of every wait (904–3092ms to
// its first token) and answered four factual questions WITHOUT searching the
// knowledge base — inventing that there was "no list of companies" and calling two
// insurance plans "companies". This replays that exact call through candidate models
// and measures both problems, instead of guessing which model fixes them.
//
// Same system prompt, same tools, same REAL knowledge-base search as a live call.
// Lookups, WhatsApp, DND and end_call are stubbed — nothing leaves this script.
//
// Usage: node scripts/brain-bench.mjs [tenantName]   (default: GSK insurance)

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'fs'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { retrieveKnowledge } from '../src/services/rag.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools, noKnowledgeInstruction, NO_KNOWLEDGE } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES, createBrainClient } from '../src/services/soniox-cascade.js'

const ALL_CANDIDATES = [
  { provider: 'openai', model: 'gpt-4o-mini' },     // what the call used
  { provider: 'openai', model: 'gpt-4.1-mini' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'gemini', model: 'gemini-3.8-flash' },
]
// --models=gemini-2.5-flash,gemini-3.5-flash runs a subset.
const only = (process.argv.find(a => a.startsWith('--models=')) || '').slice(9).split(',').filter(Boolean)
const CANDIDATES = only.length ? ALL_CANDIDATES.filter(c => only.includes(c.model)) : ALL_CANDIDATES

// The caller's side of the real call, verbatim from the Soniox transcript.
const CALLER_TURNS = [
  'Hello, Aruna. నేను—',
  'ఆ, నేను బాగున్నాను. నేను టర్మ్ ఇన్సూరెన్స్ గురించి చూస్తున్నాను. మీ దగ్గర ఆప్షన్స్ ఏమైనా ఉన్నాయా?',
  'ఆ... మీ దగ్గర టోటల్ ఎన్ని ఇన్సూరెన్స్ కంపెనీస్ ఉన్నాయో చెప్తారా? నాకు ఒకసారి—',
  'నేను ఏం అడుగుతున్నాను? మీ దగ్గర ఇన్సూరెన్స్ కంపెనీస్ ఏవేవి ఉన్నాయి? టర్మ్ ఇన్సూరెన్సెస్, అవి అడుగుతున్నానేమో.',
  'ఆ... సో, మీ దగ్గర మోస్ట్ ఎస్టాబ్లిష్డ్ కంపెనీ ఏది ఉందో చెప్తారా? నాకు ఒకసారి—',
  'ఆ... సంజీవని గురించి చెప్తారా? నాకు కొంచెం—',
  'అవునండి, దాని గురించి చెప్పండి.',
]
// Turns asking for a business fact — each should be answered from the knowledge base.
const FACTUAL = new Set([2, 3, 4, 5, 6, 7])

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
const greeting = tenantConfig.greeting || 'Namaste, I am Aruna from GSK insurance. How can I help you?'

async function runTool(name, args) {
  if (name === 'search_knowledge') return (await retrieveKnowledge(tenant.id, args?.query || '')) || noKnowledgeInstruction(tenantConfig)
  if (name === 'end_call') return 'The call will end as soon as you finish speaking.'
  return 'No matching record found.'   // lookups / WhatsApp / DND: stubbed
}

// Gemini thinks before answering unless told not to, which on a phone call is dead
// air. Try switching thinking off; fall back if a model rejects the setting.
const REASONING = { gemini: ['none', 'minimal', 'low', null], openai: [null] }

async function openStream(client, cand, messages, round) {
  for (const effort of REASONING[cand.provider]) {
    const params = { model: cand.model, messages, temperature: 0.3, max_tokens: 300, stream: true, stream_options: { include_usage: true } }
    if (round < 3) { params.tools = tools; params.tool_choice = 'auto' }
    if (effort) params.reasoning_effort = effort
    try {
      const stream = await client.chat.completions.create(params)
      cand.effortUsed = effort || 'default'
      return stream
    } catch (e) {
      if (effort && /reasoning|thinking|budget|400/i.test(e.message)) continue
      throw e
    }
  }
}

async function replay(cand) {
  const client = createBrainClient(cand.provider)
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'assistant', content: greeting }]
  // Warm up, as the engine does at call start, so turn one is not a cold start.
  await client.chat.completions.create({ model: cand.model, max_tokens: 1, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'hi' }] }).catch(() => {})

  const turns = []
  for (let n = 1; n <= CALLER_TURNS.length; n++) {
    messages.push({ role: 'user', content: CALLER_TURNS[n - 1] })
    const t0 = Date.now()
    let firstDeltaMs = null, firstTextMs = null
    const toolsUsed = []
    let reply = ''
    for (let round = 0; round < 4; round++) {
      const stream = await openStream(client, cand, messages, round)
      const calls = []
      let finish = null, roundText = ''
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        const d = choice.delta || {}
        if ((d.content || d.tool_calls) && firstDeltaMs === null) firstDeltaMs = Date.now() - t0
        for (const tc of d.tool_calls || []) {
          const k = tc.index ?? 0
          calls[k] ||= { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) calls[k].id = tc.id
          if (tc.function?.name) calls[k].function.name += tc.function.name
          if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments
          if (tc.extra_content) calls[k].extra_content = tc.extra_content   // Gemini 3 thought signature
        }
        if (d.content) { if (firstTextMs === null) firstTextMs = Date.now() - t0; roundText += d.content }
      }
      const tcs = calls.filter(Boolean)
      if (tcs.length && (finish === 'tool_calls' || !roundText)) {
        messages.push({ role: 'assistant', content: roundText || null, tool_calls: tcs.map((c, i) => ({ ...c, id: c.id || `call_${n}_${round}_${i}` })) })
        for (const [i, tc] of tcs.entries()) {
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed */ }
          const result = String(await runTool(tc.function.name, args))
          toolsUsed.push(tc.function.name === 'search_knowledge'
            ? `search_knowledge("${args.query}")${result.startsWith(NO_KNOWLEDGE) ? ' MISS' : ''}`
            : tc.function.name)
          messages.push({ role: 'tool', tool_call_id: tc.id || `call_${n}_${round}_${i}`, content: result })
        }
        reply += roundText
        continue
      }
      reply += roundText
      break
    }
    reply = reply.trim()
    messages.push({ role: 'assistant', content: reply || '(no reply)' })
    turns.push({
      n, firstDeltaMs, firstTextMs, totalMs: Date.now() - t0, toolsUsed, reply,
      searched: toolsUsed.some(t => t.startsWith('search_knowledge')),
      markdown: /^\s*(?:[-•*]|\d+[.)])\s/m.test(reply) || /\*\*|\n\s*\n/.test(reply),
    })
  }
  return turns
}

mkdirSync('voice-bench-out', { recursive: true })
const report = [`# Brain benchmark — ${tenant.name}\n`]
const summary = []

for (const cand of CANDIDATES) {
  process.stdout.write(`\n▶ ${cand.provider}/${cand.model} … `)
  let turns
  try { turns = await replay(cand) } catch (e) { console.log(`FAILED: ${String(e.message).slice(0, 160)}`); summary.push({ model: cand.model, error: String(e.message).slice(0, 60) }); continue }
  const noTool = turns.filter(t => !t.toolsUsed.length && t.firstTextMs !== null)
  const withTool = turns.filter(t => t.toolsUsed.length && t.firstTextMs !== null)
  const avg = (xs, k) => xs.length ? Math.round(xs.reduce((a, t) => a + t[k], 0) / xs.length) : null
  const factual = turns.filter(t => FACTUAL.has(t.n))
  const row = {
    model: cand.model,
    thinking: cand.effortUsed,
    'first words, no lookup (ms)': avg(noTool, 'firstTextMs'),
    'first words, with lookup (ms)': avg(withTool, 'firstTextMs'),
    'factual turns that searched KB': `${factual.filter(t => t.searched).length}/${factual.length}`,
    'replies with markdown': turns.filter(t => t.markdown).length,
    'avg reply chars': Math.round(turns.reduce((a, t) => a + t.reply.length, 0) / turns.length),
  }
  summary.push(row)
  console.log(`done — searched ${row['factual turns that searched KB']}, first words ${row['first words, no lookup (ms)']}ms / ${row['first words, with lookup (ms)']}ms`)

  report.push(`\n## ${cand.provider}/${cand.model} (thinking: ${cand.effortUsed})\n`)
  for (const t of turns) {
    report.push(`**${t.n}. Caller:** ${CALLER_TURNS[t.n - 1]}  `)
    report.push(`*first words ${t.firstTextMs ?? '—'}ms · tools: ${t.toolsUsed.join(', ') || 'none'}*  `)
    report.push(`**Agent:** ${t.reply.replace(/\n+/g, ' ⏎ ')}\n`)
  }
}

writeFileSync('voice-bench-out/brain-bench.md', report.join('\n'))
console.log('\n── Summary ──')
console.table(summary)
console.log('Full transcripts per model: voice-bench-out/brain-bench.md')
process.exit(0)
