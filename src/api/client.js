// api/client.js — Client (tenant-scoped) endpoints
// The tenant is always taken from req.auth.tenantId (never from the request),
// so a client can only ever see their own data.

import { Router } from 'express'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { requirePermission, permissionsFor } from './permissions.js'
import { notify } from '../services/notifications.js'
import { getRecordingUrl } from '../services/recording.js'
const router = Router()

router.use(requireClient())

// ─── Who am I? ───────────────────────────────────────────────────────────────
// The one endpoint every signed-in user can call regardless of role. The dashboard
// shell needs the business name and the caller's permissions before it can render
// navigation — it previously called GET /api/client/agent for this, which employees
// have no business reading.
router.get('/me', async (req, res) => {
  try {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, name, phone_number, config')
      .eq('id', req.auth.tenantId)
      .single()

    // Best-effort: powers "last active" on the Team page. Never block the response.
    supabase.from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', req.auth.userId)
      .then(() => {}, () => {})

    const { data: profile } = await supabase
      .from('profiles').select('phone').eq('id', req.auth.userId).maybeSingle()

    res.json({
      user_id: req.auth.userId,
      email: req.auth.email,
      full_name: req.auth.fullName,
      phone: profile?.phone || null,
      role: req.auth.role,
      tenant_role: req.auth.tenantRole,
      permissions: permissionsFor(req.auth.tenantRole),
      tenant: {
        id: tenant?.id || null,
        name: tenant?.name || null,
        business_name: tenant?.config?.business_name || tenant?.name || null,
        // Onboarding is the OWNER's job — the shell uses this to decide whether to
        // redirect (owner) or show a "setup in progress" state (employee).
        phone_number: tenant?.phone_number || null,
        status: tenant?.config?.status || 'draft',
      },
    })
  } catch (e) {
    console.error('[CLIENT] me error:', e.message)
    res.status(500).json({ error: 'Could not load your profile' })
  }
})

// ─── PATCH /me — update your own profile ─────────────────────────────────────
// Name and phone only. Email is deliberately NOT editable here: changing the login
// address needs a verification round-trip to the new address, otherwise a typo
// locks you out of your own account.
router.patch('/me', async (req, res) => {
  const { full_name: fullName, phone } = req.body || {}
  const patch = {}

  if (fullName !== undefined) {
    const name = String(fullName).trim()
    if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })
    patch.full_name = name || null
  }
  if (phone !== undefined) {
    const p = String(phone).trim()
    if (p && !/^[+0-9 ()-]{6,20}$/.test(p)) {
      return res.status(400).json({ error: 'That does not look like a phone number' })
    }
    patch.phone = p || null
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' })

  try {
    const { data, error } = await supabase
      .from('profiles').update(patch).eq('id', req.auth.userId)
      .select('id, email, full_name, phone, tenant_role').single()
    if (error) throw error
    res.json({ profile: data })
  } catch (e) {
    console.error('[CLIENT] profile update error:', e.message)
    res.status(500).json({ error: 'Could not save your profile' })
  }
})

// ─── Overview (dashboard summary) ─────────────────────────────────────────────
router.get('/overview', requirePermission('calls:read'), async (req, res) => {
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
router.get('/calls', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, parseInt(req.query.limit) || 20)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    let q = supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, created_at, direction, campaign_id', { count: 'exact' })
      .eq('tenant_id', t)
      .order('created_at', { ascending: false })

    // Optional direction filter so the dashboard can show separate Inbound /
    // Outbound tabs. Anything not explicitly 'outbound' (incl. legacy NULL rows)
    // counts as inbound.
    if (req.query.direction === 'outbound') q = q.eq('direction', 'outbound')
    else if (req.query.direction === 'inbound') q = q.or('direction.is.null,direction.neq.outbound')

    const { data, count, error } = await q.range(from, to)
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
router.get('/calls/:id', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: call, error } = await supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, transcript, recording_path, created_at')
      .eq('id', req.params.id)
      .eq('tenant_id', t)   // scope guard
      .single()
    if (error || !call) return res.status(404).json({ error: 'Call not found' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('call_id', call.id).maybeSingle()

    // Mint a short-lived signed URL for in-dashboard playback (bucket is private).
    const recording_url = await getRecordingUrl(call.recording_path)

    res.json({ ...call, recording_url, lead: lead || null })
  } catch (e) {
    console.error('[CLIENT] call detail error:', e.message)
    res.status(500).json({ error: 'Could not load call' })
  }
})

// ─── Leads (paginated, filterable) ────────────────────────────────────────────
router.get('/leads', requirePermission('leads:read'), async (req, res) => {
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
    if (req.query.status) q = q.eq('status', req.query.status)
    // 'me' powers an agent's default view without the frontend knowing its own id.
    if (req.query.assigned_to === 'me') q = q.eq('assigned_to', req.auth.userId)
    else if (req.query.assigned_to === 'unassigned') q = q.is('assigned_to', null)
    else if (req.query.assigned_to) q = q.eq('assigned_to', req.query.assigned_to)

    const { data, count, error } = await q.range(from, to)
    if (error) throw error

    // Attach each lead's call transcript (lives on the calls table, linked by
    // call_id) so the Leads UI can show it without a second round-trip per row.
    const leads = data || []
    const callIds = [...new Set(leads.map(l => l.call_id).filter(Boolean))]
    if (callIds.length) {
      const { data: calls } = await supabase
        .from('calls').select('id, transcript').in('id', callIds)
      const byId = new Map((calls || []).map(c => [c.id, c.transcript]))
      for (const l of leads) l.transcript = byId.get(l.call_id) || null
    }

    res.json({ leads, total: count || 0, page, limit })
  } catch (e) {
    console.error('[CLIENT] leads error:', e.message)
    res.status(500).json({ error: 'Could not load leads' })
  }
})

