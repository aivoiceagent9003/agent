// services/telemetry.js — centralized in-process telemetry for the Operations Center.
//
// WHY: production observability for a multi-tenant voice platform running many
// concurrent calls. Today, signal is scattered across console logs (good for
// tailing ONE call, useless for operating thousands). This module is the single
// source of truth: every call becomes a TRACE, every operation a SPAN, every
// latency a histogram sample. OpenTelemetry CONCEPTS (trace / span / attributes,
// correlation ids), hand-rolled with zero deps and zero hot-path I/O.
//
// HARD RULE: telemetry must NEVER throw into, block, or slow the live voice
// pipeline. Every public method is synchronous, O(1)-amortized, wrapped so a bug
// here can never break a call. Memory is bounded by construction (ring buffers).
//
// Storage model (per the approved design):
//   • hot path  → in-memory Maps + fixed-size ring buffers (no I/O)
//   • history   → a background flusher rolls aggregates up to Supabase every ~30s
//
// Consumers: src/api/ops.js (REST) and the /ops-stream WebSocket (src/index.js),
// which subscribe to the event bus below for real-time deltas.

import { EventEmitter } from 'node:events'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

// ─── Tunables (env-overridable for bigger/smaller boxes) ─────────────────────
const RECENT_TRACES_MAX = Number(process.env.OPS_RECENT_TRACES_MAX || 1000)   // completed-call ring
const LATENCY_RING_MAX = Number(process.env.OPS_LATENCY_RING_MAX || 2000)     // samples kept per op
const TIMESERIES_MAX = Number(process.env.OPS_TIMESERIES_MAX || 720)          // sampler points (~1h @5s)
const SAMPLE_INTERVAL_MS = Number(process.env.OPS_SAMPLE_INTERVAL_MS || 5000)
const FLUSH_INTERVAL_MS = Number(process.env.OPS_FLUSH_INTERVAL_MS || 30000)
const SPANS_PER_TRACE_MAX = Number(process.env.OPS_SPANS_PER_TRACE_MAX || 500) // guard pathological calls

// ─── Event bus — the WS layer subscribes; emitting never blocks a call ───────
// Events: 'trace:start' | 'trace:update' | 'span' | 'trace:end' | 'sample' | 'service_event'
export const bus = new EventEmitter()
bus.setMaxListeners(0)   // many ops-stream sockets may subscribe
const emit = (event, payload) => { try { bus.emit(event, payload); bus.emit('*', { event, payload }) } catch { /* never throw */ } }

// ─── Ring buffer — fixed capacity, O(1) push, cheap snapshot ─────────────────
class Ring {
  constructor(cap) { this.cap = cap; this.buf = []; this.i = 0 }
  push(v) {
    if (this.buf.length < this.cap) this.buf.push(v)
    else { this.buf[this.i] = v; this.i = (this.i + 1) % this.cap }
    return v
  }
  toArray() { return this.buf.slice() }
  get size() { return this.buf.length }
}

// Percentiles over a numeric sample array. Returns {p50,p90,p95,p99,min,max,avg,count}.
function percentiles(samples) {
  const n = samples.length
  if (!n) return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, count: 0 }
  const s = samples.slice().sort((a, b) => a - b)
  const at = (p) => s[Math.min(n - 1, Math.floor((p / 100) * n))]
  let sum = 0
  for (const v of s) sum += v
  return {
    p50: at(50), p90: at(90), p95: at(95), p99: at(99),
    min: s[0], max: s[n - 1], avg: Math.round(sum / n), count: n,
  }
}

// ─── Module state ────────────────────────────────────────────────────────────
const activeTraces = new Map()         // callSid -> Trace (in-flight calls)
const recentTraces = new Ring(RECENT_TRACES_MAX)   // completed Trace summaries
const recentBySid = new Map()          // callSid -> summary (fast trace lookup)
const latencyRings = new Map()         // op -> Ring(of ms)
const counters = new Map()             // name -> number (monotonic-ish counters)
const series = new Ring(TIMESERIES_MAX)            // process/infra samples over time

