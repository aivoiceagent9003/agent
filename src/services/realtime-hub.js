// services/realtime-hub.js — in-process fan-out to connected dashboard users.
//
// Keeps a registry of live WebSockets keyed by profile id, so the API can push a
// new message or notification to exactly the people who should see it. Used by
// /messages-stream (see src/index.js).
//
// ⚠️ SINGLE-INSTANCE. Like telemetry.js, this registry lives in one process: with
// two API instances behind a load balancer, a user connected to instance A will not
// receive a push originating on instance B. The REST endpoints are the source of
// truth and the client refetches on focus, so the failure mode is "delivery is
// delayed until the next poll/refetch", not lost data. Scaling out means putting a
// Redis pub/sub relay in publish() — REDIS_URL is already wired for campaigns.

const sockets = new Map()   // profileId -> Set<ws>

export function register(profileId, ws) {
  if (!profileId || !ws) return () => {}
  if (!sockets.has(profileId)) sockets.set(profileId, new Set())
  sockets.get(profileId).add(ws)

  return function unregister() {
    const set = sockets.get(profileId)
    if (!set) return
    set.delete(ws)
    if (!set.size) sockets.delete(profileId)
  }
}

// Send one event to one person (all their open tabs).
export function publish(profileId, event) {
  const set = sockets.get(profileId)
  if (!set || !set.size) return 0
  const payload = JSON.stringify(event)
  let delivered = 0
  for (const ws of set) {
    // 1 === OPEN. Never throw out of a publish — a dead socket must not break the
    // request that triggered it.
    try {
      if (ws.readyState === 1) { ws.send(payload); delivered++ }
    } catch { /* socket is going away; its close handler will unregister it */ }
  }
  return delivered
}

export function publishMany(profileIds, event) {
  let delivered = 0
  for (const id of new Set(profileIds || [])) delivered += publish(id, event)
  return delivered
}

export function isOnline(profileId) {
  const set = sockets.get(profileId)
  return !!(set && set.size)
}

// Which of these people currently have a socket open — powers presence dots.
export function onlineAmong(profileIds) {
  return (profileIds || []).filter(isOnline)
}

export function connectionCount() {
  let n = 0
  for (const set of sockets.values()) n += set.size
  return n
}

export default { register, publish, publishMany, isOnline, onlineAmong, connectionCount }
