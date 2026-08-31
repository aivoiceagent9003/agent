// api/dsr.js — data-subject requests (DPDP erasure).
//
// scripts/delete-tenant.js handles deleting a CUSTOMER. This handles the other
// person in the system: the CALLER, who never signed up for anything, whose voice
// and number we hold, and who has a statutory right to have it erased.
//
// Erasure crosses tenants on purpose. Someone asking to be forgotten means by the
// platform, not by one business that happens to have called them — asking them to
// file the same request once per tenant would be its own failure.

import { Router } from 'express'
import crypto from 'crypto'
import { supabase } from './db.js'
import { requireAdmin } from './auth.js'
import { normalizePhone } from '../services/dnd.js'
import telemetry from '../services/telemetry.js'

const router = Router()
router.use(requireAdmin())

// The audit row must prove an erasure happened without re-storing the number of
// the person who asked to be forgotten. A salted hash lets us answer "did you
// action mine?" — the requester supplies the number again and we compare.
function hashPhone(phone) {
  const salt = process.env.DSR_HASH_SALT || process.env.WEBHOOK_SECRET || 'vocera'
  return crypto.createHmac('sha256', salt).update(phone).digest('hex')
}

// Same shape the caller would see, so an admin can check before erasing —
// irreversible actions deserve a preview.
async function findFootprint(phone) {
  const [calls, leads, contacts] = await Promise.all([
    supabase.from('calls').select('id, tenant_id, recording_path, created_at').eq('caller_number', phone),
    supabase.from('leads').select('id, tenant_id, created_at').eq('phone', phone),
    supabase.from('contacts').select('id, tenant_id').eq('phone', phone),
  ])
  return {
    calls: calls.data || [],
    leads: leads.data || [],
    contacts: contacts.data || [],
  }
}

// GET /api/admin/dsr/lookup?phone=+9198… — what do we hold on this person?
router.get('/lookup', async (req, res) => {
  const phone = normalizePhone(req.query.phone)
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' })
  try {
    const f = await findFootprint(phone)
    res.json({
      phone,
      calls: f.calls.length,
      recordings: f.calls.filter(c => c.recording_path).length,
      leads: f.leads.length,
      contacts: f.contacts.length,
      tenants: [...new Set([...f.calls, ...f.leads, ...f.contacts].map(r => r.tenant_id))].length,
    })
  } catch (e) {
    console.error('[DSR] lookup failed:', e.message)
    res.status(500).json({ error: 'Could not complete the lookup.' })
  }
})

// POST /api/admin/dsr/erase { phone, note } — erase across every tenant.
router.post('/erase', async (req, res) => {
  const phone = normalizePhone(req.body?.phone)
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' })

  try {
    const f = await findFootprint(phone)
    const result = { calls: 0, recordings: 0, leads: 0, contacts: 0 }

    // Recordings first — see the ordering note in jobs/retention.js: clearing the
    // row first would orphan the audio in the bucket with nothing pointing at it.
    const paths = f.calls.map(c => c.recording_path).filter(Boolean)
    if (paths.length) {
      const { error } = await supabase.storage.from('recordings').remove(paths)
      if (error) console.warn('[DSR] storage delete partial failure:', error.message)
      else result.recordings = paths.length
    }

    if (f.calls.length) {
      const { error } = await supabase.from('calls').update({
        caller_number: 'erased',
        transcript: null,
        recording_path: null,
        anonymized_at: new Date().toISOString(),
      }).in('id', f.calls.map(c => c.id))
      if (error) throw error
      result.calls = f.calls.length
    }

    // Leads and contacts are deleted outright rather than pseudonymised: unlike a
    // call row, they carry no analytics value once the person is removed, and a
    // lead is a record ABOUT the person rather than about an event.
    if (f.leads.length) {
      const { error } = await supabase.from('leads').delete().in('id', f.leads.map(l => l.id))
      if (error) throw error
      result.leads = f.leads.length
    }
    if (f.contacts.length) {
      const { error } = await supabase.from('contacts').delete().in('id', f.contacts.map(c => c.id))
      if (error) throw error
      result.contacts = f.contacts.length
    }

    const { error: aErr } = await supabase.from('erasure_requests').insert({
      phone_hash: hashPhone(phone),
      requested_by: req.auth.userId,
      calls_erased: result.calls,
      leads_erased: result.leads,
      contacts_erased: result.contacts,
      recordings_deleted: result.recordings,
      note: String(req.body?.note || '').slice(0, 500) || null,
    })
    if (aErr) console.error('[DSR] audit row failed:', aErr.message)

    console.log(`[DSR] erased footprint for ${phone}: ${JSON.stringify(result)}`)
    telemetry.recordServiceEvent({
      component: 'compliance', severity: 'info', kind: 'dsr_erasure',
      detail: { ...result, by: req.auth.email },
    })

    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[DSR] erase failed:', e.message)
    res.status(500).json({ error: 'Erasure did not complete. Nothing was partially confirmed — check the logs and retry.' })
  }
})

// GET /api/admin/dsr/verify?phone=… — "did you action my request?"
router.get('/verify', async (req, res) => {
  const phone = normalizePhone(req.query.phone)
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' })
  const { data } = await supabase
    .from('erasure_requests')
    .select('created_at, calls_erased, leads_erased, contacts_erased, recordings_deleted')
    .eq('phone_hash', hashPhone(phone))
    .order('created_at', { ascending: false })
  res.json({ requests: data || [] })
})

export default router