// Live gauges (current instantaneous values). Mutated by inc/dec/set.
const gauges = {
  websockets: 0,
  gemini_sessions: 0,
  active_calls: 0,
}

// Peak / running concurrency tracking (since process start).
let peakConcurrent = 0
let concurrencySum = 0
let concurrencySamples = 0

const startedAt = Date.now()

// ─── Counters & gauges ───────────────────────────────────────────────────────
export function incr(name, by = 1) { counters.set(name, (counters.get(name) || 0) + by) }
export function getCounter(name) { return counters.get(name) || 0 }
export function getCounters() { return Object.fromEntries(counters) }
export function gaugeInc(name, by = 1) { gauges[name] = (gauges[name] || 0) + by; return gauges[name] }
export function gaugeDec(name, by = 1) { gauges[name] = Math.max(0, (gauges[name] || 0) - by); return gauges[name] }
export function gaugeSet(name, v) { gauges[name] = v; return v }

// ─── Latency histograms ──────────────────────────────────────────────────────
// Record one latency sample for an operation. `op` is a stable key
// ('first_audio', 'rag_retrieval', 'tool_call', 'model_thinking', …).
export function recordLatency(op, ms, attrs = {}) {
  try {
    if (!op || !Number.isFinite(ms) || ms < 0) return
    let r = latencyRings.get(op)
    if (!r) { r = new Ring(LATENCY_RING_MAX); latencyRings.set(op, r) }
    r.push(ms)
    emit('metric', { op, ms, ...attrs })
  } catch { /* never throw */ }
}

export function getLatencyStats(op) {
  if (op) return percentiles((latencyRings.get(op)?.toArray()) || [])
  const out = {}
  for (const [k, r] of latencyRings) out[k] = percentiles(r.toArray())
  return out
}

// ─── Span ─────────────────────────────────────────────────────────────────────
class Span {
  constructor(trace, name, attrs) {
    this.trace = trace
    this.name = name
    this.startTs = Date.now()
    this.startRel = this.startTs - trace.startedAt   // ms from call start (waterfall x)
    this.endTs = null
    this.durationMs = null
    this.status = 'open'         // open | ok | error
    this.retryCount = 0
    this.error = null
    this.payloadBytes = 0
    this.attrs = attrs || {}
  }
  retry() { this.retryCount++; return this }
  // End the span. Also feeds the per-op latency histogram so spans double as the
  // latency source of truth (one instrumentation point, two consumers).
  end({ status = 'ok', error = null, payloadBytes = 0, attrs = null, latencyOp = null } = {}) {
    try {
      if (this.endTs != null) return this
      this.endTs = Date.now()
      this.durationMs = this.endTs - this.startTs
      this.status = error ? 'error' : status
      if (error) this.error = String(error?.message || error).slice(0, 500)
      if (payloadBytes) this.payloadBytes = payloadBytes
      if (attrs) this.attrs = { ...this.attrs, ...attrs }
      recordLatency(latencyOp || this.name, this.durationMs, { tenantId: this.trace.tenantId })
      emit('span', { callSid: this.trace.callSid, span: this.toJSON() })
    } catch { /* never throw */ }
    return this
  }
  toJSON() {
    return {
      name: this.name, startRel: this.startRel, durationMs: this.durationMs,
      status: this.status, retryCount: this.retryCount, error: this.error,
      payloadBytes: this.payloadBytes, attrs: this.attrs,
    }
  }
}

