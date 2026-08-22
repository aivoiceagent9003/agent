// worker.js — Campaign worker process (run separately: `npm run worker`).
//
// Registers BullMQ workers that drain the campaign queues with bounded concurrency
// and provider rate-limiting. Kept in a SEPARATE process from the API so heavy
// outbound dialing never competes with request handling or the live voice path.
// State lives in Redis + Postgres, so this can scale to multiple worker hosts.
//
// Concurrency + rate limits are env-tunable to match provider capacity:
//   DIAL_CONCURRENCY (default 25), BROADCAST_CONCURRENCY (default 50),
//   DIAL_RATE_MAX / DIAL_RATE_DURATION_MS (token-bucket per queue).

import { Worker } from 'bullmq'
import { bullConnection, REDIS_ENABLED } from './queue/connection.js'
import { QUEUE_NAMES } from './queue/queues.js'
import { executeDial, executeBroadcast, executeRetry, sweepStaleDialing } from './services/campaigns/execute.js'
import { startRun } from './services/campaigns/enqueue.js'
import { rollupCampaign } from './services/campaigns/analytics.js'
import { syncSource } from './services/campaigns/sources.js'
import { supabase } from './api/db.js'
import 'dotenv/config'

if (!REDIS_ENABLED) {
  console.error('[WORKER] REDIS_URL not set — cannot start workers. Set REDIS_URL and retry.')
  process.exit(1)
}

const N = (k, d) => Number(process.env[k] ?? d)
const conn = bullConnection()

const dialLimiter = { max: N('DIAL_RATE_MAX', 30), duration: N('DIAL_RATE_DURATION_MS', 1000) }

// ─── Dial worker (AI Sales) ───────────────────────────────────────────────────
const dialWorker = new Worker(QUEUE_NAMES.DIAL, async (job) => {
  return executeDial(job.data)
}, { ...conn, concurrency: N('DIAL_CONCURRENCY', 25), limiter: dialLimiter })

// ─── Broadcast worker (TTS) ───────────────────────────────────────────────────
const broadcastWorker = new Worker(QUEUE_NAMES.BROADCAST, async (job) => {
  return executeBroadcast(job.data)
}, { ...conn, concurrency: N('BROADCAST_CONCURRENCY', 50), limiter: dialLimiter })

// ─── Retry worker ─────────────────────────────────────────────────────────────
const retryWorker = new Worker(QUEUE_NAMES.RETRY, async (job) => {
  return executeRetry(job.data)
}, { ...conn, concurrency: N('DIAL_CONCURRENCY', 25), limiter: dialLimiter })

// ─── Scheduler worker (expands a run into per-contact jobs) ────────────────────
const scheduleWorker = new Worker(QUEUE_NAMES.SCHEDULE, async (job) => {
  const { campaignId } = job.data
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).single()
  if (!campaign) return { skipped: 'missing' }
  if (campaign.status === 'paused' || campaign.status === 'archived') return { skipped: campaign.status }
  return startRun(campaign)
}, { ...conn, concurrency: 5 })

// ─── Analytics worker ─────────────────────────────────────────────────────────
const analyticsWorker = new Worker(QUEUE_NAMES.ANALYTICS, async (job) => {
  return rollupCampaign(job.data.campaignId)
}, { ...conn, concurrency: 5 })

// ─── Source worker (pulls contacts from a Google Sheet / database, one-off + poll) ─
const sourceWorker = new Worker(QUEUE_NAMES.SOURCE, async (job) => {
  return syncSource(job.data.sourceId)
}, { ...conn, concurrency: N('SOURCE_CONCURRENCY', 5) })

const workers = { dialWorker, broadcastWorker, retryWorker, scheduleWorker, analyticsWorker, sourceWorker }
for (const [name, w] of Object.entries(workers)) {
  w.on('failed', (job, err) => console.error(`[WORKER:${name}] job ${job?.id} failed:`, err?.message))
  w.on('completed', (job) => console.log(`[WORKER:${name}] job ${job?.id} done`))
}

console.log('[WORKER] campaign workers started:', Object.keys(workers).join(', '))

// Stale-dial sweep: contacts whose call never connected (no answer → no media
// stream → no finalize) are marked no_answer and retried per policy.
const sweepTimer = setInterval(() => {
  sweepStaleDialing()
    .then((n) => { if (n) console.log(`[WORKER] stale-dial sweep: handled ${n} contact(s)`) })
    .catch((e) => console.error('[WORKER] stale-dial sweep failed:', e.message))
}, 60_000)

async function shutdown() {
  console.log('[WORKER] shutting down…')
  clearInterval(sweepTimer)
  await Promise.all(Object.values(workers).map(w => w.close()))
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
