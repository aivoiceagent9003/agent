// queue/connection.js — shared Redis connection for BullMQ.
//
// One ioredis instance is reused by every queue and worker (BullMQ requires
// maxRetriesPerRequest=null for blocking commands). Redis is OPTIONAL: with no
// REDIS_URL (or CAMPAIGN_RUNNER=inline) the campaign system runs IN-PROCESS via
// src/queue/inline.js — the API still serves everything, campaigns just run without
// a separate worker.

import IORedis from 'ioredis'
import 'dotenv/config'

export const REDIS_URL = process.env.REDIS_URL || ''

// Runner selection: 'auto' (default) uses Redis when a URL is set; 'inline' forces
// the in-process runner and NEVER connects to Redis (so a dead/stale REDIS_URL can't
// spam the logs); 'off' disables campaigns; 'redis' is an explicit alias for auto.
const RUNNER = (process.env.CAMPAIGN_RUNNER || 'auto').toLowerCase()

// Use Redis only when a URL is present AND the runner isn't forced to inline/off.
export const REDIS_ENABLED = !!REDIS_URL && RUNNER !== 'inline' && RUNNER !== 'off'

let _connection = null
let _errLogged = false

export function getConnection() {
  if (!REDIS_ENABLED) return null
  if (_connection) return _connection
  _connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: true,
    lazyConnect: false,
    enableOfflineQueue: false,    // fail fast instead of buffering commands forever
    // Bounded reconnect: stop after ~6 tries so a dead/unreachable host (e.g. an
    // expired free-tier instance) doesn't spam ENOTFOUND endlessly. The clear message
    // tells you exactly how to proceed.
    retryStrategy(times) {
      if (times > 6) {
        console.error(
          `[REDIS] unreachable at ${maskHost(REDIS_URL)} after ${times} attempts — giving up.\n` +
          `        Fix REDIS_URL (managed Redis needs rediss:// + TLS), or set CAMPAIGN_RUNNER=inline\n` +
          `        (or clear REDIS_URL) to run campaigns without Redis.`
        )
        return null   // stop retrying
      }
      return Math.min(times * 500, 3000)
    },
  })
  // Log the first error once (not every reconnect) so the console stays readable.
  _connection.on('error', (e) => {
    if (_errLogged) return
    _errLogged = true
    console.error('[REDIS] error:', e.message, '— campaigns will not run until Redis is reachable (or set CAMPAIGN_RUNNER=inline).')
  })
  _connection.on('connect', () => { _errLogged = false; console.log('[REDIS] connected') })
  return _connection
}

// Hide credentials when logging a URL.
function maskHost(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || 6379}` } catch { return 'redis' }
}

// BullMQ needs a connection option object; return null-safe shape.
export const bullConnection = () => (REDIS_ENABLED ? { connection: getConnection() } : null)
