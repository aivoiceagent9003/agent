// telephony/campaign-registry.js — cross-process pending outbound-call context.
//
// The dialer (WORKER process) originates a call and must hand the campaign context
// (campaign/contact/run/config/call_id) to the answer webhook + WS handler, which
// run in the API process. In-memory won't cross processes, so we stash it in Redis
// keyed by correlation_id with a short TTL. Falls back to an in-memory Map when
// Redis is disabled (single-process dev). Read-once semantics on the WS side.

import { getConnection, REDIS_ENABLED } from '../queue/connection.js'

const KEY = (cid) => `campaign:pending:${cid}`
const TTL_SEC = 300
const mem = new Map()   // fallback when Redis disabled

export async function setPending(correlationId, data) {
  if (!correlationId) return
  if (REDIS_ENABLED) {
    try { await getConnection().set(KEY(correlationId), JSON.stringify(data), 'EX', TTL_SEC); return } catch {}
  }
  mem.set(correlationId, data)
  setTimeout(() => mem.delete(correlationId), TTL_SEC * 1000).unref?.()
}

// Peek without deleting — the answer webhook may fire before the WS connects.
export async function peekPending(correlationId) {
  if (!correlationId) return null
  if (REDIS_ENABLED) {
    try { const v = await getConnection().get(KEY(correlationId)); return v ? JSON.parse(v) : null } catch {}
  }
  return mem.get(correlationId) || null
}

// Take (read + delete) — the WS 'start' consumes the context exactly once.
export async function takePending(correlationId) {
  if (!correlationId) return null
  if (REDIS_ENABLED) {
    try {
      const c = getConnection()
      const v = await c.get(KEY(correlationId))
      if (v) await c.del(KEY(correlationId))
      return v ? JSON.parse(v) : null
    } catch {}
  }
  const v = mem.get(correlationId) || null
  mem.delete(correlationId)
  return v
}
