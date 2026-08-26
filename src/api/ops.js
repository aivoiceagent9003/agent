// api/ops.js — Operations Center REST API (platform/DevOps/SRE).
//
// Mounted at /api/admin/ops, gated by requireAdmin. Reads exclusively from the
// in-memory telemetry service (live numbers, zero DB I/O) plus Supabase rollups
// for historical trends. Never mutates the voice pipeline except the explicit
// terminate action.
//
// Real-time deltas are delivered over the /ops-stream WebSocket (see src/index.js);
// these REST endpoints provide the initial snapshot + polling fallback + history.

import { Router } from 'express'
import { requireAdmin } from './auth.js'
import { supabase } from './db.js'
import telemetry from '../services/telemetry.js'
import alerts from '../services/alerts.js'

const router = Router()
router.use(requireAdmin())

// Cost / pricing model for Business Analytics. Per-minute platform cost (Gemini +
// telephony + infra, amortized) and default sell price. Override globally via env
// or per-tenant via tenants.config.cost_per_min / price_per_min.
const DEFAULT_COST_PER_MIN = Number(process.env.COST_PER_MIN_USD || 0.08)
const DEFAULT_PRICE_PER_MIN = Number(process.env.PRICE_PER_MIN_USD || 0.30)

// ─── Section 1: Executive Operations Dashboard ────────────────────────────────
router.get('/overview', (_req, res) => {
  try {
    res.json({
      ...telemetry.getSnapshot(),
      series: telemetry.getTimeSeries(180),   // ~15 min of 5s samples for live charts
    })
  } catch (e) {
    console.error('[OPS] overview error:', e.message)
    res.status(500).json({ error: 'Could not load overview' })
  }
})

// Time-series only (for chart refresh without the full snapshot).
router.get('/series', (req, res) => {
  const limit = Math.min(720, parseInt(req.query.limit) || 180)
  res.json(telemetry.getTimeSeries(limit))
})

// ─── Section 2: Live Calls Console ────────────────────────────────────────────
router.get('/calls/live', (_req, res) => {
  try {
    res.json({ calls: telemetry.getActiveCalls() })
  } catch (e) {
    console.error('[OPS] live calls error:', e.message)
    res.status(500).json({ error: 'Could not load live calls' })
  }
})

// Recently completed calls (for the console's "recent" tab + trace entry points).
router.get('/calls/recent', async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 100)
  // Reads persisted history, not just this process's memory — see getRecentTraces.
  res.json({ calls: await telemetry.getRecentTraces(limit) })
})

// ─── Section 3: Distributed Tracing ───────────────────────────────────────────
router.get('/calls/:callSid/trace', async (req, res) => {
  const detail = await telemetry.getTraceDetail(req.params.callSid)
  if (!detail) return res.status(404).json({ error: 'Trace not found' })
  res.json(detail)
})

// ─── Section 4: Latency Dashboard ─────────────────────────────────────────────
router.get('/latency', (req, res) => {
  try {
    if (req.query.op) return res.json({ op: req.query.op, ...telemetry.getLatencyStats(req.query.op) })
    res.json(telemetry.getLatencyStats())
  } catch (e) {
    console.error('[OPS] latency error:', e.message)
    res.status(500).json({ error: 'Could not load latency' })
  }
})

// Historical rollups for trend charts (Supabase-backed).
router.get('/metrics/history', async (req, res) => {
  try {
    const metric = req.query.metric || 'latency'
    const op = req.query.op || null
    const sinceMs = Math.min(7 * 24 * 3600_000, parseInt(req.query.sinceMs) || 6 * 3600_000)
    const rows = await telemetry.getMetricHistory({ metric, op, sinceMs })
    res.json({ rows })
  } catch (e) {
    console.error('[OPS] history error:', e.message)
    res.status(500).json({ error: 'Could not load metric history' })
  }
})

// ─── Service events (errors / reconnects / outages) ──────────────────────────
router.get('/events', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit) || 200)
  res.json({ events: telemetry.getServiceEvents(limit) })
})

