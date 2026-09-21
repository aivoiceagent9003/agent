// scripts/live-shape-bench.mjs — benchmark the request a CALL actually sends.
//
// Two model recommendations in a row predicted a latency win that a real call did not
// deliver (gpt-4.1-mini, then gemini-3.1-flash-lite — the latter came out twice as slow
// live as it benchmarked). Both predictions came from the same flawed shape: the SAME
// request sent over and over.
//
// A repeated identical request is the best case a cache can have. A real turn is the
// worst: voiceTurnMessages rewrites the tail of the system message every turn (the
// questions-already-asked list changes), the history grows, and knowledge searches drop
// ~2000 tokens of KB text into it. So every live turn is a partial cache MISS followed
// by a cache WRITE, and a write is not free.
//
// This measures both, on the same model, back to back:
//   REPEATED  the same request N times      — what the old benchmarks measured
//   EVOLVING  a real conversation unfolding — what a caller actually experiences
//
// If EVOLVING is much slower, the old numbers were never predictive and the gap is the
// thing to report.
//
// Usage: node scripts/live-shape-bench.mjs [gapSeconds] [turns] --models=a,b

import 'dotenv/config'
import { performance } from 'node:perf_hooks'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES } from '../src/services/soniox-cascade.js'
import { voiceTurnMessages } from '../src/services/voice-turn-context.js'

const GAP_S = Number(process.argv[2] || 8)
const TURNS = Number(process.argv[3] || 6)
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const MODELS = (arg('models', 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')).split(',').filter(Boolean)

const { data: t } = await supabase.from('tenants').select('*').ilike('name', 'GSK insurance').single()
const cfg = { ...(t.config || {}), tenant_id: t.id }
const SYSTEM = buildSystemPrompt(cfg, { channel: 'voice', whatsapp: whatsappReady(cfg), language: { modelLed: true } }) + '\n\n' + VOICE_OUTPUT_RULES
const TOOLS = (buildAgentTools(cfg)[0]?.functionDeclarations || []).map(d => ({
  type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } },
}))

// A real Telugu term-insurance call, verbatim in shape: questions, a knowledge search
// that leaves KB text behind, follow-ups that build on earlier answers.
const KB_RESULT = ('LifeShield Secure is a pure protection term plan. Sum assured 50 lakh to 10 crore. Policy term 10-40 years. ' +
  'Entry age 18-65. Riders: critical illness, accidental death benefit, waiver of premium. Age 25, 5 crore cover: ' +
  'indicative annual premium 21000 rupees before tax. Supreme variant with return of premium: 39900 rupees. ').repeat(5)

const CALLER = [
  'హలో, నేను టర్మ్ ఇన్సూరెన్స్ గురించి చూస్తున్నాను. ఆప్షన్స్ ఏమైనా ఉన్నాయా?',
  'నేను 5 క్రోర్స్ టర్మ్ ప్లాన్ గురించి చూస్తున్నాను. నా ఏజ్ 25 అండి.',
  'సుప్రిమ్ వేరియంట్‌కి నార్మల్ వేరియంట్‌కి డిఫరెన్స్ ఏందో చెప్తారా?',
  'నాకు ప్రీమియం ఎంత పడుతుందో చెప్పండి ఒకసారి.',
  'నేను నాన్-స్మోకర్ అండి. నా ఆక్యుపేషన్ సాఫ్ట్‌వేర్.',
  'నేను ఒక 20 ఇయర్స్ దాకా తీసుకోవాలనుకుంటున్నాను.',
  'మీ దగ్గర ఏ కంపెనీస్ ఉన్నాయో చెప్పండి.',
  'మీరే ఒకటి సజెస్ట్ చేయండి.',
]
const AGENT = [
  'తప్పకుండా అండి. మన దగ్గర LifeShield ప్లాన్ ఉంది. మీకు ఎంత cover కావాలి?',
  '5 క్రోర్స్ కవర్ కోసం Secure మరియు Supreme అని రెండు variants ఉన్నాయి. రైడర్స్ కావాలా?',
  'Supreme లో return of premium ఉంటుంది. Secure మంచి సరళమైన ఎంపిక.',
  'ఖచ్చితమైన premium కోసం మీ వివరాలు కావాలి అండి.',
  'ధన్యవాదాలు. పాలసీ ఎన్ని సంవత్సరాలు కావాలి?',
  '20 సంవత్సరాలకి indicative premium 21000 rupees ఉంటుంది.',
  'Sampoorna, Rakshak, Prithvi కంపెనీల ప్లాన్లు ఉన్నాయి.',
]

