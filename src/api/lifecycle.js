// api/lifecycle.js — process lifecycle: health, drain, crash visibility.
//
// These three belong together because they are one story: an orchestrator needs
// to know when we are alive (health), we need to finish what we started when it
// takes us away (drain), and when we die unexpectedly somebody has to hear about
// it (crash handlers).

import { supabase } from './db.js'
import telemetry from '../services/telemetry.js'
import { notify } from '../services/notify.js'

const BOOTED_AT = Date.now()

// ─── Health ───────────────────────────────────────────────────────────────────
// Two endpoints, deliberately different:
//
//   /health       liveness. Answers "is this process running?" with NO dependency
//                 checks. If it checked Supabase, a Supabase blip would make the
//                 orchestrator kill and restart every replica — turning a partial
//                 outage into a total one.
//   /health/ready readiness. Answers "should traffic come here?" and DOES check
//                 dependencies, so a replica that cannot reach the database is
//                 pulled from the load balancer without being killed.
export function mountHealth(app, { draining }) {
  app.get('/health', (_req, res) => {
    // A draining process must fail its health check so the load balancer stops
    // sending it new calls while it finishes the ones it already has.
    if (draining()) return res.status(503).json({ ok: false, status: 'draining' })
    res.json({ ok: true, uptime_s: Math.round((Date.now() - BOOTED_AT) / 1000) })
  })

  app.get('/health/ready', async (_req, res) => {
    if (draining()) return res.status(503).json({ ok: false, status: 'draining' })

    const checks = {}
    let ok = true

    const t0 = Date.now()
    try {
      const { error } = await supabase
        .from('tenants').select('id', { count: 'exact', head: true }).limit(1)
      checks.supabase = error ? { ok: false, error: error.message } : { ok: true, ms: Date.now() - t0 }
      if (error) ok = false
    } catch (e) {
      checks.supabase = { ok: false, error: e.message }
      ok = false
    }

    try {
      const { REDIS_ENABLED, getConnection } = await import('../queue/connection.js')
      if (!REDIS_ENABLED) {
        checks.redis = { ok: true, skipped: 'not configured' }
      } else {
        const t1 = Date.now()
        await getConnection().ping()
        checks.redis = { ok: true, ms: Date.now() - t1 }
      }
    } catch (e) {
      checks.redis = { ok: false, error: e.message }
      ok = false
    }

    res.status(ok ? 200 : 503).json({ ok, checks })
  })
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Without this, every deploy kills live calls mid-sentence. The call handlers run
// finalize() on socket close — saving the transcript, extracting the lead,
// uploading the recording — so the whole job here is to CLOSE THE SOCKETS and
// give those handlers time to finish, rather than letting the process vanish.
//
// Closing with 1001 ("going away") is what triggers each handler's close path.
export function installShutdown({ server, socketServers, graceMs }) {
  let draining = false
  const isDraining = () => draining
  const liveSockets = () => socketServers.reduce((n, wss) => n + wss.clients.size, 0)

  async function shutdown(signal) {
    if (draining) return   // a second Ctrl-C shouldn't restart the sequence
    draining = true

    console.log(`[LIFECYCLE] ${signal} received — draining ${liveSockets()} live socket(s), grace ${graceMs}ms`)
    telemetry.recordServiceEvent({
      component: 'process', severity: 'info', kind: 'shutdown_started',
      detail: { signal, liveSockets: liveSockets() },
    })

    // Stop accepting new connections; in-flight requests keep their sockets.
    server.close(() => console.log('[LIFECYCLE] HTTP listener closed'))

    for (const wss of socketServers) {
      for (const client of wss.clients) {
        try { client.close(1001, 'server shutting down') } catch { /* already gone */ }
      }
    }

    // Poll rather than sleeping the whole grace period: a process with no live
    // calls should exit at once, not sit there for fifteen seconds.
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (liveSockets() === 0) {
        console.log('[LIFECYCLE] all sockets drained')
        break
      }
      await new Promise(r => setTimeout(r, 250))
    }

    const stragglers = liveSockets()
    if (stragglers) console.warn(`[LIFECYCLE] grace expired with ${stragglers} socket(s) still open`)
    console.log('[LIFECYCLE] exiting')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return { isDraining }
}

// ─── Startup reconciliation ───────────────────────────────────────────────────
// Calls whose process died mid-conversation stay at status='active' forever,
// quietly inflating "live calls" on every dashboard that counts them. Any row
// still active well past the longest plausible call is one of those.
export async function reconcileOrphanedCalls({ olderThanHours = 2 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString()
  try {
    const { data, error } = await supabase
      .from('calls')
      .update({ status: 'interrupted' })
      .eq('status', 'active')
      .lt('created_at', cutoff)
      .select('id')
    if (error) throw error
    const n = data?.length || 0
    if (n) {
      console.log(`[LIFECYCLE] reconciled ${n} orphaned call row(s) to interrupted`)
      telemetry.recordServiceEvent({
        component: 'process', severity: 'warning', kind: 'orphaned_calls_reconciled',
        detail: { count: n, olderThanHours },
      })
    }
    return n
  } catch (e) {
    console.warn('[LIFECYCLE] orphaned-call reconciliation skipped:', e.message)
    return 0   // never block boot on bookkeeping
  }
}

// ─── Crash visibility ─────────────────────────────────────────────────────────
export function installCrashHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('[CRASH] unhandled rejection:', reason instanceof Error ? reason.stack : String(reason))
    telemetry.recordServiceEvent({
      component: 'process', severity: 'error', kind: 'unhandled_rejection',
      detail: { message: String(reason?.message || reason).slice(0, 500) },
    })
    // Deliberately NOT fatal: one rejected promise in a background job should not
    // hang up every call in progress.
    //
    // Sent at "error", below the default critical threshold, so it lands in the
    // log and the dashboard without waking anyone. Keyed on the message so a
    // rejection firing in a loop is reported once per cooldown, not per event.
    notify({
      title: 'Unhandled promise rejection',
      body: reason instanceof Error ? (reason.stack || reason.message) : String(reason),
      severity: 'error',
      key: `rejection:${String(reason?.message || reason).slice(0, 120)}`,
    })
  })

  process.on('uncaughtException', (err) => {
    console.error('[CRASH] uncaught exception:', err.stack || err.message)
    telemetry.recordServiceEvent({
      component: 'process', severity: 'critical', kind: 'uncaught_exception',
      detail: { message: String(err?.message || err).slice(0, 500) },
    })
    // This one IS fatal. After an uncaught exception the process is in an
    // undefined state, and a voice agent that half-works is worse than one the
    // orchestrator restarts. Exit non-zero so it actually does get restarted.
    //
    // Before dying, tell somebody. force:true bypasses both the severity filter
    // and the cooldown — a crash is never the thing to suppress, and if the
    // process is crash-looping every restart is worth knowing about.
    //
    // The exit is NOT unref'd and is deliberately longer than the old 100ms: an
    // unref'd timer lets the process exit 0 the moment nothing else holds the
    // loop open, which would both lose the notification and hide the crash from
    // the orchestrator. CRASH_EXIT_DELAY_MS is the hard ceiling — the send has
    // its own 5s timeout, so a hanging webhook cannot keep a broken process up.
    const hardExit = setTimeout(() => process.exit(1), Number(process.env.CRASH_EXIT_DELAY_MS || 6000))
    notify({
      title: 'CRASH — uncaught exception, process exiting',
      body: err?.stack || String(err?.message || err),
      severity: 'critical',
      force: true,
    }).finally(() => {
      clearTimeout(hardExit)
      process.exit(1)
    })
  })
}

// ─── Express error handler ────────────────────────────────────────────────────
// Must be mounted LAST, after every route. Without it a thrown handler returns
// Express's default HTML error page — stack trace included — to the caller.
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500
  if (status >= 500) {
    console.error(`[API] ${req.method} ${req.path} -> ${status}:`, err.stack || err.message)
    telemetry.recordServiceEvent({
      component: 'api', severity: 'error', kind: 'unhandled_route_error',
      detail: { method: req.method, path: req.path, message: String(err.message).slice(0, 300) },
    })
  }
  if (res.headersSent) return
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our end.' : (err.message || 'Request failed'),
  })
}