// ─── Trace = one call ──────────────────────────────────────────────────────────
class Trace {
  constructor({ callSid, tenantId, tenantName, callerNumber, businessNumber, engine, correlationId, startedAt }) {
    this.callSid = callSid || `trace-${randomUUID()}`
    this.correlationId = correlationId || randomUUID()
    this.tenantId = tenantId || null
    this.tenantName = tenantName || null
    this.callerNumber = callerNumber || null
    this.businessNumber = businessNumber || null
    this.engine = engine || null
    // Origin of the waterfall timeline. Defaults to now, but callers can pass an
    // EARLIER instant (e.g. the /answer webhook receipt) so pre-WS setup spans
    // (webhook, tenant_resolution) align on the same axis as the rest of the call.
    this.startedAt = Number.isFinite(startedAt) ? startedAt : Date.now()
    this.endedAt = null
    this.status = 'active'       // active | completed | failed
    this.spans = []
    // Live mutable state shown in the Live Calls console.
    this.state = {
      language: null, intent: null, currentTool: null, model: null, voice: null,
      conversationState: 'connecting', lastLatencyMs: null,
      reconnects: 0, interruptions: 0, packetsIn: 0, packetsOut: 0,
      lastTranscript: '', lastAgentReply: '',
    }
  }
  // Open a span. Caller ends it: `const s = trace.span('rag'); … s.end({status})`.
  span(name, attrs) {
    const s = new Span(this, name, attrs)
    if (this.spans.length < SPANS_PER_TRACE_MAX) this.spans.push(s)
    return s
  }
  // Record an ALREADY-COMPLETED span with explicit timing — for reconstructing a
  // phase that finished before this trace existed (e.g. the /answer webhook, whose
  // timings were captured in pendingCalls and replayed once the WS trace started).
  addSpan(name, { startRel = 0, durationMs = 0, status = 'ok', error = null, attrs = {}, latencyOp = null } = {}) {
    try {
      const s = new Span(this, name, attrs)
      s.startRel = startRel
      s.startTs = this.startedAt + startRel
      s.endTs = s.startTs + durationMs
      s.durationMs = durationMs
      s.status = error ? 'error' : status
      if (error) s.error = String(error?.message || error).slice(0, 500)
      if (this.spans.length < SPANS_PER_TRACE_MAX) this.spans.push(s)
      recordLatency(latencyOp || name, durationMs, { tenantId: this.tenantId })
      emit('span', { callSid: this.callSid, span: s.toJSON() })
    } catch { /* never throw */ }
    return this
  }
  // Point-in-time mark (no duration) — e.g. barge-in, interrupted.
  event(name, fields = {}) {
    try {
      const s = new Span(this, name, fields)
      s.endTs = s.startTs; s.durationMs = 0; s.status = 'ok'
      if (this.spans.length < SPANS_PER_TRACE_MAX) this.spans.push(s)
      emit('span', { callSid: this.callSid, span: s.toJSON() })
    } catch { /* never throw */ }
    return this
  }
  // Update live state and notify subscribers (debounced naturally by call cadence).
  set(field, value) {
    try {
      if (field in this.state) this.state[field] = value
      else this.state[field] = value
      emit('trace:update', { callSid: this.callSid, field, value })
    } catch { /* never throw */ }
    return this
  }
  bump(field, by = 1) { try { this.state[field] = (this.state[field] || 0) + by; emit('trace:update', { callSid: this.callSid, field, value: this.state[field] }) } catch {} ; return this }
  // High-frequency packet counter — increments WITHOUT emitting (media frames
  // arrive every ~20ms; emitting each would flood the WS). Surfaced via periodic
  // /calls/live polling and trace detail instead.
  packet(dir = 'in', by = 1) { try { const f = dir === 'out' ? 'packetsOut' : 'packetsIn'; this.state[f] = (this.state[f] || 0) + by } catch {} ; return this }
  summary() {
    return {
      callSid: this.callSid, correlationId: this.correlationId,
      tenantId: this.tenantId, tenantName: this.tenantName,
      callerNumber: this.callerNumber, businessNumber: this.businessNumber,
      engine: this.engine, startedAt: this.startedAt, endedAt: this.endedAt,
      status: this.status, durationMs: (this.endedAt || Date.now()) - this.startedAt,
      ...this.state,
    }
  }
  toJSON() { return { ...this.summary(), spans: this.spans.map(s => s.toJSON()) } }
}

// ─── Trace lifecycle ────────────────────────────────────────────────────────
export function startTrace(opts = {}) {
  try {
    const trace = new Trace(opts)
    activeTraces.set(trace.callSid, trace)
    gaugeSet('active_calls', activeTraces.size)
    incr('calls_total')
    // concurrency peak/avg
    if (activeTraces.size > peakConcurrent) peakConcurrent = activeTraces.size
    emit('trace:start', { call: trace.summary() })
    return trace
  } catch {
    return NOOP_TRACE   // pipeline keeps running even if telemetry hiccups
  }
}