/** The exact message array the engine builds for turn `n` of a live call. */
function liveMessages(n) {
  const history = [{ role: 'system', content: SYSTEM }]
  for (let i = 0; i < n; i++) {
    history.push({ role: 'user', content: CALLER[i % CALLER.length] })
    // Turn 2 does a knowledge search, and its result stays in history for good.
    if (i === 1) {
      history.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"term insurance 5 crore"}' } }] })
      history.push({ role: 'tool', tool_call_id: 'c1', content: KB_RESULT })
    }
    history.push({ role: 'assistant', content: AGENT[i % AGENT.length] })
  }
  history.push({ role: 'user', content: CALLER[n % CALLER.length] })
  return voiceTurnMessages(history)
}

async function ttft(model, messages) {
  const body = {
    model, messages, temperature: 0.3, max_tokens: 200, stream: true,
    stream_options: { include_usage: true }, tools: TOOLS, tool_choice: 'auto',
  }
  const t0 = performance.now()
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GOOGLE_AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { err: `${res.status}: ${(await res.text()).slice(0, 110)}` }
  let buf = '', first = null, prompt = null, cached = null
  for await (const part of res.body) {
    buf += Buffer.from(part).toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      try {
        const j = JSON.parse(line.slice(5))
        if (j.usage) { prompt = j.usage.prompt_tokens ?? prompt; cached = j.usage.prompt_tokens_details?.cached_tokens ?? cached }
        const d = j.choices?.[0]?.delta
        if ((d?.content || d?.tool_calls?.length) && first === null) first = performance.now() - t0
      } catch { /* partial frame */ }
    }
  }
  return { ttft: first === null ? null : Math.round(first), prompt, cached: cached ?? 0 }
}

const med = (a) => { const s = a.filter(n => n != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

console.log(`One request every ${GAP_S}s, ${TURNS} turns. Same models, two request shapes.\n`)
for (const model of MODELS) {
  // REPEATED — what the earlier benchmarks did. Best case for a cache.
  const rep = [], repCache = []
  const fixed = liveMessages(3)
  for (let i = 0; i < TURNS; i++) {
    const r = await ttft(model, fixed)
    if (r.err) { console.log(`  ${model}: ${r.err}`); break }
    rep.push(r.ttft); repCache.push(r.cached)
    await new Promise(x => setTimeout(x, GAP_S * 1000))
  }
  // EVOLVING — what a caller gets. Every turn is a new prefix tail.
  const evo = [], evoCache = []
  let prompt = null
  for (let i = 0; i < TURNS; i++) {
    const r = await ttft(model, liveMessages(i + 1))
    if (r.err) { console.log(`  ${model}: ${r.err}`); break }
    evo.push(r.ttft); evoCache.push(r.cached); prompt = r.prompt
    await new Promise(x => setTimeout(x, GAP_S * 1000))
  }
  if (!rep.length || !evo.length) continue
  const cachePct = (c, p) => p ? `${Math.round(med(c) / p * 100)}%` : '—'
  console.log(`  ${model}`)
  console.log(`    REPEATED (old bench shape)  ${String(med(rep)).padStart(5)}ms   ${Math.min(...rep)}–${Math.max(...rep)}   cached ${cachePct(repCache, prompt)}`)
  console.log(`    EVOLVING (a real call)      ${String(med(evo)).padStart(5)}ms   ${Math.min(...evo)}–${Math.max(...evo)}   cached ${cachePct(evoCache, prompt)}`)
  console.log(`    → a live turn costs ${med(evo) - med(rep) >= 0 ? '+' : ''}${med(evo) - med(rep)}ms more than the benchmark suggested\n`)
}
console.log('EVOLVING is the number to trust. It is the only one a caller ever experiences.')
