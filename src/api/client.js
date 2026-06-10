// api/client.js — Client (tenant-scoped) endpoints
// The tenant is always taken from req.auth.tenantId (never from the request),
// so a client can only ever see their own data.

import { Router } from 'express'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
const router = Router()

router.use(requireClient())

// ─── Overview (dashboard summary) ─────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  const t = req.auth.tenantId
  try {
    const [{ data: stats }, { data: chart }] = await Promise.all([
      supabase.rpc('tenant_stats', { t_id: t }),
      supabase.rpc('tenant_calls_last_7_days', { t_id: t }),
    ])
    const s = stats?.[0] || {}
    res.json({
      total_calls: Number(s.total_calls || 0),
      total_minutes: Number(s.total_minutes || 0),
      total_leads: Number(s.total_leads || 0),
      handoff_count: Number(s.handoff_count || 0),
      avg_call_duration_seconds: Number(s.avg_call_duration_seconds || 0),
      calls_last_7_days: (chart || []).map(r => ({ date: r.date, count: Number(r.count) })),
    })
  } catch (e) {
    console.error('[CLIENT] overview error:', e.message)
    res.status(500).json({ error: 'Could not load overview' })
  }
})

// ─── Calls (paginated list) ───────────────────────────────────────────────────
router.get('/calls', async (req, res) => {
  const t = req.auth.tenantId
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, parseInt(req.query.limit) || 20)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    const { data, count, error } = await supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, created_at', { count: 'exact' })
      .eq('tenant_id', t)
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    // Mark which calls have a lead
    const ids = (data || []).map(c => c.id)
    let leadCallIds = new Set()
    if (ids.length) {
      const { data: leadRows } = await supabase
        .from('leads').select('call_id').in('call_id', ids)
      leadCallIds = new Set((leadRows || []).map(l => l.call_id))
    }

    res.json({
      calls: (data || []).map(c => ({ ...c, has_lead: leadCallIds.has(c.id) })),
      total: count || 0, page, limit,
    })
  } catch (e) {
    console.error('[CLIENT] calls error:', e.message)
    res.status(500).json({ error: 'Could not load calls' })
  }
})

// ─── Single call (transcript + lead) ──────────────────────────────────────────
router.get('/calls/:id', async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: call, error } = await supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, transcript, created_at')
      .eq('id', req.params.id)
      .eq('tenant_id', t)   // scope guard
      .single()
    if (error || !call) return res.status(404).json({ error: 'Call not found' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('call_id', call.id).maybeSingle()

    res.json({ ...call, lead: lead || null })
  } catch (e) {
    console.error('[CLIENT] call detail error:', e.message)
    res.status(500).json({ error: 'Could not load call' })
  }
})

// ─── Leads (paginated, filterable) ────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  const t = req.auth.tenantId
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, parseInt(req.query.limit) || 20)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    let q = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('tenant_id', t)
      .order('created_at', { ascending: false })

    if (req.query.intent) q = q.eq('intent', req.query.intent)
    if (req.query.sentiment) q = q.eq('sentiment', req.query.sentiment)
    if (req.query.follow_up === 'true') q = q.eq('follow_up_needed', true)

    const { data, count, error } = await q.range(from, to)
    if (error) throw error
    res.json({ leads: data || [], total: count || 0, page, limit })
  } catch (e) {
    console.error('[CLIENT] leads error:', e.message)
    res.status(500).json({ error: 'Could not load leads' })
  }
})

// ─── Export leads as CSV ──────────────────────────────────────────────────────
router.get('/leads/export', async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase
      .from('leads').select('*').eq('tenant_id', t)
      .order('created_at', { ascending: false })
    if (error) throw error

    const cols = ['created_at', 'name', 'intent', 'summary', 'sentiment',
      'language', 'follow_up_needed', 'handed_off', 'contact_info', 'caller_number']
    const esc = v => {
      if (v == null) return ''
      const s = Array.isArray(v) ? v.join('; ') : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = cols.join(',')
    const rows = (data || []).map(r => cols.map(c => esc(r[c])).join(','))
    const csv = [header, ...rows].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"')
    res.send(csv)
  } catch (e) {
    console.error('[CLIENT] export error:', e.message)
    res.status(500).json({ error: 'Could not export leads' })
  }
})

export default router