// ─── Helpers: slice the flat counter map into per-section views ────────────────
// Counters are stored as flat keys ('lang_source:classifier', 'tool:search_knowledge:ok',
// 'gemini_close:1011'); these group them by prefix for the section dashboards.
function byPrefix(counters, prefix) {
  const out = {}
  for (const [k, v] of Object.entries(counters)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
  return out
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

// ─── Section 5: Language Analytics ────────────────────────────────────────────
router.get('/language', (_req, res) => {
  const c = telemetry.getCounters()
  const lat = telemetry.getLatencyStats()
  res.json({
    decisions: c.lang_decision || 0,
    classifierUsed: c.lang_classifier_used || 0,
    classifierUsageRate: pct(c.lang_classifier_used || 0, c.lang_decision || 0),
    init: c.lang_init || 0,
    switchExplicit: c.lang_switch_explicit || 0,
    switchAuto: c.lang_switch_auto || 0,
    bySource: byPrefix(c, 'lang_source:'),         // unicode | classifier | explicit_request
    byLanguage: byPrefix(c, 'lang_detected:'),     // Telugu | Hindi | English | …
    classifierLatency: lat.language_detection || null,
    confidence: lat.lang_confidence || null,        // distribution of confidence*100
  })
})

// ─── Section 6: Gemini Dashboard ──────────────────────────────────────────────
router.get('/gemini', (_req, res) => {
  const c = telemetry.getCounters()
  const lat = telemetry.getLatencyStats()
  res.json({
    sessionsOpened: c.gemini_sessions_opened || 0,
    sessionsClosed: c.gemini_sessions_closed || 0,
    sessionsOpen: telemetry.getSnapshot().geminiSessions,
    reconnects: c.gemini_reconnects || 0,
    errors: c.gemini_errors || 0,
    interruptions: c.interruptions_total || 0,
    closeCodes: byPrefix(c, 'gemini_close:'),
    firstAudio: lat.first_audio || null,
    turn: lat.turn || null,
    modelThinking: lat.model_thinking || null,
    // Token usage is not exposed by the Gemini Live SDK in this integration.
    tokenUsageAvailable: false,
  })
})

// ─── Section 7: Telephony Dashboard ───────────────────────────────────────────
router.get('/telephony', (_req, res) => {
  const c = telemetry.getCounters()
  const lat = telemetry.getLatencyStats()
  const snap = telemetry.getSnapshot()
  res.json({
    incoming: c.calls_incoming || 0,
    answered: c.calls_answered || c.calls_total || 0,
    rejected: c.calls_rejected || 0,
    mediaStreamFailures: c.media_stream_failures || 0,
    activeWebsockets: snap.websockets,
    reconnects: c.gemini_reconnects || 0,
    webhookLatency: lat.webhook || null,
    tenantResolution: lat.tenant_resolution || null,
    callDuration: lat.call_duration || null,
  })
})

// ─── Section 8: Knowledge / RAG Dashboard ─────────────────────────────────────
router.get('/rag', (_req, res) => {
  const c = telemetry.getCounters()
  const lat = telemetry.getLatencyStats()
  const hit = c.rag_cache_hit || 0, miss = c.rag_cache_miss || 0
  res.json({
    cacheHits: hit,
    cacheMisses: miss,
    cacheHitRate: pct(hit, hit + miss),
    noMatch: c.rag_no_match || 0,
    noMatchRate: pct(c.rag_no_match || 0, miss),
    retrieval: lat.rag_retrieval || null,
    embedding: lat.embedding || null,
    vectorSearch: lat.vector_search || null,
    similarity: lat.rag_similarity || null,   // distribution of similarity*100
    chunksReturned: lat.rag_chunks || null,
  })
})

// ─── Section 9: Tool Dashboard ────────────────────────────────────────────────
router.get('/tools', (_req, res) => {
  const c = telemetry.getCounters()
  const lat = telemetry.getLatencyStats()
  // Reassemble per-tool stats from 'tool:NAME:ok|error' and 'lookup:NAME:hit|miss|timeout|error'.
  const tools = {}
  const bump = (name, field, v) => { (tools[name] ||= { ok: 0, error: 0, hit: 0, miss: 0, timeout: 0 })[field] += v }
  for (const [k, v] of Object.entries(c)) {
    let m
    if ((m = k.match(/^tool:(.+):(ok|error)$/))) bump(m[1], m[2], v)
    else if ((m = k.match(/^lookup:(.+):(hit|miss|timeout|error)$/))) bump(m[1], m[2], v)
  }
  res.json({
    tools,
    toolCallLatency: lat.tool_call || null,
    lookupLatency: lat.lookup || null,
  })
})

// ─── Section 10: Infrastructure Dashboard ─────────────────────────────────────
router.get('/infra', (_req, res) => {
  const snap = telemetry.getSnapshot()
  res.json({
    cpuPct: snap.cpuPct,
    memoryMb: snap.memoryMb,
    heapUsedMb: snap.heapUsedMb,
    eventLoopDelayMs: snap.eventLoopDelayMs,
    eventLoopDelayP99Ms: snap.eventLoopDelayP99Ms,
    websockets: snap.websockets,
    geminiSessions: snap.geminiSessions,
    activeCalls: snap.activeCalls,
    uptimeSec: snap.uptimeSec,
    series: telemetry.getTimeSeries(180),
  })
})

// ─── Section 11 + 12: Errors & Downtime (from service_events) ─────────────────
// Errors grouped by component; downtime derived from clusters of error/critical
// events (a simple, real heuristic — refined in a later phase with explicit probes).
router.get('/errors', (_req, res) => {
  const events = telemetry.getServiceEvents(500)
  const byComponent = {}
  for (const e of events) {
    const g = (byComponent[e.component || 'unknown'] ||= { total: 0, error: 0, critical: 0, warning: 0, lastSeen: 0, kinds: {} })
    g.total++
    if (e.severity === 'error') g.error++
    else if (e.severity === 'critical') g.critical++
    else if (e.severity === 'warning') g.warning++
    g.lastSeen = Math.max(g.lastSeen, e.ts)
    g.kinds[e.kind] = (g.kinds[e.kind] || 0) + 1
  }
  res.json({ byComponent, recent: events.slice(0, 100) })
})

router.get('/downtime', (_req, res) => {
  // Cluster consecutive error/critical events per component into incidents
  // (gap > 60s starts a new incident). Real signal from the event stream.
  const events = telemetry.getServiceEvents(500)
    .filter(e => e.severity === 'error' || e.severity === 'critical')
    .sort((a, b) => a.ts - b.ts)
  const GAP = 60_000
  const incidents = []
  const open = new Map()   // component -> incident
  for (const e of events) {
    const cur = open.get(e.component)
    if (cur && e.ts - cur.end <= GAP) {
      cur.end = e.ts; cur.count++; cur.severity = e.severity === 'critical' ? 'critical' : cur.severity
    } else {
      const inc = { component: e.component, start: e.ts, end: e.ts, count: 1, severity: e.severity, rootCause: e.kind }
      open.set(e.component, inc); incidents.push(inc)
    }
  }
  for (const i of incidents) i.durationMs = i.end - i.start
  res.json({ incidents: incidents.reverse() })
})

// ─── Live Calls actions ───────────────────────────────────────────────────────
router.post('/calls/:callSid/terminate', (req, res) => {
  const ctrl = telemetry.getControl(req.params.callSid)
  if (!ctrl?.terminate) return res.status(404).json({ error: 'Call not active or not terminable' })
  try {
    ctrl.terminate()
    telemetry.recordServiceEvent({ component: 'telephony', severity: 'warning', kind: 'manual_terminate', detail: { callSid: req.params.callSid, by: req.auth?.email } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Terminate failed' })
  }
})

// ─── Section 13: Business Analytics (per tenant) ──────────────────────────────
// Reads durable Supabase data (calls/leads/knowledge/documents via the same
// tenant_stats RPC the admin dashboard uses) and applies the cost model.
router.get('/business', async (_req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants').select('id, name, config').order('name', { ascending: true })
    if (error) throw error

    const rows = await Promise.all((tenants || []).map(async (t) => {
      const cfg = t.config || {}
      const [{ data: s }, kb, docs] = await Promise.all([
        supabase.rpc('tenant_stats', { t_id: t.id }),
        supabase.from('knowledge_base').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id),
        supabase.from('documents').select('size_bytes').eq('tenant_id', t.id),
      ])
      const st = s?.[0] || {}
      const calls = Number(st.total_calls || 0)
      const minutes = Number(st.total_minutes || 0)
      const leads = Number(st.total_leads || 0)
      const costPerMin = Number(cfg.cost_per_min ?? DEFAULT_COST_PER_MIN)
      const pricePerMin = Number(cfg.price_per_min ?? DEFAULT_PRICE_PER_MIN)
      const cost = +(minutes * costPerMin).toFixed(2)
      const revenue = +(minutes * pricePerMin).toFixed(2)
      const storageBytes = (docs.data || []).reduce((a, d) => a + (d.size_bytes || 0), 0)
      return {
        tenantId: t.id, name: t.name,
        calls, minutes, leads,
        conversionRate: calls ? Math.round((leads / calls) * 1000) / 10 : 0,
        avgDurationSeconds: Number(st.avg_call_duration_seconds || 0),
        handoffs: Number(st.handoff_count || 0),
        knowledgeChunks: kb.count || 0,
        storageMb: +(storageBytes / 1048576).toFixed(2),
        cost, revenue, profit: +(revenue - cost).toFixed(2),
      }
    }))
    // Platform totals
    const totals = rows.reduce((a, r) => ({
      calls: a.calls + r.calls, minutes: a.minutes + r.minutes, leads: a.leads + r.leads,
      cost: a.cost + r.cost, revenue: a.revenue + r.revenue, profit: a.profit + r.profit,
    }), { calls: 0, minutes: 0, leads: 0, cost: 0, revenue: 0, profit: 0 })
    for (const k of ['cost', 'revenue', 'profit']) totals[k] = +totals[k].toFixed(2)
    res.json({ tenants: rows, totals })
  } catch (e) {
    console.error('[OPS] business error:', e.message)
    res.status(500).json({ error: 'Could not load business analytics' })
  }
})

// ─── Section 14: AI Quality ───────────────────────────────────────────────────
// Composite quality view from REAL signal: silent/duplicate replies and language
// failures (detected live in the engine, no LLM), plus escalations, drift, and
// RAG no-match rate. A 0-100 score weights the failure rates. Metrics needing a
// post-call LLM judge (hallucination grading, intent-correctness) are flagged.
router.get('/quality', (_req, res) => {
  const c = telemetry.getCounters()
  const calls = c.calls_total || 0
  const turns = c.lang_decision || 0   // ~ substantive caller turns
  const duplicate = c.quality_duplicate_reply || 0
  const silent = c.quality_silent_response || 0
  const langFailures = c.lang_failures || 0
  const handoffs = c.handoffs_total || 0
  const drift = (c.lang_switch_auto || 0) + (c.lang_switch_explicit || 0)
  const ragNoMatch = c.rag_no_match || 0
  const ragTotal = (c.rag_cache_miss || 0)
  const toolErrors = c.tool_errors_total || 0
  const interruptions = c.interruptions_total || 0

  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)
  // Quality score: start at 100, subtract weighted failure rates (bounded).
  let score = 100
  score -= Math.min(30, rate(silent, turns) * 1.5)
  score -= Math.min(20, rate(duplicate, turns) * 2)
  score -= Math.min(15, rate(langFailures, turns))
  score -= Math.min(15, rate(ragNoMatch, ragTotal) * 0.3)
  score -= Math.min(10, rate(toolErrors, turns))
  score = Math.max(0, Math.round(score))

  res.json({
    qualityScore: score,
    calls, turns,
    duplicateReplies: duplicate,
    silentResponses: silent,
    silentRate: rate(silent, turns),
    languageFailures: langFailures,
    languageDrift: drift,
    humanTransfers: handoffs,
    escalationRate: rate(handoffs, calls),
    ragNoMatch, ragNoMatchRate: rate(ragNoMatch, ragTotal),
    toolErrors,
    interruptions,
    // These require a post-call LLM judge (not yet wired) — surfaced honestly, not faked.
    needsLlmJudge: ['hallucinationRate', 'wrongIntentRate', 'wrongRagRate', 'wrongToolRate'],
  })
})

// ─── Section 15: Alert Center ─────────────────────────────────────────────────
router.get('/alerts', (_req, res) => {
  res.json({
    active: alerts.getActiveAlerts(),
    history: alerts.getAlertHistory(100),
    rules: alerts.getRules(),
  })
})

// Phase-1 affordances surfaced in the UI but not yet implemented end-to-end.
// Returning a clear 501 keeps the console honest (no fake success).
for (const action of ['listen', 'replay', 'transfer']) {
  router.post(`/calls/:callSid/${action}`, (_req, res) =>
    res.status(501).json({ error: `${action} not implemented yet (later phase)` }))
}

export default router