export function getTrace(callSid) { return activeTraces.get(callSid) || null }
export function getActiveCalls() { return [...activeTraces.values()].map(t => t.summary()) }

export function endTrace(callSid, { status = 'completed' } = {}) {
  try {
    const trace = activeTraces.get(callSid)
    if (!trace) return null
    trace.endedAt = Date.now()
    trace.status = status
    activeTraces.delete(callSid)
    gaugeSet('active_calls', activeTraces.size)
    recordLatency('call_duration', trace.endedAt - trace.startedAt, { tenantId: trace.tenantId })
    const full = trace.toJSON()
    recentTraces.push(full)
    recentBySid.set(callSid, full)
    // Keep recentBySid bounded alongside the ring.
    if (recentBySid.size > RECENT_TRACES_MAX * 1.2) {
      const keep = new Set(recentTraces.toArray().map(t => t.callSid))
      for (const k of recentBySid.keys()) if (!keep.has(k)) recentBySid.delete(k)
    }
    emit('trace:end', { call: full })
    if (status === 'failed') incr('calls_failed')
    // Persist a compact per-call summary for after-the-fact debugging (best-effort).
    persistTrace(full)
    return full
  } catch {
    return null
  }
}

// Every completed trace is written to call_traces by persistTrace(). For a long
// time nothing read it back: both accessors below served ONLY the in-memory ring,
// which is process-local and empty after every restart. The effect was that the
// Operations Center showed just the calls placed since the last boot — so any
// average was computed over a handful of samples, or one, and the history sitting
// in the database was invisible.
//
// Memory first, database second. Memory has the live and just-ended calls, which
// may not have reached Postgres yet; the database has everything older.

// Lookup a completed trace's full waterfall (for the tracing dashboard).
export async function getTraceDetail(callSid) {
  const active = activeTraces.get(callSid)
  if (active) return active.toJSON()
  const cached = recentBySid.get(callSid)
  if (cached) return cached
  try {
    const sb = await db()
    if (!sb) return null
    const { data } = await sb.from('call_traces').select('summary').eq('call_sid', callSid).maybeSingle()
    return data?.summary || null
  } catch {
    return null   // history is best-effort; never surface a DB fault as a 500 here
  }
}

export async function getRecentTraces(limit = 100) {
  const live = recentTraces.toArray().slice(-limit).reverse()
  try {
    const sb = await db()
    if (!sb) return live
    const { data } = await sb
      .from('call_traces')
      .select('call_sid, summary')
      .order('started_at', { ascending: false })
      .limit(limit)
    if (!data?.length) return live
    // Dedupe by callSid with the in-memory copy winning: a call that just ended
    // is fresher in memory than the row persistTrace() is still writing.
    const seen = new Set(live.map(t => t.callSid))
    const merged = [...live]
    for (const row of data) {
      if (!row.summary || seen.has(row.call_sid)) continue
      seen.add(row.call_sid)
      merged.push(row.summary)
    }
    merged.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    return merged.slice(0, limit)
  } catch {
    return live   // degrade to whatever this process has seen
  }
}

// ─── Service events (errors / downtime seeds — used by later phases) ──────────
const serviceEvents = new Ring(500)
export function recordServiceEvent({ component, severity = 'info', kind, detail = {} }) {
  try {
    const ev = { ts: Date.now(), component, severity, kind, detail }
    serviceEvents.push(ev)
    if (severity === 'error' || severity === 'critical') {
      incr('errors_total')
      incr(`svc_error:${component || 'unknown'}`)   // per-component error tally (feeds the alert engine)
    }
    emit('service_event', ev)
    persistServiceEvent(ev)
    return ev
  } catch { return null }
}
export function getServiceEvents(limit = 200) { return serviceEvents.toArray().slice(-limit).reverse() }

