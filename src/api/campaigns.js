// api/campaigns.js — Campaign Automation REST API (tenant-scoped).
//
// Mounted at /api/client/campaigns, gated by requireClient. Follows src/api/client.js
// conventions: tenant always from req.auth.tenantId, never the request body. The API
// only reads/writes Postgres and ENQUEUES jobs — it never dials inline, so requests
// stay fast and campaign execution runs in the worker pool.

import { Router } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { guardRouter } from './permissions.js'
import { enqueueRun, scheduleRunOnce, cancelScheduledRun, scheduleRecurring, cancelRecurring, queueCounts, enqueueSourceSync, scheduleSourcePoll, cancelSourcePoll, CAMPAIGNS_ENABLED, CAMPAIGN_RUNNER } from '../queue/queues.js'
import { REDIS_ENABLED } from '../queue/connection.js'
import { importContacts, buildContacts, parsePastedList } from '../services/campaigns/contacts.js'
import { parseFileToRows, INGRESS_PRESETS } from '../services/campaigns/sources.js'
import { rollupCampaign } from '../services/campaigns/analytics.js'
import { dialerInfo } from '../services/campaigns/dialer.js'
import telemetry from '../services/telemetry.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
router.use(requireClient())
// Owners and managers run campaigns; front-line agents never see this router.
// Guarding by method means a route added later inherits the check automatically.
router.use(guardRouter({ read: 'campaigns:read', write: 'campaigns:write' }))

// Ensure a campaign belongs to the caller's tenant; returns it or null.
async function ownedCampaign(id, tenantId) {
  const { data } = await supabase.from('campaigns').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
  return data || null
}

// ─── Campaigns CRUD ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase.from('campaigns')
      .select('*').eq('tenant_id', t).order('created_at', { ascending: false })
    if (error) throw error
    // Attach light contact counts.
    const ids = (data || []).map(c => c.id)
    const counts = {}
    if (ids.length) {
      const { data: rows } = await supabase.from('campaign_contacts').select('campaign_id, status').in('campaign_id', ids)
      for (const r of rows || []) {
        counts[r.campaign_id] ||= { total: 0, completed: 0 }
        counts[r.campaign_id].total++
        if (r.status === 'completed') counts[r.campaign_id].completed++
      }
    }
    res.json({ campaigns: (data || []).map(c => ({ ...c, contacts: counts[c.id] || { total: 0, completed: 0 } })) })
  } catch (e) { console.error('[CAMPAIGNS] list:', e.message); res.status(500).json({ error: 'Could not load campaigns' }) }
})

router.post('/', async (req, res) => {
  const t = req.auth.tenantId
  const { name, type, config, schedule, retry_policy, compliance, from_number } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name is required' })
  const { data, error } = await supabase.from('campaigns').insert({
    tenant_id: t, name, type: type || 'ai_sales', status: 'draft', direction: 'outbound',
    config: config || {}, schedule: schedule || {}, retry_policy: retry_policy || {},
    compliance: compliance || {}, from_number: from_number || null, created_by: req.auth.userId,
  }).select().single()
  if (error) { console.error('[CAMPAIGNS] create:', error.message); return res.status(500).json({ error: 'Could not create campaign' }) }
  res.status(201).json(data)
})

router.get('/dialer', (_req, res) => res.json(dialerInfo()))

// ─── Real-time monitor (queue depths + running campaigns + live outbound calls) ─
router.get('/monitor', async (req, res) => {
  const t = req.auth.tenantId
  try {
    const [{ data: running }, counts] = await Promise.all([
      supabase.from('campaigns').select('id, name, status, type').eq('tenant_id', t).eq('status', 'running'),
      queueCounts(),
    ])
    const liveOutbound = telemetry.getActiveCalls().filter(c => c.direction === 'outbound' && c.tenantId === t)
    res.json({ redis: REDIS_ENABLED, runner: CAMPAIGN_RUNNER, running: running || [], queues: counts, liveCalls: liveOutbound })
  } catch (e) { res.status(500).json({ error: 'Could not load monitor' }) }
})

