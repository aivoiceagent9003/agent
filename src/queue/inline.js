// queue/inline.js — Redis-free, in-process campaign runner.
//
// When REDIS_URL is unset, campaigns still run: this module is a drop-in for the
// BullMQ transport (queues.js delegates to it). It keeps a bounded-concurrency,
// rate-limited pool for dial/broadcast/retry, plus timers for scheduled/recurring
// runs and source polling — all inside the API process. State of record still lives
// in Postgres (campaign_contacts.status etc.), so a restart resumes cleanly.
//
// Trade-offs vs Redis (deliberate, documented): SINGLE process only (running two API
// instances would double-dial); recurring supports interval (`every_ms`), not cron;
// the pool shares the API event loop (fine — dialing is I/O-bound). For horizontal
// scale or cron-durable schedules, set REDIS_URL and run `npm run worker` instead.
//
// The campaign services (execute/enqueue/sources/analytics) are imported LAZILY via
// dynamic import() so there is no load-time import cycle with queues.js.

import { REDIS_ENABLED } from './connection.js'
import 'dotenv/config'

// Inline auto-activates only when Redis is absent. CAMPAIGN_RUNNER=off disables
// campaigns entirely (the API then returns 503, matching the old no-Redis behaviour).
export const INLINE_ENABLED = !REDIS_ENABLED && process.env.CAMPAIGN_RUNNER !== 'off'

const N = (k, d) => Number(process.env[k] ?? d)
const CONCURRENCY = N('DIAL_CONCURRENCY', 25)
const RATE_MAX = N('DIAL_RATE_MAX', 30)
const RATE_MS = N('DIAL_RATE_DURATION_MS', 1000)

// Lazy module resolver — avoids a static import cycle (queues → inline → execute → queues).
let _mods = null
async function mods() {
  if (_mods) return _mods
  const [execute, enqueue, analytics, sources, db] = await Promise.all([
    import('../services/campaigns/execute.js'),
    import('../services/campaigns/enqueue.js'),
    import('../services/campaigns/analytics.js'),
    import('../services/campaigns/sources.js'),
    import('../api/db.js'),
  ])
  _mods = { execute, enqueue, analytics, sources, supabase: db.supabase }
  return _mods
}

// ─── Bounded-concurrency, rate-limited pool (mirrors the worker's dial limiter) ──
const pending = []
let active = 0
let tokens = RATE_MAX
const counts = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 }

// Fixed-window token refill; pump on each refill so rate-limited work resumes.
setInterval(() => { tokens = RATE_MAX; pump() }, RATE_MS).unref?.()

function pump() {
  while (active < CONCURRENCY && pending.length && tokens > 0) {
    tokens--
    const thunk = pending.shift()
    counts.waiting = pending.length
    active++; counts.active = active
    Promise.resolve()
      .then(thunk)
      .then(() => { counts.completed++ })
      .catch((e) => { counts.failed++; console.error('[INLINE] job failed:', e?.message) })
      .finally(() => { active--; counts.active = active; pump() })
  }
}

function submit(thunk) {
  pending.push(thunk)
  counts.waiting = pending.length
  pump()
}

// Delay a job (retry / one-off) without holding the pool; it enters the pool when due.
function later(thunk, delayMs) {
  counts.delayed++
  const t = setTimeout(() => { counts.delayed = Math.max(0, counts.delayed - 1); submit(thunk) }, Math.max(0, delayMs))
  t.unref?.()
}

// ─── Timer registries (so cancels can clear them) ────────────────────────────────
const runOnceTimers = new Map()   // campaignId → Timeout
const recurringTimers = new Map() // campaignId → Interval
const sourcePollTimers = new Map()// sourceId   → Interval

// ─── Enqueue helpers (same signatures queues.js exposes) ─────────────────────────
export function inlineEnqueueDial(data, delayMs = 0) {
  const run = async () => (await mods()).execute.executeDial(data)
  delayMs > 0 ? later(run, delayMs) : submit(run)
  return { id: 'inline' }
}

export function inlineEnqueueBroadcast(data, delayMs = 0) {
  const run = async () => (await mods()).execute.executeBroadcast(data)
  delayMs > 0 ? later(run, delayMs) : submit(run)
  return { id: 'inline' }
}

export function inlineEnqueueRetry(data, delayMs = 0) {
  const run = async () => (await mods()).execute.executeRetry(data)
  later(run, delayMs)
  return { id: 'inline' }
}

// Expand a campaign run (pull contacts → enqueue per-contact dials). Runs off the
// rate-limited pool (it's a DB expansion, not a provider call).
export function inlineEnqueueRun(data) {
  ;(async () => {
    try {
      const { supabase, enqueue } = await mods()
      const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', data.campaignId).single()
      if (!campaign || campaign.status === 'paused' || campaign.status === 'archived') return
      await enqueue.startRun(campaign)
    } catch (e) { console.error('[INLINE] run expansion failed:', e.message) }
  })()
  return { id: 'inline' }
}