// ─── Call-control registry — lets the Ops Center act on a live call (terminate,
// and in later phases transfer/listen). The transport layer registers handlers
// for its callSid; ops.js looks them up. Kept here because telemetry is the one
// module every call path already imports. ──────────────────────────────────────
const controlRegistry = new Map()   // callSid -> { terminate?:fn, ... }
export function registerControl(callSid, handlers) { try { controlRegistry.set(callSid, { ...(controlRegistry.get(callSid) || {}), ...handlers }) } catch {} }
export function unregisterControl(callSid) { try { controlRegistry.delete(callSid) } catch {} }
export function getControl(callSid) { return controlRegistry.get(callSid) || null }

// ─── No-op trace — returned if startTrace ever fails, so call code using ?. is
// not even required to null-check (it can call .span()/.set() harmlessly). ─────
const NOOP_SPAN = { retry() { return this }, end() { return this }, toJSON() { return {} } }
const NOOP_TRACE = {
  callSid: null, correlationId: null, tenantId: null, state: {},
  span() { return NOOP_SPAN }, addSpan() { return this }, event() { return this },
  set() { return this }, bump() { return this }, packet() { return this },
  summary() { return {} }, toJSON() { return {} },
}

// ─── Process / infra sampler ──────────────────────────────────────────────────
let eld = null
try { eld = monitorEventLoopDelay({ resolution: 20 }); eld.enable() } catch { /* older node */ }
let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()

function sampleProcess() {
  try {
    const now = Date.now()
    const cpu = process.cpuUsage(lastCpu)            // micros since last sample
    const elapsedUs = (now - lastCpuAt) * 1000 || 1
    const cpuPct = Math.min(100, Math.round(((cpu.user + cpu.system) / elapsedUs) * 100))
    lastCpu = process.cpuUsage(); lastCpuAt = now

    const mem = process.memoryUsage()
    const elDelayMs = eld ? +(eld.mean / 1e6).toFixed(2) : 0
    const elP99Ms = eld ? +(eld.percentile(99) / 1e6).toFixed(2) : 0
    if (eld) eld.reset()

    // running average concurrency
    concurrencySum += activeTraces.size; concurrencySamples++

    const point = {
      ts: now,
      cpuPct,
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      eventLoopDelayMs: elDelayMs,
      eventLoopDelayP99Ms: elP99Ms,
      activeCalls: activeTraces.size,
      websockets: gauges.websockets,
      geminiSessions: gauges.gemini_sessions,
      uptimeSec: Math.round((now - startedAt) / 1000),
    }
    series.push(point)
    emit('sample', point)
  } catch { /* never throw */ }
}

// ─── Exec snapshot (computed on read — cheap, no stored aggregates) ───────────
export function getSnapshot() {
  const lat = getLatencyStats()
  const last = series.toArray().slice(-1)[0] || {}
  const active = activeTraces.size
  const recent = recentTraces.toArray()
  const now = Date.now()
  const since = (ms) => recent.filter(t => (t.endedAt || t.startedAt) >= now - ms).length + active
  const avgConcurrency = concurrencySamples ? +(concurrencySum / concurrencySamples).toFixed(2) : active

  const avgOf = (op) => lat[op]?.avg || 0
  const callsToday = recent.filter(t => isSameDay(t.startedAt, now)).length + active

  // Composite health score (0-100): penalize high event-loop delay, high error
  // rate, and elevated first-audio latency. Real inputs, simple weighting.
  const errRate = getCounter('calls_total') ? getCounter('calls_failed') / getCounter('calls_total') : 0
  let health = 100
  health -= Math.min(30, (last.eventLoopDelayP99Ms || 0) > 100 ? 30 : (last.eventLoopDelayP99Ms || 0) / 3.3)
  health -= Math.min(30, errRate * 100)
  health -= Math.min(20, (avgOf('first_audio') > 1500 ? 20 : avgOf('first_audio') / 75))
  health -= Math.min(20, (last.cpuPct || 0) > 85 ? 20 : 0)
  health = Math.max(0, Math.round(health))

  return {
    status: health >= 80 ? 'healthy' : health >= 50 ? 'degraded' : 'critical',
    healthScore: health,
    activeCalls: active,
    callsToday,
    callsThisHour: since(3600_000),
    peakConcurrentCalls: peakConcurrent,
    avgConcurrentCalls: avgConcurrency,
    avgCallDurationMs: avgOf('call_duration'),
    avgTurnDurationMs: avgOf('turn'),
    avgFirstAudioMs: avgOf('first_audio'),
    avgModelLatencyMs: avgOf('model_thinking'),
    avgRagLatencyMs: avgOf('rag_retrieval'),
    avgLanguageDetectionMs: avgOf('language_detection'),
    avgToolLatencyMs: avgOf('tool_call'),
    cpuPct: last.cpuPct || 0,
    memoryMb: last.rssMb || 0,
    heapUsedMb: last.heapUsedMb || 0,
    eventLoopDelayMs: last.eventLoopDelayMs || 0,
    eventLoopDelayP99Ms: last.eventLoopDelayP99Ms || 0,
    websockets: gauges.websockets,
    geminiSessions: gauges.gemini_sessions,
    counters: Object.fromEntries(counters),
    uptimeSec: Math.round((now - startedAt) / 1000),
  }
}

