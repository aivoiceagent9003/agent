// queue/queues.js — BullMQ queue definitions + typed enqueue helpers.
//
// The queues ARE the "distributed services" boundary: the API produces jobs, the
// worker process (src/worker.js) consumes them. State lives in Redis + Postgres, so
// workers can later scale to multiple hosts with no code change.
//
// Every enqueue is null-safe: if Redis is disabled the helper logs and no-ops so an
// API request never throws just because the queue backend is down (the campaign is
// still persisted and can be resumed once Redis is up).

import { Queue } from 'bullmq'
import { bullConnection, REDIS_ENABLED } from './connection.js'
import * as inline from './inline.js'

// Campaigns run when EITHER Redis (BullMQ worker) or the in-process inline runner is
// available. The API uses this to decide whether to accept campaign actions.
export const CAMPAIGNS_ENABLED = REDIS_ENABLED || inline.INLINE_ENABLED
export const CAMPAIGN_RUNNER = REDIS_ENABLED ? 'redis' : (inline.INLINE_ENABLED ? 'inline' : 'off')

export const QUEUE_NAMES = {
  DIAL: 'campaign-dial',            // one job = one AI outbound call attempt
  BROADCAST: 'campaign-broadcast',  // one job = one TTS broadcast call attempt
  RETRY: 'campaign-retry',          // delayed re-dial per retry policy
  SCHEDULE: 'campaign-schedule',    // repeatable/delayed → expands a run into dial jobs
  ANALYTICS: 'campaign-analytics',  // rolls campaign_logs → campaign_metrics
  SOURCE: 'campaign-source',        // pull contacts from a data source (sheet/db) + poll
}

// Default per-job options: bounded retries with exponential backoff, auto-clean.
const defaultJobOpts = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

const _queues = new Map()

function makeQueue(name) {
  if (!REDIS_ENABLED) return null
  if (_queues.has(name)) return _queues.get(name)
  const q = new Queue(name, { ...bullConnection(), defaultJobOptions: defaultJobOpts })
  _queues.set(name, q)
  return q
}

export const queues = {
  get dial() { return makeQueue(QUEUE_NAMES.DIAL) },
  get broadcast() { return makeQueue(QUEUE_NAMES.BROADCAST) },
  get retry() { return makeQueue(QUEUE_NAMES.RETRY) },
  get schedule() { return makeQueue(QUEUE_NAMES.SCHEDULE) },
  get analytics() { return makeQueue(QUEUE_NAMES.ANALYTICS) },
  get source() { return makeQueue(QUEUE_NAMES.SOURCE) },
}

// ─── Typed enqueue helpers ────────────────────────────────────────────────────
async function add(queue, jobName, data, opts = {}) {
  if (!queue) { console.warn(`[QUEUE] Redis disabled — skipping ${jobName}`); return null }
  try { return await queue.add(jobName, data, opts) }
  catch (e) { console.error(`[QUEUE] enqueue ${jobName} failed:`, e.message); return null }
}

// Enqueue one contact dial (AI Sales). delayMs schedules a retry.
export const enqueueDial = (data, delayMs = 0) =>
  REDIS_ENABLED ? add(queues.dial, 'dial', data, delayMs ? { delay: delayMs } : {})
                : inline.inlineEnqueueDial(data, delayMs)

// Enqueue one broadcast (TTS) call.
export const enqueueBroadcast = (data, delayMs = 0) =>
  REDIS_ENABLED ? add(queues.broadcast, 'broadcast', data, delayMs ? { delay: delayMs } : {})
                : inline.inlineEnqueueBroadcast(data, delayMs)

// Enqueue a retry (re-dial) after policy delay.
export const enqueueRetry = (data, delayMs) =>
  REDIS_ENABLED ? add(queues.retry, 'retry', data, { delay: Math.max(0, delayMs || 0) })
                : inline.inlineEnqueueRetry(data, delayMs)

// Kick off (or schedule) a campaign run expansion.
export const enqueueRun = (data, opts = {}) =>
  REDIS_ENABLED ? add(queues.schedule, 'run', data, opts)
                : inline.inlineEnqueueRun(data)

