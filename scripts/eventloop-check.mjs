// scripts/eventloop-check.mjs — is anything at call start starving the caller's audio?
//
// A real call showed "greeting first audio 5181ms after the call connected" against
// ~1200ms when nothing is in the way, with "[RAG] loaded 634 chunks into memory in
// 3229ms" sitting in the middle of it. Slow I/O would not have done that — the greeting
// is a separate socket. Blocking the single thread would, because the TTS audio coming
// back has to be picked up by that thread and handed to Plivo.
//
// This measures the block directly: a timer that should fire every 20ms (one µ-law
// frame) is watched while the index loads. However late it runs is how long the caller
// heard nothing.
//
// Usage: node scripts/eventloop-check.mjs [tenantName]

import 'dotenv/config'
import { performance } from 'node:perf_hooks'
import { supabase } from '../src/api/db.js'
import { warmupRAG } from '../src/services/rag.js'

const tenantName = process.argv[2] || 'GSK insurance'
const { data: tenant, error } = await supabase.from('tenants').select('id, name').ilike('name', tenantName).single()
if (error || !tenant) { console.log(`tenant "${tenantName}" not found`); process.exit(1) }

// A 20ms heartbeat, the cadence at which agent audio is framed for Plivo. Every
// millisecond this runs late is a millisecond the caller's audio could not be served.
const lags = []
let last = performance.now()
const beat = setInterval(() => {
  const now = performance.now()
  lags.push(now - last - 20)
  last = now
}, 20)

console.log(`Loading "${tenant.name}" knowledge index while watching a 20ms heartbeat…\n`)
const t0 = performance.now()
await warmupRAG(tenant.id)
// The load is started in the background by warmupRAG, so give it time to finish.
await new Promise(r => setTimeout(r, 12000))
clearInterval(beat)

const over = lags.filter(l => l > 50).sort((a, b) => b - a)
const total = lags.filter(l => l > 0).reduce((s, l) => s + l, 0)
console.log(`  elapsed            ${Math.round(performance.now() - t0)}ms`)
console.log(`  heartbeats         ${lags.length}`)
console.log(`  worst single block ${Math.round(Math.max(...lags))}ms`)
console.log(`  blocks over 50ms   ${over.length}${over.length ? ` (${over.slice(0, 6).map(n => Math.round(n) + 'ms').join(', ')}${over.length > 6 ? ' …' : ''})` : ''}`)
console.log(`  total lateness     ${Math.round(total)}ms`)
console.log(`
The worst single block is the one that matters: it is the longest stretch in which no
agent audio could reach the caller. Anything over ~200ms is audible on a phone call.`)
