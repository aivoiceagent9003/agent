// services/alerts.js — production threshold alert engine (Operations Center §15).
//
// Evaluates a fixed set of rules against the LIVE telemetry every tick. Rules read
// real signal only: the process snapshot, latency percentiles, and windowed deltas
// of counters (so "reconnect storm" means N reconnects in the last window, not N
// ever). When a rule crosses its threshold it FIRES (active alert + service_event +
// bus 'alert' event); when it recovers it RESOLVES. No fake conditions, no polling
// of the call path — this is read-only over telemetry.
//
// Thresholds are env-overridable so the engine can be tuned per deployment without
// code changes. The engine self-starts on import (unref'd timer).

import telemetry from './telemetry.js'
import { notify } from './notify.js'

const N = (env, dflt) => Number(process.env[env] ?? dflt)

const WINDOW_MS = N('ALERT_WINDOW_MS', 60000)        // delta/rate window
const TICK_MS = N('ALERT_TICK_MS', 10000)            // evaluation cadence
const HISTORY_MAX = 200

// ─── Rule definitions ──────────────────────────────────────────────────────────
// evaluate(ctx) → { firing:boolean, value:number, threshold:number }
// ctx = { snapshot, latency, delta(counterName), sumDelta(prefix) }
const RULES = [
  {
    id: 'cpu_high', label: 'CPU usage high', group: 'infra', severity: 'warning',
    threshold: N('ALERT_CPU_PCT', 85),
    evaluate: (c) => mk(c.snapshot.cpuPct, N('ALERT_CPU_PCT', 85)),
    describe: (v) => `CPU at ${v}%`,
  },
  {
    id: 'memory_high', label: 'Memory high', group: 'infra', severity: 'warning',
    threshold: N('ALERT_HEAP_MB', 1024),
    evaluate: (c) => mk(c.snapshot.heapUsedMb, N('ALERT_HEAP_MB', 1024)),
    describe: (v) => `heap used ${v} MB`,
  },
  {
    id: 'event_loop_lag', label: 'Event loop lag', group: 'infra', severity: 'critical',
    threshold: N('ALERT_ELOOP_P99_MS', 200),
    evaluate: (c) => mk(c.snapshot.eventLoopDelayP99Ms, N('ALERT_ELOOP_P99_MS', 200)),
    describe: (v) => `event-loop p99 ${v}ms`,
  },
  {
    id: 'gemini_latency', label: 'Gemini latency high', group: 'gemini', severity: 'warning',
    threshold: N('ALERT_FIRST_AUDIO_P95_MS', 1500),
    evaluate: (c) => mk(c.latency.first_audio?.p95 || 0, N('ALERT_FIRST_AUDIO_P95_MS', 1500)),
    describe: (v) => `first-audio p95 ${v}ms`,
  },
  {
    id: 'rag_latency', label: 'RAG latency high', group: 'rag', severity: 'warning',
    threshold: N('ALERT_RAG_P95_MS', 2000),
    evaluate: (c) => mk(c.latency.rag_retrieval?.p95 || 0, N('ALERT_RAG_P95_MS', 2000)),
    describe: (v) => `RAG p95 ${v}ms`,
  },
  {
    id: 'classifier_latency', label: 'Classifier latency high', group: 'language', severity: 'warning',
    threshold: N('ALERT_CLASSIFIER_P95_MS', 2000),
    evaluate: (c) => mk(c.latency.language_detection?.p95 || 0, N('ALERT_CLASSIFIER_P95_MS', 2000)),
    describe: (v) => `classifier p95 ${v}ms`,
  },
  {
    id: 'gemini_down', label: 'Gemini errors spiking', group: 'gemini', severity: 'critical',
    threshold: N('ALERT_GEMINI_ERRORS', 3),
    evaluate: (c) => mk(c.delta('svc_error:gemini'), N('ALERT_GEMINI_ERRORS', 3)),
    describe: (v) => `${v} Gemini errors in window`,
  },
  {
    id: 'supabase_down', label: 'Supabase errors spiking', group: 'supabase', severity: 'critical',
    threshold: N('ALERT_SUPABASE_ERRORS', 2),
    evaluate: (c) => mk(c.delta('svc_error:supabase') + c.delta('svc_error:storage'), N('ALERT_SUPABASE_ERRORS', 2)),
    describe: (v) => `${v} Supabase/storage errors in window`,
  },
  {
    id: 'vobiz_down', label: 'Telephony failures', group: 'telephony', severity: 'critical',
    threshold: N('ALERT_TELEPHONY_FAILS', 2),
    evaluate: (c) => mk(c.delta('media_stream_failures') + c.delta('svc_error:telephony'), N('ALERT_TELEPHONY_FAILS', 2)),
    describe: (v) => `${v} telephony failures in window`,
  },
  {
    id: 'reconnect_storm', label: 'Reconnect storm', group: 'gemini', severity: 'warning',
    threshold: N('ALERT_RECONNECTS', 3),
    evaluate: (c) => mk(c.delta('gemini_reconnects'), N('ALERT_RECONNECTS', 3)),
    describe: (v) => `${v} reconnects in window`,
  },
  {
    id: 'tool_timeouts', label: 'Tool timeout rate', group: 'tool', severity: 'warning',
    threshold: N('ALERT_TOOL_TIMEOUTS', 3),
    evaluate: (c) => mk(c.delta('tool_timeouts_total'), N('ALERT_TOOL_TIMEOUTS', 3)),
    describe: (v) => `${v} tool timeouts in window`,
  },
  {
    id: 'language_failures', label: 'Language classify failures', group: 'language', severity: 'warning',
    threshold: N('ALERT_LANG_FAILS', 5),
    evaluate: (c) => mk(c.delta('lang_failures'), N('ALERT_LANG_FAILS', 5)),
    describe: (v) => `${v} classify failures in window`,
  },
]