export function getTimeSeries(limit = TIMESERIES_MAX) { return series.toArray().slice(-limit) }

// ─── Persisted call statistics ───────────────────────────────────────────────
// getSnapshot() computes callsToday, callsThisHour and the duration average from
// the in-memory ring and latency rings. Those are process-local and empty after a
// restart, so the executive dashboard read zero however many calls the business
// had actually taken — while the calls table held every one of them.
//
// Infra numbers (CPU, heap, event-loop delay, live sockets) stay in memory, which
// is correct: they describe THIS process and have no meaning historically. Only
// the business counts are re-sourced here.
//
// Cached for CACHE_MS because the overview endpoint is polled continuously by
// every open dashboard; without it each poll would be three round-trips.
const STATS_CACHE_MS = Number(process.env.OPS_STATS_CACHE_MS || 30_000)
let _statsCache = { at: 0, data: null }

// THE source of truth for "the dashboard snapshot". Both the /overview endpoint
// and the ops-stream heartbeat must serve identical numbers.
//
// When they diverged the page visibly flickered: the REST poll set callsToday
// from the database, then five seconds later the socket pushed a raw getSnapshot()
// carrying the in-memory 0 into the same React Query cache, and every tile
// alternated between the real figure and zero. Two callers assembling "the same"
// payload independently is what allowed that, so there is now only one.
// Latency as of the most recent rollup, per operation.
//
// Deliberately the NEWEST ROW PER OP rather than an aggregate across rows.
// flushRollups() percentiles the WHOLE ring every 30s, so consecutive rows are
// overlapping snapshots of the same samples, not disjoint windows — summing their
// counts or averaging their percentiles would multiply-count the same calls. One
// row is already a valid, self-consistent LatencyStat; combining them is not.
//
// min/max are null on rows written before they were recorded. They coalesce to 0,
// which is honest: historical min/max cannot be reconstructed from percentiles.
const LATENCY_CACHE_MS = Number(process.env.OPS_LATENCY_CACHE_MS || 30_000)
let _latCache = { at: 0, data: null }

export async function getPersistedLatencyStats() {
  if (_latCache.data && Date.now() - _latCache.at < LATENCY_CACHE_MS) return _latCache.data
  try {
    const sb = await db()
    if (!sb) return null
    const { data } = await sb
      .from('metric_rollups')
      // select('*') rather than naming columns: min/max only exist once
      // sql/observability.sql has been re-run, and naming a column Postgres does
      // not have fails the WHOLE query — which would leave this page blank exactly
      // as it was before, for a new reason. Absent columns simply arrive undefined.
      .select('*')
      .eq('metric', 'latency')
      .order('ts', { ascending: false })
      .limit(600)   // ample: ~20 ops x the most recent flushes
    if (!data?.length) return null
    const out = {}
    for (const r of data) {
      if (out[r.op]) continue          // rows arrive newest-first, so the first wins
      out[r.op] = {
        p50: Math.round(r.p50 || 0), p90: Math.round(r.p90 || 0),
        p95: Math.round(r.p95 || 0), p99: Math.round(r.p99 || 0),
        min: Math.round(r.min || 0), max: Math.round(r.max || 0),
        avg: Math.round(r.avg || 0), count: r.count || 0,
      }
    }
    _latCache = { at: Date.now(), data: out }
    return out
  } catch {
    return null
  }
}