// One-time scheduled run at a specific date/time. Stable jobId so a campaign can
// only ever have ONE pending scheduled start (re-scheduling replaces it — callers
// must cancelScheduledRun first, since BullMQ ignores adds with an existing jobId).
export const scheduleRunOnce = (campaignId, delayMs) =>
  REDIS_ENABLED ? add(queues.schedule, 'run', { campaignId }, { delay: Math.max(0, delayMs || 0), jobId: `run-once:${campaignId}` })
                : inline.inlineScheduleRunOnce(campaignId, delayMs)

export async function cancelScheduledRun(campaignId) {
  if (!REDIS_ENABLED) return inline.inlineCancelScheduledRun(campaignId)
  if (!queues.schedule) return
  try {
    const job = await queues.schedule.getJob(`run-once:${campaignId}`)
    if (job) await job.remove()
  } catch (e) { console.error('[QUEUE] cancelScheduledRun failed:', e.message) }
}

// Roll up campaign metrics (fire-and-forget after a call finalizes).
export const enqueueAnalytics = (campaignId) =>
  REDIS_ENABLED ? add(queues.analytics, 'rollup', { campaignId })
                : inline.inlineEnqueueAnalytics(campaignId)

// Pull contacts from a data source (Google Sheet / database) once.
export const enqueueSourceSync = (sourceId, delayMs = 0) =>
  REDIS_ENABLED ? add(queues.source, 'sync', { sourceId }, delayMs ? { delay: delayMs } : {})
                : inline.inlineEnqueueSourceSync(sourceId, delayMs)

// Poll a data source on a fixed interval (repeatable job, replaced on re-schedule).
export async function scheduleSourcePoll(sourceId, everyMs) {
  if (!REDIS_ENABLED) return inline.inlineScheduleSourcePoll(sourceId, everyMs)
  if (!queues.source) return null
  try {
    return await queues.source.add('sync', { sourceId }, {
      repeat: { every: Math.max(30_000, everyMs) },
      jobId: `source-poll:${sourceId}`,
    })
  } catch (e) { console.error('[QUEUE] scheduleSourcePoll failed:', e.message); return null }
}

export async function cancelSourcePoll(sourceId) {
  if (!REDIS_ENABLED) return inline.inlineCancelSourcePoll(sourceId)
  if (!queues.source) return
  try {
    const repeatables = await queues.source.getRepeatableJobs()
    for (const r of repeatables) {
      if (r.key?.includes(`source-poll:${sourceId}`) || r.key?.includes(sourceId)) {
        await queues.source.removeRepeatableByKey(r.key)
      }
    }
  } catch (e) { console.error('[QUEUE] cancelSourcePoll failed:', e.message) }
}

// Schedule a recurring run via a BullMQ repeatable job (cron/every).
export async function scheduleRecurring(campaignId, data, repeat) {
  if (!REDIS_ENABLED) return inline.inlineScheduleRecurring(campaignId, data, repeat)
  if (!queues.schedule) return null
  try {
    return await queues.schedule.add('run', data, {
      repeat,                                  // { pattern: cron } | { every: ms }
      jobId: `recurring:${campaignId}`,        // stable id so re-scheduling replaces
    })
  } catch (e) { console.error('[QUEUE] scheduleRecurring failed:', e.message); return null }
}

export async function cancelRecurring(campaignId) {
  if (!REDIS_ENABLED) return inline.inlineCancelRecurring(campaignId)
  if (!queues.schedule) return
  try {
    const repeatables = await queues.schedule.getRepeatableJobs()
    for (const r of repeatables) {
      if (r.id === `recurring:${campaignId}` || r.name === 'run') {
        // match on our jobId key when present
        if (r.key?.includes(campaignId)) await queues.schedule.removeRepeatableByKey(r.key)
      }
    }
  } catch (e) { console.error('[QUEUE] cancelRecurring failed:', e.message) }
}

// Queue depth snapshot for the Real-Time Monitor.
export async function queueCounts() {
  if (!REDIS_ENABLED) return inline.inlineQueueCounts()
  const out = {}
  for (const [key, name] of Object.entries(QUEUE_NAMES)) {
    const q = makeQueue(name)
    if (!q) { out[name] = null; continue }
    try { out[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed') }
    catch { out[name] = null }
  }
  return out
}
