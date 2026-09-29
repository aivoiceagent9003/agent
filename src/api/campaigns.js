// api/campaigns.js — Campaign Automation REST API (tenant-scoped).
//
// Mounted at /api/client/campaigns, gated by requireClient. Follows src/api/client.js
// conventions: tenant always from req.auth.tenantId, never the request body. The API
// only reads/writes Postgres and ENQUEUES jobs — it never dials inline, so requests
// stay fast and campaign execution runs in the worker pool.

import { Router } from 'express'
import { makeUpload, sniff, KINDS, uploadErrorHandler } from './uploads.js'
import { campaignWriteLimiter, ingestLimiter } from './rate-limits.js'
import { randomUUID } from 'node:crypto'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { guardRouter, requirePermission } from './permissions.js'
import { enqueueRun, scheduleRunOnce, cancelScheduledRun, scheduleRecurring, cancelRecurring, queueCounts, enqueueSourceSync, scheduleSourcePoll, cancelSourcePoll, CAMPAIGNS_ENABLED, CAMPAIGN_RUNNER } from '../queue/queues.js'
import { REDIS_ENABLED } from '../queue/connection.js'
import { importContacts, buildContacts, parsePastedList } from '../services/campaigns/contacts.js'
import { parseFileToRows, INGRESS_PRESETS } from '../services/campaigns/sources.js'
import { rollupCampaign } from '../services/campaigns/analytics.js'
import { dialerInfo } from '../services/campaigns/dialer.js'
import { extractTextFromFile } from '../services/extract-text.js'
import {
  listCampaignDocuments, addCampaignDocument, deleteCampaignDocument, deleteAllCampaignDocuments,
  copyCampaignDocuments, readyCampaignFileCount, pendingKnowledgeOffer, decideCampaignKnowledge,
  offerCampaignKnowledge,
} from '../services/campaigns/knowledge.js'
import telemetry from '../services/telemetry.js'

const router = Router()
const upload = makeUpload({ limitMb: 25, kinds: KINDS.contacts })
// Files an AI campaign talks from: the same types and cap as the knowledge base.
const kbUpload = makeUpload({ limitMb: 15, kinds: KINDS.knowledge })
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

router.post('/', campaignWriteLimiter, async (req, res) => {
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
  // Its own files go with it. Any the owner added to the knowledge base were copied
  // there and are unaffected.
  await deleteAllCampaignDocuments(c.id).catch(e => console.error('[CAMPAIGNS] delete files:', e.message))
  await supabase.from('campaigns').delete().eq('id', c.id)
  res.json({ ok: true })
})

// ─── Lifecycle ────────────────────────────────────────────────────────────────

// An AI campaign set to talk only from its own files, with none ready, would ring
// its whole list and not be able to answer one question about why it called.
// Returns an error message, or null when the campaign is fine to dial.
async function campaignFilesProblem(c) {
  if (c.type === 'broadcast' || c.config?.kb_source !== 'campaign') return null
  try {
    if ((await readyCampaignFileCount(c.id)) > 0) return null
    return 'This campaign is set to talk only from its own files, and none are uploaded yet. Upload a file in the Agent tab, or switch it to use your knowledge base.'
  } catch (e) {
    console.error('[CAMPAIGNS] campaign files check:', e.message)
    return 'Campaign files are unavailable right now (has sql/campaign-knowledge.sql been run?). Switch the campaign to use your knowledge base, or try again.'
  }
}

router.post('/:id/start', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!CAMPAIGNS_ENABLED) return res.status(503).json({ error: 'Campaign runner disabled (CAMPAIGN_RUNNER=off). Set REDIS_URL + run the worker, or leave it unset for the in-process runner.' })
  const filesProblem = await campaignFilesProblem(c)
  if (filesProblem) return res.status(400).json({ error: filesProblem })

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
  const filesProblem = await campaignFilesProblem(c)
  if (filesProblem) return res.status(400).json({ error: filesProblem })
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
  // Stopping by hand is a finish too — for a campaign that was actually calling. Not
  // for a draft (it talked to nobody), nor one already finished (asked already).
  if (c.status === 'running' || c.status === 'paused') await offerCampaignKnowledge(c)
  res.json({ ok: true })
})
router.post('/:id/duplicate', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { id, created_at, updated_at, ...rest } = c
  const { data, error } = await supabase.from('campaigns')
    .insert({ ...rest, name: `${c.name} (copy)`, status: 'draft' }).select().single()
  if (error) return res.status(500).json({ error: 'Could not duplicate' })
  if (c.config?.kb_source === 'campaign') {
    await copyCampaignDocuments(req.auth.tenantId, c.id, data.id)
      .catch(e => console.error('[CAMPAIGNS] duplicate files:', e.message))
  }
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

router.post('/:id/contacts/import', campaignWriteLimiter, upload.single('file'), uploadErrorHandler, async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!req.file) return res.status(400).json({ error: 'file is required' })
  const check = sniff(req.file, KINDS.contacts)
  if (!check.ok) return res.status(400).json({ error: check.error })
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

// ─── Campaign knowledge (the files an AI campaign talks from) ────────────────
// config.kb_source picks where the agent speaks from: 'existing' = the business's
// knowledge base, 'campaign' = only the files uploaded here. See
// services/campaigns/knowledge.js for why they are kept apart.
router.get('/:id/knowledge', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  try {
    const files = await listCampaignDocuments(c.id)
    // The "add these to your knowledge base?" question, once the campaign is over.
    const offer = c.status === 'completed' ? await pendingKnowledgeOffer(c.id) : []
    res.json({ kb_source: c.config?.kb_source === 'campaign' ? 'campaign' : 'existing', files, pending_offer: offer })
  } catch (e) {
    console.error('[CAMPAIGNS] knowledge list:', e.message)
    res.status(500).json({ error: 'Could not load campaign files' })
  }
})