// In-memory where this process has samples, persisted rollups everywhere else.
// Live wins because it is current; the rollup is at most 30s stale and, after a
// restart, is the only thing there is.
//
// NOT used by the alert engine, which must keep evaluating thresholds against
// live samples only — alerting on a rollup written before the restart would fire
// on conditions that no longer exist.
export async function getLatencyStatsMerged(op) {
  const live = getLatencyStats(op)
  const persisted = await getPersistedLatencyStats()
  if (!persisted) return live
  if (op) return live.count ? live : (persisted[op] || live)
  const merged = { ...persisted }
  for (const [k, v] of Object.entries(live)) if (v.count) merged[k] = v
  return merged
}

export async function getOverviewSnapshot() {
  const snapshot = getSnapshot()
  const [persisted, lat] = await Promise.all([getPersistedCallStats(), getPersistedLatencyStats()])
  // The "Latency (averages)" tiles come from the in-memory rings too, so they read
  // zero after a restart for exactly the reason the call counts did. Fill only the
  // ones this process has no samples for.
  const avgFrom = (key, current) => (current || !lat?.[key] ? current : lat[key].avg)
  return {
    ...snapshot,
    ...(persisted || {}),
    avgCallDurationMs: (persisted?.avgCallDurationMs) || avgFrom('call_duration', snapshot.avgCallDurationMs),
    avgTurnDurationMs: avgFrom('turn', snapshot.avgTurnDurationMs),
    avgFirstAudioMs: avgFrom('first_audio', snapshot.avgFirstAudioMs),
    avgModelLatencyMs: avgFrom('model_thinking', snapshot.avgModelLatencyMs),
    avgRagLatencyMs: avgFrom('rag_retrieval', snapshot.avgRagLatencyMs),
    avgLanguageDetectionMs: avgFrom('language_detection', snapshot.avgLanguageDetectionMs),
    avgToolLatencyMs: avgFrom('tool_call', snapshot.avgToolLatencyMs),
  }
}

export async function getPersistedCallStats() {
  if (_statsCache.data && Date.now() - _statsCache.at < STATS_CACHE_MS) return _statsCache.data
  try {
    const sb = await db()
    if (!sb) return null
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const hourAgo = new Date(Date.now() - 3600_000).toISOString()
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString()

    const [today, hour, total, durations] = await Promise.all([
      sb.from('calls').select('id', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString()),
      sb.from('calls').select('id', { count: 'exact', head: true }).gte('created_at', hourAgo),
      sb.from('calls').select('id', { count: 'exact', head: true }),
      sb.from('calls').select('duration_seconds').gt('duration_seconds', 0).gte('created_at', weekAgo).limit(1000),
    ])

    const durs = (durations.data || []).map(r => r.duration_seconds).filter(n => n > 0)
    const data = {
      callsToday: today.count ?? 0,
      callsThisHour: hour.count ?? 0,
      callsAllTime: total.count ?? 0,
      // Averaged over the last week rather than all time: a duration average
      // spanning every call ever made stops responding to anything.
      avgCallDurationMs: durs.length ? Math.round((durs.reduce((a, b) => a + b, 0) / durs.length) * 1000) : 0,
    }
    _statsCache = { at: Date.now(), data }
    return data
  } catch {
    return null   // caller keeps the in-memory figures; never fail the dashboard
  }
}