// ─── Suppression list (compliance) ────────────────────────────────────────────
router.get('/suppression', async (req, res) => {
  const { data } = await supabase.from('suppression_list').select('*').eq('tenant_id', req.auth.tenantId).order('created_at', { ascending: false })
  res.json({ entries: data || [] })
})
router.post('/suppression', async (req, res) => {
  const { phone, reason } = req.body || {}
  if (!phone) return res.status(400).json({ error: 'phone is required' })
  const { error } = await supabase.from('suppression_list').upsert(
    { tenant_id: req.auth.tenantId, phone, reason: reason || 'opt_out' }, { onConflict: 'tenant_id,phone' })
  if (error) return res.status(500).json({ error: 'Could not add to suppression' })
  res.json({ ok: true })
})

// ─── Templates ────────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const { data } = await supabase.from('campaign_templates').select('*')
    .or(`tenant_id.eq.${req.auth.tenantId},tenant_id.is.null`).order('created_at', { ascending: false })
  res.json({ templates: data || [] })
})
router.post('/templates', async (req, res) => {
  const { name, type, config } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name is required' })
  const { data, error } = await supabase.from('campaign_templates')
    .insert({ tenant_id: req.auth.tenantId, name, type: type || 'ai_sales', config: config || {} }).select().single()
  if (error) return res.status(500).json({ error: 'Could not create template' })
  res.status(201).json(data)
})

// ─── Single campaign ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  res.json(c)
})

router.patch('/:id', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const patch = {}
  for (const k of ['name', 'type', 'config', 'schedule', 'retry_policy', 'compliance', 'from_number', 'status']) {
    if (req.body[k] !== undefined) patch[k] = req.body[k]
  }
  patch.updated_at = new Date().toISOString()
  const { data, error } = await supabase.from('campaigns').update(patch).eq('id', c.id).select().single()
  if (error) return res.status(500).json({ error: 'Could not update campaign' })
  res.json(data)
})

router.delete('/:id', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await cancelRecurring(c.id)
  await cancelScheduledRun(c.id)
  await supabase.from('campaign_contacts').delete().eq('campaign_id', c.id)
  await supabase.from('campaigns').delete().eq('id', c.id)
  res.json({ ok: true })
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!CAMPAIGNS_ENABLED) return res.status(503).json({ error: 'Campaign runner disabled (CAMPAIGN_RUNNER=off). Set REDIS_URL + run the worker, or leave it unset for the in-process runner.' })

  // Optional body.start_at (ISO datetime) → persist and start at that moment.
  let sched = c.schedule || {}
  const startAt = req.body?.start_at
  if (startAt !== undefined) {
    if (startAt && isNaN(new Date(startAt).getTime())) return res.status(400).json({ error: 'start_at must be a valid datetime' })
    sched = { ...sched, mode: 'once', start_at: startAt || null }
    await supabase.from('campaigns').update({ schedule: sched }).eq('id', c.id)
  }

  if (sched.mode === 'recurring' && (sched.cron || sched.every_ms)) {
    await scheduleRecurring(c.id, { campaignId: c.id }, sched.cron ? { pattern: sched.cron } : { every: sched.every_ms })
    await supabase.from('campaigns').update({ status: 'scheduled' }).eq('id', c.id)
    return res.json({ ok: true, scheduled: true })
  }
  // Immediate / one-time: enqueue a run (delayed if a start_at is set).
  const delay = sched.start_at ? Math.max(0, new Date(sched.start_at).getTime() - Date.now()) : 0
  await cancelScheduledRun(c.id)   // drop any previous pending/finished run-once job so the jobId is free
  if (delay) await scheduleRunOnce(c.id, delay)
  else await enqueueRun({ campaignId: c.id })
  await supabase.from('campaigns').update({ status: delay ? 'scheduled' : 'running' }).eq('id', c.id)
  res.json({ ok: true, queued: true, delayMs: delay })
})

// Cancel a pending scheduled start (status goes back to draft).
router.post('/:id/unschedule', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await cancelScheduledRun(c.id)
  const sched = { ...(c.schedule || {}) }
  delete sched.start_at
  const patch = { schedule: sched }
  if (c.status === 'scheduled') patch.status = 'draft'
  await supabase.from('campaigns').update(patch).eq('id', c.id)
  res.json({ ok: true })
})

