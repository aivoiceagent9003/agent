// api/whatsapp.js — per-tenant WhatsApp display settings (client-scoped, requireClient).
//
// Messages send from the PLATFORM's WhatsApp number (see src/services/whatsapp.js),
// so a client sets NO API credentials — only what shows in the message: their contact
// number to display, and which brochure to send. `platform_enabled` tells the UI the
// shared sender is live. (An enterprise client can still paste their own number under
// the advanced fields.)

import { Router } from 'express'
import multer from 'multer'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { guardRouter } from './permissions.js'
import { platformCfg } from '../services/whatsapp.js'
import { listSendables, createSendable, updateSendable, deleteSendable } from '../services/sendables.js'

const router = Router()
router.use(requireClient())
router.use(guardRouter({ read: 'whatsapp:read', write: 'whatsapp:write' }))

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

async function loadTenant(tenantId) {
  const { data } = await supabase.from('tenants').select('id, config').eq('id', tenantId).single()
  return data || null
}

function present(wa = {}) {
  const p = platformCfg()
  const platformReady = !!(p.phone_number_id && p.token && p.templates.document)
  const ownNumber = !!(wa.phone_number_id && wa.token)
  return {
    platform_enabled: platformReady,          // shared sender is configured on the server
    enabled: wa.enabled !== false,            // this tenant wants WhatsApp on
    display_phone: wa.display_phone || '',     // their contact number, shown in the message
    // Sendable files are NOT here — they're rows in whatsapp_documents, served by
    // /documents below (own store, never ingested into the knowledge base).
    // advanced (enterprise bring-your-own-number) — token never returned
    own_number: ownNumber,
    provider: wa.provider || 'meta',
    phone_number: wa.phone_number || '',
    phone_number_id: wa.phone_number_id || '',
    token_set: !!wa.token,
    templates: { document: wa.templates?.document || '', confirmation: wa.templates?.confirmation || '' },
  }
}

router.get('/', async (req, res) => {
  const tenant = await loadTenant(req.auth.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  res.json(present(tenant.config?.whatsapp || {}))
})

router.put('/', async (req, res) => {
  const tenant = await loadTenant(req.auth.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const wa = { ...(tenant.config?.whatsapp || {}) }
  const b = req.body || {}

  // Client-facing fields
  if (b.enabled !== undefined) wa.enabled = !!b.enabled
  if (b.display_phone !== undefined) wa.display_phone = String(b.display_phone).trim()
  // Legacy: documents used to be knowledge-base doc ids stored in config. They now
  // live in whatsapp_documents, so drop the stale lists on any save.
  delete wa.documents
  delete wa.brochures
  delete wa.brochure_doc_id

  // Advanced: enterprise bring-your-own-number (optional)
  if (b.provider !== undefined) wa.provider = ['meta', '360dialog'].includes(b.provider) ? b.provider : 'meta'
  if (b.phone_number !== undefined) wa.phone_number = String(b.phone_number).trim()
  if (b.phone_number_id !== undefined) wa.phone_number_id = String(b.phone_number_id).trim()
  if (b.templates !== undefined) wa.templates = { document: String(b.templates?.document || '').trim(), confirmation: String(b.templates?.confirmation || '').trim() }
  if (b.token) wa.token = String(b.token).trim()

  const config = { ...(tenant.config || {}), whatsapp: wa }
  const { error } = await supabase.from('tenants').update({ config }).eq('id', tenant.id)
  if (error) return res.status(500).json({ error: 'Could not save WhatsApp settings' })
  res.json(present(wa))
})

// ─── Sendable documents (own store — never ingested into the knowledge base) ──

router.get('/documents', async (req, res) => {
  try {
    res.json(await listSendables(req.auth.tenantId))
  } catch (e) {
    console.error('[WHATSAPP] list documents error:', e.message)
    res.status(500).json({ error: 'Could not load documents' })
  }
})

// Upload one file. Field name "file", plus a `topic` field (what callers ask for).
// No text extraction — an image-only brochure PDF is perfectly valid here.
router.post('/documents', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const doc = await createSendable(req.auth.tenantId, {
      topic: req.body?.topic,
      filename: req.file.originalname || 'document.pdf',
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
    })
    res.json(doc)
  } catch (e) {
    console.error('[WHATSAPP] upload document error:', e.message)
    res.status(500).json({ error: e.message || 'Could not save document' })
  }
})

router.put('/documents/:id', async (req, res) => {
  try {
    res.json(await updateSendable(req.auth.tenantId, req.params.id, { topic: req.body?.topic }))
  } catch (e) {
    console.error('[WHATSAPP] update document error:', e.message)
    res.status(500).json({ error: 'Could not update document' })
  }
})

router.delete('/documents/:id', async (req, res) => {
  try {
    res.json(await deleteSendable(req.auth.tenantId, req.params.id))
  } catch (e) {
    console.error('[WHATSAPP] delete document error:', e.message)
    res.status(500).json({ error: 'Could not delete document' })
  }
})

export default router