function isSameDay(a, b) {
  const da = new Date(a), db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

// ─── Background rollup → Supabase (history). Lazy import avoids a load-time
// dependency cycle (db.js is light, but keep telemetry importable standalone). ─
let _supabase = null
async function db() {
  if (_supabase === null) {
    try { ({ supabase: _supabase } = await import('../api/db.js')) } catch { _supabase = false }
  }
  return _supabase || null
}

async function flushRollups() {
  try {
    const sb = await db()
    if (!sb) return
    const ts = new Date().toISOString()
    const rows = []
    for (const [op, r] of latencyRings) {
      const p = percentiles(r.toArray())
      if (!p.count) continue
      rows.push({ ts, metric: 'latency', op, p50: p.p50, p90: p.p90, p95: p.p95, p99: p.p99, count: p.count, avg: p.avg, min: p.min, max: p.max })
    }
    const last = series.toArray().slice(-1)[0] || {}
    rows.push({
      ts, metric: 'infra', op: 'process',
      p50: last.cpuPct || 0, p90: last.heapUsedMb || 0, p95: last.eventLoopDelayMs || 0,
      p99: last.eventLoopDelayP99Ms || 0, count: activeTraces.size, avg: gauges.websockets || 0,
    })
    if (rows.length) await sb.from('metric_rollups').insert(rows)
  } catch { /* swallow — history is best-effort, never affects calls */ }
}

async function persistTrace(full) {
  try {
    const sb = await db()
    if (!sb) return
    await sb.from('call_traces').upsert({
      call_sid: full.callSid,
      tenant_id: full.tenantId,
      started_at: new Date(full.startedAt).toISOString(),
      ended_at: full.endedAt ? new Date(full.endedAt).toISOString() : null,
      status: full.status,
      summary: full,
    }, { onConflict: 'call_sid' })
  } catch { /* best-effort */ }
}

async function persistServiceEvent(ev) {
  try {
    const sb = await db()
    if (!sb) return
    await sb.from('service_events').insert({
      ts: new Date(ev.ts).toISOString(), component: ev.component,
      severity: ev.severity, kind: ev.kind, detail: ev.detail,
    })
  } catch { /* best-effort */ }
}

// Read rollup history for trend charts.
export async function getMetricHistory({ metric = 'latency', op = null, sinceMs = 6 * 3600_000 } = {}) {
  try {
    const sb = await db()
    if (!sb) return []
    let q = sb.from('metric_rollups').select('*')
      .eq('metric', metric)
      .gte('ts', new Date(Date.now() - sinceMs).toISOString())
      .order('ts', { ascending: true })
      .limit(5000)
    if (op) q = q.eq('op', op)
    const { data } = await q
    return data || []
  } catch { return [] }
}

// ─── Timers — unref so they never keep the process alive on shutdown ──────────
const sampleTimer = setInterval(sampleProcess, SAMPLE_INTERVAL_MS); sampleTimer.unref?.()
const flushTimer = setInterval(flushRollups, FLUSH_INTERVAL_MS); flushTimer.unref?.()

// Aggregate export so callers can `import * as telemetry`.
// ─── Per-call quality, denormalised onto the `calls` row ─────────────────────
// The client Analytics page needs average reply time and knowledge-hit rate PER
// TENANT. Both are already in the trace, but call_traces.summary carries the whole
// span waterfall — pulling thousands of those to average two numbers is absurd.
// So the telephony layer writes these three columns when it closes out the call.
// Nulls are expected on calls that predate this, and the dashboard shows "—".
export function callQuality(trace) {
  const s = trace?.state || {}
  const replies = Number(s.replyCount || 0)
  const totalMs = Number(s.replyMsTotal || 0)
  return {
    avg_reply_ms: replies ? Math.round(totalMs / replies) : null,
    knowledge_asks: Number(s.knowledgeAsks || 0),
    knowledge_hits: Number(s.knowledgeHits || 0),
  }
}

export default {
  bus, startTrace, endTrace, getTrace, getTraceDetail, getActiveCalls, getRecentTraces,
  callQuality,
  recordLatency, getLatencyStats, getSnapshot, getTimeSeries, getMetricHistory,
  getPersistedCallStats, getOverviewSnapshot, getPersistedLatencyStats, getLatencyStatsMerged,
  incr, getCounter, getCounters, gaugeInc, gaugeDec, gaugeSet,
  recordServiceEvent, getServiceEvents,
  registerControl, unregisterControl, getControl,
}