router.post('/:id/pause', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await supabase.from('campaigns').update({ status: 'paused' }).eq('id', c.id)
  res.json({ ok: true })
})
router.post('/:id/resume', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (CAMPAIGNS_ENABLED) await enqueueRun({ campaignId: c.id })
  await supabase.from('campaigns').update({ status: 'running' }).eq('id', c.id)
  res.json({ ok: true })
})
router.post('/:id/stop', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await cancelRecurring(c.id)
  await cancelScheduledRun(c.id)
  await supabase.from('campaigns').update({ status: 'completed' }).eq('id', c.id)
  await supabase.from('campaign_runs').update({ status: 'stopped', ended_at: new Date().toISOString() })
    .eq('campaign_id', c.id).eq('status', 'running')
  res.json({ ok: true })
})
router.post('/:id/duplicate', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { id, created_at, updated_at, ...rest } = c
  const { data, error } = await supabase.from('campaigns')
    .insert({ ...rest, name: `${c.name} (copy)`, status: 'draft' }).select().single()
  if (error) return res.status(500).json({ error: 'Could not duplicate' })
  res.status(201).json(data)
})

// ─── Contacts ─────────────────────────────────────────────────────────────────
router.get('/:id/contacts', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(200, parseInt(req.query.limit) || 50)
  const from = (page - 1) * limit
  const { data, count } = await supabase.from('campaign_contacts')
    .select('*', { count: 'exact' }).eq('campaign_id', c.id)
    .order('created_at', { ascending: false }).range(from, from + limit - 1)
  res.json({ contacts: data || [], total: count || 0, page, limit })
})

router.post('/:id/contacts', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : []
  const { contacts, invalidCount, duplicateCount } = buildContacts(list)
  const { inserted } = await importContacts(req.auth.tenantId, c.id, contacts)
  res.json({ inserted, invalidCount, duplicateCount })
})

router.post('/:id/contacts/paste', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const rows = parsePastedList(req.body?.text || '')
  const { contacts, invalidCount, duplicateCount } = buildContacts(rows)
  const { inserted } = await importContacts(req.auth.tenantId, c.id, contacts)
  res.json({ inserted, invalidCount, duplicateCount })
})

router.post('/:id/contacts/import', upload.single('file'), async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!req.file) return res.status(400).json({ error: 'file is required' })
  try {
    // Parse any supported file (CSV, Excel, TXT, PDF, Word) → rows.
    const rows = await parseFileToRows(req.file.buffer, req.file.originalname, req.file.mimetype)
    const { contacts, invalidCount, duplicateCount } = buildContacts(rows)
    const { inserted } = await importContacts(req.auth.tenantId, c.id, contacts)
    await supabase.from('contact_sources').insert({
      tenant_id: req.auth.tenantId, campaign_id: c.id, kind: 'file',
      name: req.file.originalname, filename: req.file.originalname, row_count: inserted, status: 'ready',
    })
    res.json({ inserted, invalidCount, duplicateCount, parsed: rows.length })
  } catch (e) { console.error('[CAMPAIGNS] import:', e.message); res.status(400).json({ error: e.message || 'Import failed' }) }
})

// ─── Schedule / retry config ──────────────────────────────────────────────────
router.put('/:id/schedule', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await supabase.from('campaigns').update({ schedule: req.body || {} }).eq('id', c.id)
  res.json({ ok: true })
})
router.put('/:id/retry', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await supabase.from('campaigns').update({ retry_policy: req.body || {} }).eq('id', c.id)
  res.json({ ok: true })
})

// ─── Data sources ─────────────────────────────────────────────────────────────
// A "source" is where contacts come from. Batch sources (google_sheet, database)
// are pulled by the worker; realtime sources (webhook/crm/lead ads) push into the
// ingress endpoint (/api/events/:id). Files are handled by /contacts/import above.
router.get('/:id/sources', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { data } = await supabase.from('contact_sources').select('*')
    .eq('campaign_id', c.id).order('created_at', { ascending: false })
  res.json({ sources: data || [] })
})

