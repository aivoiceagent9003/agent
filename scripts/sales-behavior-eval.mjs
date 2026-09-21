// Synthetic-only model replay. No tenant database, configuration, catalogue,
// transcripts or customer details are read. Facts below are invented test data.
import 'dotenv/config'
import OpenAI from 'openai'
import { buildSystemPrompt } from '../src/services/llm.js'
import { VOICE_OUTPUT_RULES } from '../src/services/soniox-cascade.js'
import { voiceTurnMessages } from '../src/services/voice-turn-context.js'

const provider = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11) || process.env.CASCADE_LLM_PROVIDER || 'openai'
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) || process.env.CASCADE_LLM_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini')
const client = new OpenAI(provider === 'gemini'
  ? { apiKey: process.env.GOOGLE_AI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }
  : { apiKey: process.env.OPENAI_API_KEY })
const facts = `SYNTHETIC TEST CATALOGUE, NOT REAL INSURANCE PRODUCTS.
Cedar Protect Basic and Cedar Protect Plus are term insurance variants from Cedar Demo.
Basic pays the selected cover to the nominee if the insured dies during the policy term;
there is no maturity payout. Plus adds return of premiums on surviving the full term
and costs more. Both offer lump sum or monthly payouts. Critical illness is an OPTIONAL
rider with extra premium, not included automatically. No evidence ranks Cedar above others.
Illustrative annual premiums before tax at age 27: for 1 crore cover Basic 4600 rupees,
Plus 8900 rupees; for 4 crore cover Basic 18400 rupees, Plus 35600 rupees. Actual premiums
depend on underwriting. No confirmed personal quote or policy issuance is available.`
const config = { business_name: 'Cedar Demo', agent_name: 'Mira', tenant_id: 'synthetic-only', enable_handoff: false }
const system = buildSystemPrompt(config, { channel: 'voice', knowledge: facts }) + '\n\n' + VOICE_OUTPUT_RULES
const messages = [{ role: 'system', content: system }]
const scenarios = [
  { name: 'options', user: 'నేను term insurance గురించి చూస్తున్నాను. ఏ options ఉన్నాయి?' },
  { name: 'recommendation', user: 'మీరే ఒకటి suggest చేయండి. నాకు తక్కువ premium ముఖ్యం.' },
  { name: 'explanation', user: 'ఇంకా explain చేయండి. ఎలా work అవుతుంది?' },
  { name: 'unclear_amount', user: 'నా age 27. నాకు ఫోర్ కోట్స్ cover కావాలి. ఎంత premium?' },
  { name: 'correction', user: 'నేను ఫోర్ కోట్స్ cover అన్నాను. మీరు one crore అనుకున్నారు.' },
  { name: 'confirmed_quote', user: '4 crore cover, Basic variant. నా age 27.' },
]
console.log(JSON.stringify({ provider, model, input: 'invented fixture only', scenarios: scenarios.length }))
for (const scenario of scenarios) {
  const startedAt = Date.now()
  messages.push({ role: 'user', content: scenario.user })
  let stream
  for (const effort of provider === 'gemini' ? ['none', 'minimal', 'low', null] : [null]) {
    try {
      stream = await client.chat.completions.create({
        model, messages: voiceTurnMessages(messages), temperature: .3, max_tokens: 500, stream: true,
        ...(effort ? { reasoning_effort: effort } : {}),
      })
      break
    } catch (e) {
      if (e.status !== 400 || effort === null) throw e
    }
  }
  const reply = { role: 'assistant', content: '' }
  for await (const chunk of stream) reply.content += chunk.choices?.[0]?.delta?.content || ''
  messages.push(reply)
  console.log(JSON.stringify({ scenario: scenario.name, elapsedMs: Date.now() - startedAt, reply: reply.content }))
}