export function inlineScheduleRunOnce(campaignId, delayMs) {
  inlineCancelScheduledRun(campaignId)
  const t = setTimeout(() => { runOnceTimers.delete(campaignId); inlineEnqueueRun({ campaignId }) }, Math.max(0, delayMs))
  t.unref?.()
  runOnceTimers.set(campaignId, t)
  return { id: 'inline' }
}

export function inlineCancelScheduledRun(campaignId) {
  const t = runOnceTimers.get(campaignId)
  if (t) { clearTimeout(t); runOnceTimers.delete(campaignId) }
}

export function inlineScheduleRecurring(campaignId, _data, repeat) {
  inlineCancelRecurring(campaignId)
  if (repeat?.every) {
    const iv = setInterval(() => inlineEnqueueRun({ campaignId }), Math.max(30_000, repeat.every))
    iv.unref?.()
    recurringTimers.set(campaignId, iv)
  } else {
    // Cron patterns need a scheduler we don't ship inline — be honest, don't silently drop.
    console.warn(`[INLINE] cron recurring not supported without Redis (campaign ${campaignId}); use an interval (every_ms) or set REDIS_URL.`)
  }
  return { id: 'inline' }
}

export function inlineCancelRecurring(campaignId) {
  const iv = recurringTimers.get(campaignId)
  if (iv) { clearInterval(iv); recurringTimers.delete(campaignId) }
}

export function inlineEnqueueSourceSync(sourceId, delayMs = 0) {
  const run = async () => (await mods()).sources.syncSource(sourceId)
  if (delayMs > 0) later(run, delayMs)
  else run().catch((e) => console.error('[INLINE] source sync failed:', e.message))
  return { id: 'inline' }
}

export function inlineScheduleSourcePoll(sourceId, everyMs) {
  inlineCancelSourcePoll(sourceId)
  const iv = setInterval(() => inlineEnqueueSourceSync(sourceId), Math.max(30_000, everyMs))
  iv.unref?.()
  sourcePollTimers.set(sourceId, iv)
  return { id: 'inline' }
}

export function inlineCancelSourcePoll(sourceId) {
  const iv = sourcePollTimers.get(sourceId)
  if (iv) { clearInterval(iv); sourcePollTimers.delete(sourceId) }
}

export function inlineEnqueueAnalytics(campaignId) {
  ;(async () => {
    try { await (await mods()).analytics.rollupCampaign(campaignId) }
    catch (e) { console.error('[INLINE] analytics failed:', e.message) }
  })()
  return { id: 'inline' }
}

// Monitor shape: report the single pool under the dial queue, others empty.
export function inlineQueueCounts() {
  return {
    'campaign-dial': { waiting: counts.waiting, active: counts.active, delayed: counts.delayed, failed: counts.failed, completed: counts.completed },
    'campaign-broadcast': null, 'campaign-retry': null, 'campaign-schedule': null,
    'campaign-analytics': null, 'campaign-source': null,
  }
}

// ─── Startup: sweep + resume (call once from index.js when INLINE_ENABLED) ───────
let started = false
export async function startInlineRunner() {
  if (started || !INLINE_ENABLED) return
  started = true
  console.log(`[INLINE] campaign runner active (no Redis) — concurrency=${CONCURRENCY}, rate=${RATE_MAX}/${RATE_MS}ms`)

  const { supabase, execute } = await mods()

  // Retention runs here as well as in the worker. The two are mutually exclusive —
  // inline only activates when Redis is absent, and the worker requires it — so
  // this covers the single-process path without any risk of both running.
  const { startRetentionSchedule } = await import('../jobs/retention.js')
  startRetentionSchedule()

  // Stale-dial sweep (mirrors worker.js): contacts stuck 'dialing' → no_answer + retry.
  setInterval(() => {
    execute.sweepStaleDialing()
      .then((n) => { if (n) console.log(`[INLINE] stale-dial sweep handled ${n} contact(s)`) })
      .catch((e) => console.error('[INLINE] sweep failed:', e.message))
  }, 60_000).unref?.()

  // Resume anything mid-flight / scheduled before the restart. Contact status lives
  // in Postgres, so re-expanding a running campaign only re-dials pending/no_answer.
  try {
    const { data: campaigns } = await supabase
      .from('campaigns').select('id, status, schedule').in('status', ['running', 'scheduled'])
    for (const c of campaigns || []) {
      const sched = c.schedule || {}
      if (c.status === 'running') {
        inlineEnqueueRun({ campaignId: c.id })
        if (sched.mode === 'recurring' && sched.every_ms) inlineScheduleRecurring(c.id, { campaignId: c.id }, { every: sched.every_ms })
      } else if (c.status === 'scheduled' && sched.start_at) {
        const delay = new Date(sched.start_at).getTime() - Date.now()
        delay > 0 ? inlineScheduleRunOnce(c.id, delay) : inlineEnqueueRun({ campaignId: c.id })
      }
    }
    if (campaigns?.length) console.log(`[INLINE] resumed ${campaigns.length} campaign(s) after restart`)
  } catch (e) {
    console.error('[INLINE] resume failed:', e.message)
  }
}