// ─── Export leads as CSV ──────────────────────────────────────────────────────
router.get('/leads/export', requirePermission('leads:read'), async (req, res) => {
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

// ─── Update a lead (status / assignment / notes) ──────────────────────────────
// This is the whole point of employee access: a lead arrives from a call, and a
// person moves it through the pipeline. Every change appends to lead_activity so
// there is an answer to "who marked this won, and when".
const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost']

router.patch('/leads/:id', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  const { status, assigned_to, notes } = req.body || {}

  if (status !== undefined && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` })
  }

  try {
    // Scope the read to the tenant FIRST — this is what stops a valid user of
    // business A from editing a lead belonging to business B.
    const { data: existing } = await supabase
      .from('leads').select('id, status, assigned_to').eq('id', req.params.id).eq('tenant_id', t).maybeSingle()
    if (!existing) return res.status(404).json({ error: 'Lead not found' })

    // An assignee must be a real member of THIS business. Never trust the id.
    if (assigned_to) {
      const { data: member } = await supabase
        .from('profiles').select('id').eq('id', assigned_to).eq('tenant_id', t).maybeSingle()
      if (!member) return res.status(400).json({ error: 'That person is not a member of this business' })
    }

    const patch = { updated_at: new Date().toISOString() }
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = notes
    if (assigned_to !== undefined) patch.assigned_to = assigned_to || null

    const { data: updated, error } = await supabase
      .from('leads').update(patch).eq('id', req.params.id).eq('tenant_id', t).select().single()
    if (error) throw error

    // Audit trail — one row per meaningful change, not per request.
    const events = []
    if (status !== undefined && status !== existing.status) {
      events.push({ action: 'status_changed', detail: { from: existing.status, to: status } })
    }
    if (assigned_to !== undefined && (assigned_to || null) !== existing.assigned_to) {
      events.push(assigned_to
        ? { action: 'assigned', detail: { to: assigned_to, from: existing.assigned_to } }
        : { action: 'unassigned', detail: { from: existing.assigned_to } })
    }
    if (notes !== undefined) events.push({ action: 'note_added', detail: {} })

    if (events.length) {
      await supabase.from('lead_activity').insert(
        events.map(e => ({ ...e, lead_id: req.params.id, tenant_id: t, actor_id: req.auth.userId }))
      )
    }

    // Tell someone a lead landed on their desk — but never notify yourself for
    // claiming your own lead, which is the most common assignment by far.
    if (assigned_to && assigned_to !== existing.assigned_to && assigned_to !== req.auth.userId) {
      await notify([assigned_to], {
        tenantId: t,
        kind: 'lead_assigned',
        title: 'A lead was assigned to you',
        body: updated.name ? `${updated.name} — ${updated.intent || 'new enquiry'}` : (updated.summary || '').slice(0, 140),
        link: '/leads',
      })
    }

    res.json({ lead: updated })
  } catch (e) {
    console.error('[CLIENT] lead update error:', e.message)
    res.status(500).json({ error: 'Could not update the lead' })
  }
})

// ─── Lead activity timeline ───────────────────────────────────────────────────
router.get('/leads/:id/activity', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase
      .from('lead_activity')
      .select('id, action, detail, actor_id, created_at')
      .eq('lead_id', req.params.id).eq('tenant_id', t)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error

    // Resolve actor ids to names so the timeline reads "Priya marked this won".
    const actorIds = [...new Set((data || []).map(a => a.actor_id).filter(Boolean))]
    let byId = new Map()
    if (actorIds.length) {
      const { data: people } = await supabase
        .from('profiles').select('id, full_name, email').in('id', actorIds)
      byId = new Map((people || []).map(p => [p.id, p.full_name || p.email]))
    }

    res.json({
      activity: (data || []).map(a => ({ ...a, actor_name: byId.get(a.actor_id) || 'Someone' })),
    })
  } catch (e) {
    console.error('[CLIENT] lead activity error:', e.message)
    res.status(500).json({ error: 'Could not load activity' })
  }
})

export default router