const mk = (value, threshold) => ({ firing: value >= threshold, value: Math.round(value * 10) / 10, threshold })

// ─── State ──────────────────────────────────────────────────────────────────
const active = new Map()   // ruleId -> { ...rule meta, value, since, lastValue }
const history = []         // resolved/fired transitions, newest first
let prevCounters = telemetry.getCounters()
let prevAt = Date.now()

function tick() {
  try {
    const snapshot = telemetry.getSnapshot()
    const latency = telemetry.getLatencyStats()
    const counters = telemetry.getCounters()
    const dtSec = Math.max(1, (Date.now() - prevAt) / 1000)
    const scale = WINDOW_MS / 1000 / dtSec    // normalize this tick's delta to a per-WINDOW rate

    const rawDelta = (name) => Math.max(0, (counters[name] || 0) - (prevCounters[name] || 0))
    const delta = (name) => rawDelta(name) * scale
    const ctx = { snapshot, latency, delta }

    for (const rule of RULES) {
      let r
      try { r = rule.evaluate(ctx) } catch { continue }
      const wasActive = active.has(rule.id)
      if (r.firing && !wasActive) {
        const alert = {
          id: rule.id, label: rule.label, group: rule.group, severity: rule.severity,
          value: r.value, threshold: r.threshold, message: rule.describe(r.value),
          since: Date.now(),
        }
        active.set(rule.id, alert)
        pushHistory({ ...alert, event: 'fired' })
        telemetry.recordServiceEvent({ component: rule.group, severity: rule.severity, kind: `alert:${rule.id}`, detail: { value: r.value, threshold: r.threshold } })
        telemetry.bus.emit('alert', { event: 'fired', alert })
        telemetry.bus.emit('*', { event: 'alert', payload: { event: 'fired', alert } })
        // Reach a human. Until this existed the two lines above were the whole
        // story: an in-memory map and a websocket event, visible only to someone
        // already watching the dashboard. notify() applies its own severity
        // filter and cooldown, and never throws — the tick is unaffected either
        // way, so this is deliberately not awaited.
        notify({
          title: `${alert.label} — ${alert.message}`,
          body: `Rule ${rule.id} crossed its threshold.

Value: ${r.value}
Threshold: ${r.threshold}
Group: ${rule.group}`,
          severity: rule.severity,
          key: `alert:${rule.id}`,
        })
      } else if (r.firing && wasActive) {
        const a = active.get(rule.id); a.value = r.value; a.message = rule.describe(r.value)
      } else if (!r.firing && wasActive) {
        const a = active.get(rule.id)
        active.delete(rule.id)
        const resolved = { ...a, resolvedAt: Date.now(), durationMs: Date.now() - a.since, event: 'resolved' }
        pushHistory(resolved)
        telemetry.bus.emit('alert', { event: 'resolved', alert: resolved })
        telemetry.bus.emit('*', { event: 'alert', payload: { event: 'resolved', alert: resolved } })
        // Recovery is worth sending too, and on its own cooldown key: someone woken
        // by an alert needs to know it cleared without having to open a dashboard.
        // A pager that only ever reports bad news makes people check manually.
        notify({
          title: `RESOLVED: ${resolved.label}`,
          body: `Cleared after ${Math.round(resolved.durationMs / 1000)}s.`,
          severity: rule.severity,
          key: `resolved:${rule.id}`,
        })
      }
    }

    prevCounters = counters
    prevAt = Date.now()
  } catch { /* never throw from the alert engine */ }
}

function pushHistory(entry) {
  history.unshift({ ...entry, ts: Date.now() })
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX
}

// ─── Public API ────────────────────────────────────────────────────────────
export function getActiveAlerts() { return [...active.values()].sort((a, b) => sev(b.severity) - sev(a.severity)) }
export function getAlertHistory(limit = 100) { return history.slice(0, limit) }
export function getRules() {
  return RULES.map(r => ({ id: r.id, label: r.label, group: r.group, severity: r.severity, threshold: r.threshold, active: active.has(r.id) }))
}
const sev = (s) => (s === 'critical' ? 3 : s === 'warning' ? 2 : 1)

const timer = setInterval(tick, TICK_MS); timer.unref?.()

export default { getActiveAlerts, getAlertHistory, getRules }