router.post('/:id/sources', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { kind, name, config } = req.body || {}
  if (!['google_sheet', 'database'].includes(kind)) return res.status(400).json({ error: 'kind must be google_sheet or database' })
  if (kind === 'google_sheet' && !config?.url) return res.status(400).json({ error: 'config.url (sheet link) is required' })
  if (kind === 'database' && !config?.query) return res.status(400).json({ error: 'config.query is required' })

  const { data, error } = await supabase.from('contact_sources').insert({
    tenant_id: req.auth.tenantId, campaign_id: c.id, kind,
    name: name || (kind === 'google_sheet' ? 'Google Sheet' : 'Database'),
    config: config || {}, status: 'ready',
  }).select().single()
  if (error) { console.error('[CAMPAIGNS] create source:', error.message); return res.status(500).json({ error: 'Could not create source' }) }

  if (CAMPAIGNS_ENABLED) {
    await enqueueSourceSync(data.id)                                   // pull immediately
    const poll = Number(config?.poll_seconds || 0)
    if (poll >= 30) await scheduleSourcePoll(data.id, poll * 1000)     // keep it fresh
  }
  res.status(201).json(data)
})

router.post('/:id/sources/:sourceId/sync', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!CAMPAIGNS_ENABLED) return res.status(503).json({ error: 'Campaign runner disabled (CAMPAIGN_RUNNER=off)' })
  const { data: src } = await supabase.from('contact_sources').select('id').eq('id', req.params.sourceId).eq('campaign_id', c.id).maybeSingle()
  if (!src) return res.status(404).json({ error: 'Source not found' })
  await enqueueSourceSync(src.id)
  res.json({ ok: true })
})

router.delete('/:id/sources/:sourceId', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  await cancelSourcePoll(req.params.sourceId)
  await supabase.from('contact_sources').delete().eq('id', req.params.sourceId).eq('campaign_id', c.id)
  res.json({ ok: true })
})

// ─── Real-time ingress URL + token (CRM / webhook / Meta & Google Lead Ads) ──
// The instant a contact lands in the client's system, they POST it here and we dial
// within seconds (handled by src/api/events.js). Field mapping uses a per-source preset.
router.get('/:id/trigger', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  let token = c.config?.event_token
  if (!token) {
    token = randomUUID().replace(/-/g, '')
    await supabase.from('campaigns').update({ config: { ...(c.config || {}), event_token: token } }).eq('id', c.id)
  }
  const base = process.env.PUBLIC_HOST || process.env.NGROK_URL || ''
  const path = `/api/events/${c.id}`
  res.json({
    url: base ? `https://${base}${path}` : path,
    token, header: 'X-Campaign-Token',
    presets: Object.keys(INGRESS_PRESETS),         // crm sources the ingress understands out of the box
    active_preset: c.config?.ingest_source || 'generic',
  })
})

router.post('/:id/trigger/rotate', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const token = randomUUID().replace(/-/g, '')
  await supabase.from('campaigns').update({ config: { ...(c.config || {}), event_token: token } }).eq('id', c.id)
  res.json({ token })
})

// Choose which CRM/lead-ad preset the ingress should assume for this campaign.
router.put('/:id/trigger/preset', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { preset } = req.body || {}
  if (preset && !INGRESS_PRESETS[preset]) return res.status(400).json({ error: 'unknown preset' })
  await supabase.from('campaigns').update({ config: { ...(c.config || {}), ingest_source: preset || 'generic' } }).eq('id', c.id)
  res.json({ ok: true })
})

// ─── Analytics / runs / logs ──────────────────────────────────────────────────
router.get('/:id/analytics', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const metrics = await rollupCampaign(c.id)   // recompute from truth (cheap, idempotent)
  res.json({ metrics })
})
router.get('/:id/runs', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { data } = await supabase.from('campaign_runs').select('*').eq('campaign_id', c.id).order('started_at', { ascending: false })
  res.json({ runs: data || [] })
})
router.get('/:id/logs', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { data } = await supabase.from('campaign_logs').select('*').eq('campaign_id', c.id).order('ts', { ascending: false }).limit(200)
  res.json({ logs: data || [] })
})

export default router
