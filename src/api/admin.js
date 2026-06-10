// api/admin.js — Admin (platform owner) endpoints. Full access.
import { Router } from 'express'
import { supabase } from './db.js'
import { requireAdmin } from './auth.js'
import { ingestText } from '../ingest.js'
const router = Router()

router.use(requireAdmin())

// ─── Platform overview ────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const [{ data: stats }, { data: chart }, { data: recent }] = await Promise.all([
      supabase.rpc('platform_stats'),
      supabase.rpc('platform_calls_last_7_days'),
      supabase
        .from('calls')
        .select('id, caller_number, duration_seconds, created_at, tenant_id, tenants(name)')
        .order('created_at', { ascending: false })
        .limit(10),
    ])
    const s = stats?.[0] || {}
    res.json({
      total_tenants: Number(s.total_tenants || 0),
      total_calls: Number(s.total_calls || 0),
      total_minutes: Number(s.total_minutes || 0),
      total_leads: Number(s.total_leads || 0),
      calls_last_7_days: (chart || []).map(r => ({ date: r.date, count: Number(r.count) })),
      recent_calls: (recent || []).map(c => ({
        id: c.id,
        tenant_name: c.tenants?.name || 'Unknown',
        caller_number: c.caller_number,
        duration_seconds: c.duration_seconds,
        created_at: c.created_at,
      })),
    })
  } catch (e) {
    console.error('[ADMIN] overview error:', e.message)
    res.status(500).json({ error: 'Could not load overview' })
  }
})

// ─── Tenants list (with per-tenant stats) ─────────────────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, name, phone_number, config, created_at')
      .order('created_at', { ascending: false })
    if (error) throw error

    // Attach stats per tenant
    const withStats = await Promise.all((tenants || []).map(async (t) => {
      const { data: s } = await supabase.rpc('tenant_stats', { t_id: t.id })
      const st = s?.[0] || {}
      return {
        ...t,
        stats: {
          total_calls: Number(st.total_calls || 0),
          total_minutes: Number(st.total_minutes || 0),
          total_leads: Number(st.total_leads || 0),
        },
      }
    }))
    res.json(withStats)
  } catch (e) {
    console.error('[ADMIN] tenants error:', e.message)
    res.status(500).json({ error: 'Could not load clients' })
  }
})

// ─── Single tenant ────────────────────────────────────────────────────────────
router.get('/tenants/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, phone_number, config, created_at')
    .eq('id', req.params.id)
    .single()
  if (error || !data) return res.status(404).json({ error: 'Client not found' })
  res.json(data)
})

// ─── Create tenant ────────────────────────────────────────────────────────────
router.post('/tenants', async (req, res) => {
  const { name, phone_number, config } = req.body || {}
  if (!name || !phone_number) {
    return res.status(400).json({ error: 'name and phone_number are required' })
  }
  const { data, error } = await supabase
    .from('tenants')
    .insert({ name, phone_number, config: config || {} })
    .select('id, name, phone_number, config, created_at')
    .single()
  if (error) {
    console.error('[ADMIN] create tenant error:', error.message)
    return res.status(500).json({ error: 'Could not create client' })
  }
  res.status(201).json(data)
})

// ─── Update tenant ────────────────────────────────────────────────────────────
router.patch('/tenants/:id', async (req, res) => {
  const { name, phone_number, config } = req.body || {}
  const patch = {}
  if (name !== undefined) patch.name = name
  if (phone_number !== undefined) patch.phone_number = phone_number
  if (config !== undefined) patch.config = config
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' })
  }
  const { data, error } = await supabase
    .from('tenants').update(patch).eq('id', req.params.id)
    .select('id, name, phone_number, config, created_at').single()
  if (error || !data) {
    console.error('[ADMIN] update tenant error:', error?.message)
    return res.status(500).json({ error: 'Could not update client' })
  }
  res.json(data)
})

// ─── Delete tenant ────────────────────────────────────────────────────────────
router.delete('/tenants/:id', async (req, res) => {
  const { error } = await supabase.from('tenants').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'Could not delete client' })
  res.json({ success: true })
})

// ─── Knowledge base: list ─────────────────────────────────────────────────────
router.get('/tenants/:id/knowledge', async (req, res) => {
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('id, content, source, created_at')
    .eq('tenant_id', req.params.id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Could not load knowledge' })
  res.json(data || [])
})

// ─── Knowledge base: add (paste text) ─────────────────────────────────────────
// Accepts { text, source?, replace? }. (File uploads: send file contents as text.)
router.post('/tenants/:id/knowledge', async (req, res) => {
  const { text, source, replace } = req.body || {}
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })
  try {
    const result = await ingestText(req.params.id, text, source || 'admin-upload', { replace: !!replace })
    res.json(result)  // { chunks_added }
  } catch (e) {
    console.error('[ADMIN] ingest error:', e.message)
    res.status(500).json({ error: 'Could not ingest knowledge' })
  }
})

// ─── Knowledge base: delete one chunk ─────────────────────────────────────────
router.delete('/tenants/:id/knowledge/:chunkId', async (req, res) => {
  const { error } = await supabase
    .from('knowledge_base').delete()
    .eq('id', req.params.chunkId).eq('tenant_id', req.params.id)
  if (error) return res.status(500).json({ error: 'Could not delete chunk' })
  res.json({ success: true })
})

// ─── Knowledge base: clear all for a tenant ───────────────────────────────────
router.delete('/tenants/:id/knowledge', async (req, res) => {
  const { error } = await supabase
    .from('knowledge_base').delete().eq('tenant_id', req.params.id)
  if (error) return res.status(500).json({ error: 'Could not clear knowledge' })
  res.json({ success: true })
})

export default router