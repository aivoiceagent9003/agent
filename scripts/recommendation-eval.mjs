// Read-only regression replay against a tenant's uploaded catalogue.
// node scripts/recommendation-eval.mjs "GSK insurance" [--live]
// --live calls the configured LLM and embedding API; only the read-only KB tool
// is exposed. No phone calls, messages, tenant changes or business actions.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { supabase } from '../src/api/db.js'
import { extractCatalogue, catalogueMatches } from '../src/services/knowledge-selection.js'
import { retrieveKnowledge } from '../src/services/rag.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES, createBrainClient } from '../src/services/soniox-cascade.js'

const name = process.argv.slice(2).find(s => !s.startsWith('--'))
if (!name) throw Error('Pass a tenant name')
const { data: tenant, error } = await supabase.from('tenants').select('id,config').ilike('name', name).single()
if (error) throw Error(error.message)
const contents = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('knowledge_base').select('content').eq('tenant_id', tenant.id).order('id').range(from, from + 999)
  if (error) throw Error(error.message)
  contents.push(...data.map(r => r.content))
  if (data.length < 1000) break
}
const catalogue = extractCatalogue(contents)
const term = catalogueMatches(catalogue, 'term insurance options best plan')
console.log(JSON.stringify({ chunks: contents.length, indexedNames: catalogue.length, termNames: term.map(e => e.name) }, null, 2))
if (!process.argv.includes('--live')) process.exit(0)

const config = { ...tenant.config, tenant_id: tenant.id }
const provider = process.env.CASCADE_LLM_PROVIDER || 'openai'
const model = process.env.CASCADE_LLM_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini')
const client = createBrainClient(provider)
const declarations = buildAgentTools(config)[0].functionDeclarations.filter(t => t.name === 'search_knowledge')
const tools = declarations.map(f => ({ type: 'function', function: f }))
const messages = [{ role: 'system', content: buildSystemPrompt(config, { channel: 'voice' }) + '\n\n' + VOICE_OUTPUT_RULES }]
for (const user of [
  'నేను term insurance గురించి చూస్తున్నాను. మీ దగ్గర ఉన్న best term insurance recommend చేస్తారా?',
  'దాంట్లో variants ఏమైనా ఉన్నాయా? వాటి మధ్య difference ఏంటి?',
]) {
  messages.push({ role: 'user', content: user })
  for (let round = 0; round < 5; round++) {
    const start = Date.now()
    const result = await client.chat.completions.create({
      model, messages, temperature: .3, max_tokens: 400,
      ...(provider === 'gemini' ? { reasoning_effort: process.env.CASCADE_LLM_REASONING_EFFORT || 'none' } : {}),
      ...(round < 4 ? { tools, tool_choice: 'auto' } : {}),
    })
    const reply = result.choices[0].message
    messages.push(reply)
    console.log(`LLM ${Date.now() - start}ms: ${reply.content || '(tool call)'}`)
    if (!reply.tool_calls?.length) break
    for (const tc of reply.tool_calls) {
      assert.equal(tc.function.name, 'search_knowledge')
      const args = JSON.parse(tc.function.arguments)
      const knowledge = await retrieveKnowledge(tenant.id, args.query, 3, { mode: args.mode })
      console.log(`KB ${JSON.stringify(args)} -> ${knowledge.length} chars; catalogue=${knowledge.includes('CATALOGUE DISCOVERY')}`)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: knowledge || 'No matching evidence. Do not invent facts.' })
    }
  }
}