router.post('/:id/knowledge', ingestLimiter, kbUpload.single('file'), uploadErrorHandler, async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const check = sniff(req.file, KINDS.knowledge)
  if (!check.ok) return res.status(400).json({ error: check.error })
  try {
    const text = await extractTextFromFile(req.file)
    if (!text?.trim()) return res.status(422).json({ error: 'Could not extract any text from this file' })
    const doc = await addCampaignDocument(req.auth.tenantId, c.id, {
      filename: req.file.originalname || 'upload', mimeType: req.file.mimetype, buffer: req.file.buffer, text,
    })
    res.status(201).json({ ...doc, chars: text.length })
  } catch (e) {
    console.error('[CAMPAIGNS] knowledge upload:', e.message)
    res.status(500).json({ error: e.message || 'Could not process file' })
  }
})

router.delete('/:id/knowledge/:docId', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const ok = await deleteCampaignDocument(c.id, req.params.docId)
  if (!ok) return res.status(404).json({ error: 'File not found' })
  res.json({ ok: true })
})

// What the agent says on this campaign's calls: its opening line and where it talks
// from. Merged into config HERE rather than sent whole through PATCH, which replaces
// config outright and would drop what the server keeps in it (event_token, ingest_source).
// Body: { campaign_greeting?: string, kb_source?: 'existing' | 'campaign' }
router.put('/:id/ai-settings', async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  const { campaign_greeting, kb_source } = req.body || {}
  const next = { ...(c.config || {}) }
  if (campaign_greeting !== undefined) {
    if (typeof campaign_greeting !== 'string' || campaign_greeting.length > 500) {
      return res.status(400).json({ error: 'The opening line must be text of at most 500 characters' })
    }
    next.campaign_greeting = campaign_greeting.trim()
  }
  if (kb_source !== undefined) {
    if (!['existing', 'campaign'].includes(kb_source)) return res.status(400).json({ error: "kb_source must be 'existing' or 'campaign'" })
    next.kb_source = kb_source
  }
  // A live campaign switched to files it does not have would dial on, knowing nothing.
  if (['running', 'scheduled'].includes(c.status)) {
    const problem = await campaignFilesProblem({ ...c, config: next })
    if (problem) return res.status(400).json({ error: problem })
  }
  const { data, error } = await supabase.from('campaigns')
    .update({ config: next, updated_at: new Date().toISOString() }).eq('id', c.id).select().single()
  if (error) return res.status(500).json({ error: 'Could not save' })
  res.json(data)
})

// The owner's answer to "add this campaign's files to your knowledge base?".
// Body: { add: true | false }. Adding changes what EVERY call knows, so it also
// needs the knowledge-base permission, not only the campaign one.
router.post('/:id/knowledge/decision', async (req, res, next) => {
  if (req.body?.add === true) return requirePermission('knowledge:write')(req, res, next)
  next()
}, async (req, res) => {
  const c = await ownedCampaign(req.params.id, req.auth.tenantId)
  if (!c) return res.status(404).json({ error: 'Campaign not found' })
  if (typeof req.body?.add !== 'boolean') return res.status(400).json({ error: 'add must be true or false' })
  try {
    res.json(await decideCampaignKnowledge(req.auth.tenantId, c.id, req.body.add))
  } catch (e) {
    console.error('[CAMPAIGNS] knowledge decision:', e.message)
    res.status(500).json({ error: e.message || 'Could not update the knowledge base' })
  }
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
