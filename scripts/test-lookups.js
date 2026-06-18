// scripts/test-lookups.js — Verify the live-data lookup feature without a phone.
//
// Run:  node scripts/test-lookups.js
//
// It checks four layers, each independently and skipping any that need creds you
// haven't set:
//   1. parseCSV        — pure, always runs
//   2. buildLookupTools — pure, always runs
//   3. runLookup (http) — spins up a LOCAL mock API, no external creds needed
//   4. streamAIReply    — full tool-calling loop end-to-end (needs OPENAI_API_KEY)
//
// Layer 4 proves the model actually decides to call the tool, the lookup runs,
// and the model answers using the returned data — which is the whole point.

import http from 'http'
import { parseCSV, buildLookupTools, runLookup } from '../src/services/lookups.js'
import { streamAIReply, clearHistory } from '../src/services/llm.js'
import 'dotenv/config'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  cond ? pass++ : fail++
}

// ── 1. CSV parsing ───────────────────────────────────────────────────────────
console.log('\n── 1. parseCSV ──')
{
  const csv = 'order_id,status,eta\n4521,Shipped,"Tomorrow, by 6pm"\n4522,Delivered,Yesterday\n'
  const rows = parseCSV(csv)
  ok('parses 2 rows', rows.length === 2)
  ok('keys from header', rows[0].order_id === '4521' && rows[0].status === 'Shipped')
  ok('handles quoted comma', rows[0].eta === 'Tomorrow, by 6pm')
}

// ── 2. Tool spec generation ──────────────────────────────────────────────────
console.log('\n── 2. buildLookupTools ──')
{
  const cfg = {
    lookups: [{
      name: 'Order status',
      description: 'Look up an order by its ID',
      parameters: [{ name: 'order_id', description: 'The order ID', required: true }],
      backend: { type: 'table', dataset: 'orders' },
    }],
  }
  const tools = buildLookupTools(cfg)
  ok('one tool built', tools.length === 1)
  ok('name sanitized', tools[0]?.function?.name === 'order_status', tools[0]?.function?.name)
  ok('param present', !!tools[0]?.function?.parameters?.properties?.order_id)
  ok('disabled → no tools', buildLookupTools({ ...cfg, enable_lookups: false }).length === 0)
}

// ── 3. http backend against a LOCAL mock API ─────────────────────────────────
console.log('\n── 3. runLookup (http backend) ──')
const ORDERS = { '4521': { status: 'Shipped', eta: 'Tomorrow by 6pm' } }
const mock = http.createServer((req, res) => {
  const id = req.url.split('/').pop()
  if (ORDERS[id]) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ORDERS[id])) }
  else { res.writeHead(404); res.end('not found') }
})
await new Promise(r => mock.listen(0, r))
const port = mock.address().port

const httpCfg = {
  lookups: [{
    name: 'lookup_order',
    parameters: [{ name: 'order_id' }],
    backend: { type: 'http', url: `http://localhost:${port}/orders/{order_id}`, method: 'GET' },
  }],
}
{
  const hit = await runLookup(httpCfg, 'lookup_order', { order_id: '4521' })
  ok('returns order data', hit.includes('Shipped'), hit)
  const miss = await runLookup(httpCfg, 'lookup_order', { order_id: '9999' })
  ok('miss handled gracefully', miss.includes('could not') || miss.includes('No matching'), miss)
  const unknown = await runLookup(httpCfg, 'nope', {})
  ok('unknown tool handled', unknown.includes('No lookup named'))
}
mock.close()

// ── 4. Full LLM tool-calling loop (needs OPENAI_API_KEY) ─────────────────────
console.log('\n── 4. streamAIReply tool loop ──')
if (!process.env.OPENAI_API_KEY) {
  console.log('⏭️  skipped (set OPENAI_API_KEY to run the end-to-end loop)')
} else {
  // Re-open the mock so the model's tool call has something to hit.
  const m2 = http.createServer((req, res) => {
    const id = req.url.split('/').pop()
    if (ORDERS[id]) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ORDERS[id])) }
    else { res.writeHead(404); res.end('not found') }
  })
  await new Promise(r => m2.listen(0, r))
  const p2 = m2.address().port

  const cfg = {
    agent_name: 'Sana',
    business_name: 'TestShop',
    enable_lookups: true,
    lookups: [{
      name: 'lookup_order',
      description: 'Look up an order status by its order ID',
      parameters: [{ name: 'order_id', description: 'The order ID', required: true }],
      backend: { type: 'http', url: `http://localhost:${p2}/orders/{order_id}`, method: 'GET' },
    }],
  }

  const sid = 'test-lookup-' + Date.now()
  let reply = ''
  for await (const tok of streamAIReply(sid, 'Where is my order 4521?', cfg)) reply += tok
  clearHistory(sid)
  m2.close()

  console.log(`   agent said: "${reply.trim()}"`)
  ok('answer used live data (mentions Shipped/tomorrow)',
    /shipped|tomorrow|6 ?pm/i.test(reply), reply.trim())
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
