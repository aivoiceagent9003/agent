// api/admin.js — Admin (platform owner) endpoints. Full access.
import { Router } from 'express'
import { supabase } from './db.js'
import { requireAdmin } from './auth.js'
import { ingestText } from '../ingest.js'
import { listMessages, recipientsOf } from '../services/conversations.js'
import { notify } from '../services/notifications.js'
import hub from '../services/realtime-hub.js'
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

// ─── Support inbox ────────────────────────────────────────────────────────────
// The other end of the "Vocera Support" thread every person sees in Messages.
// Without this, that thread would be a box customers shout into.
//
// Support threads are PER PERSON (conversations.created_by), not per business, so
// an employee can raise something without their employer reading it. That means a
// single business can appear here several times — every thread is labelled with
// who it is from, or staff would be answering identical-looking rows.
//
// Admins are not conversation_members (they belong to no tenant), so these routes
// address support threads by id rather than by membership.

// GET /api/admin/support — every support thread, most recently active first
router.get('/support', async (_req, res) => {
  try {
    const { data: convos } = await supabase
      .from('conversations')
      .select('id, tenant_id, created_by, last_message_at, tenants(name)')
      .eq('kind', 'support')
      .order('last_message_at', { ascending: false })
      .limit(100)

    if (!convos?.length) return res.json({ threads: [] })

    // Whose thread each one is. Without this the inbox is a list of businesses
    // repeated once per employee, with no way to tell them apart.
    const ownerIds = [...new Set(convos.map(c => c.created_by).filter(Boolean))]
    const { data: owners } = ownerIds.length
      ? await supabase.from('profiles').select('id, full_name, email, tenant_role').in('id', ownerIds)
      : { data: [] }
    const ownerById = new Map((owners || []).map(p => [p.id, p]))

    // Latest message per thread, for the preview line.
    const ids = convos.map(c => c.id)
    const { data: recent } = await supabase
      .from('messages')
      .select('conversation_id, body, created_at, is_system, sender_id')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .limit(300)

    const lastByConvo = new Map()
    for (const m of recent || []) {
      if (!lastByConvo.has(m.conversation_id)) lastByConvo.set(m.conversation_id, m)
    }

    res.json({
      threads: convos.map(c => {
        const last = lastByConvo.get(c.id)
        const person = ownerById.get(c.created_by)
        return {
          conversation_id: c.id,
          tenant_id: c.tenant_id,
          business_name: c.tenants?.name || 'Unknown business',
          person_name: person ? person.full_name || person.email : null,
          person_role: person?.tenant_role || null,
          last_message_at: c.last_message_at,
          last_message: last?.body || null,
          // A customer message that nobody has replied to yet is what an admin
          // actually needs to see — surface it as the queue signal.
          awaiting_reply: !!last && !last.is_system,
        }
      }),
    })
  } catch (e) {
    console.error('[ADMIN] support list error:', e.message)
    res.status(500).json({ error: 'Could not load support threads' })
  }
})

// GET /api/admin/support/:conversationId — full thread
router.get('/support/:conversationId', async (req, res) => {
  try {
    const { data: convo } = await supabase
      .from('conversations').select('id, tenant_id, kind, created_by, tenants(name)')
      .eq('id', req.params.conversationId).maybeSingle()
    if (!convo || convo.kind !== 'support') {
      return res.status(404).json({ error: 'Support thread not found' })
    }

    const { data: person } = convo.created_by
      ? await supabase.from('profiles')
          .select('full_name, email, tenant_role').eq('id', convo.created_by).maybeSingle()
      : { data: null }

    const messages = await listMessages(convo.id, { limit: 200 })
    res.json({
      business_name: convo.tenants?.name || null,
      tenant_id: convo.tenant_id,
      person_name: person ? person.full_name || person.email : null,
      person_role: person?.tenant_role || null,
      messages,
    })
  } catch (e) {
    console.error('[ADMIN] support thread error:', e.message)
    res.status(500).json({ error: 'Could not load that thread' })
  }
})

// POST /api/admin/support/:conversationId { body } — reply as Vocera Support
router.post('/support/:conversationId', async (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' })

  try {
    const { data: convo } = await supabase
      .from('conversations').select('id, tenant_id, kind')
      .eq('id', req.params.conversationId).maybeSingle()
    if (!convo || convo.kind !== 'support') {
      return res.status(404).json({ error: 'Support thread not found' })
    }

    // is_system marks it as "Vocera Support" rather than a named person, so the
    // customer sees a consistent identity no matter which admin replies.
    const { data: message, error } = await supabase.from('messages').insert({
      conversation_id: convo.id,
      tenant_id: convo.tenant_id,
      is_system: true,
      body,
    }).select('id, sender_id, is_system, body, created_at').single()
    if (error) throw error

    const enriched = { ...message, sender_name: 'Vocera Support', conversation_id: convo.id }
    const recipients = await recipientsOf(convo.id, null)
    hub.publishMany(recipients, { type: 'message', message: enriched })

    const offline = recipients.filter(id => !hub.isOnline(id))
    if (offline.length) {
      await notify(offline, {
        tenantId: convo.tenant_id,
        kind: 'message',
        title: 'Vocera Support replied',
        body: body.slice(0, 140),
        link: `/messages?c=${convo.id}`,
      })
    }

    res.status(201).json({ message: enriched })
  } catch (e) {
    console.error('[ADMIN] support reply error:', e.message)
    res.status(500).json({ error: 'Could not send your reply' })
  }
})

export default router