// api/events.js — REAL-TIME contact ingress (PUBLIC, per-campaign token auth).
//
// This is the "snappy" path: the instant a lead lands in the client's system
// (CRM, website form, Meta/Google Lead Ads, or any webhook), that system POSTs
// it here and we dial within seconds — we hit that because this handler only
// validates + enqueues (the worker dials).
//
//   POST /api/events/:campaignId    header: X-Campaign-Token: <token>   (or ?token=)
//   body: the raw payload from the source. Phone/name are extracted using the
//         campaign's chosen preset (generic | zoho | salesforce | hubspot |
//         meta_lead_ads | google_lead_ads); the whole payload is kept as
//         custom_fields so the AI/template can personalize.
//
// Not behind requireClient — callers are third-party systems, authenticated by
// the per-campaign token (see /api/client/campaigns/:id/trigger).

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { supabase } from './db.js'
import { REDIS_ENABLED } from '../queue/connection.js'
import { enqueueDial, enqueueBroadcast } from '../queue/queues.js'
import { normalizePhone, dedupeKey } from '../services/campaigns/contacts.js'
import { mapIngressPayload } from '../services/campaigns/sources.js'
import { canDial } from '../services/campaigns/compliance.js'
import { originate } from '../services/campaigns/dialer.js'
import { setPending } from '../telephony/campaign-registry.js'

const router = Router()

// ─── INSTANT CALLS (tenant-level, NO campaign) ────────────────────────────────
// The standalone "CRM gets a new entry → we call them within seconds" feature.
// Nothing to create, start or schedule: the tenant's own AI agent (tenant.config,
// same as inbound) dials the lead the moment this webhook fires. Registered BEFORE
// /:campaignId so 'instant' is never treated as a campaign id.
//
//   POST /api/events/instant/:tenantId   header: X-Instant-Token: <token>
//
// Dials inline (one provider HTTP call) — no Redis/worker needed; the pending
// context registry falls back to in-memory within this same API process.

const PUBLIC_BASE = () => process.env.PUBLIC_HOST || process.env.NGROK_URL || ''

// Salesforce Outbound Message wants this exact SOAP reply, or it retries for 24h.
const SOAP_ACK = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound">
      <Ack>true</Ack>
    </notificationsResponse>
  </soapenv:Body>
</soapenv:Envelope>`

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')   // last, so we don't double-decode
}

// Parse a Salesforce Outbound Message SOAP envelope → array of flat record objects.
// Each notified record is an <sObject> block of <sf:Field>value</sf:Field> tags
// (Salesforce batches up to 100 sObjects per message). Namespace-tolerant so it
// works whether fields are prefixed sf:/urn:/none.
export function parseSalesforceOutbound(xml) {
  const out = []
  const blocks = String(xml).match(/<sObject\b[\s\S]*?<\/sObject>/gi) || []
  for (const block of blocks) {
    const fields = {}
    // Match <ns:Field>value</ns:Field> and <Field>value</Field>, self-closing skipped.
    const re = /<(?:\w+:)?(\w+)>([\s\S]*?)<\/(?:\w+:)?\1>/g
    let m
    while ((m = re.exec(block)) !== null) {
      const key = m[1]
      if (key === 'sObject') continue
      fields[key] = decodeXmlEntities(m[2]).trim()
    }
    if (Object.keys(fields).length) out.push(fields)
  }
  return out
}

// Meta Lead Ads webhook verification handshake.
router.get('/instant/:tenantId', (req, res) => {
  const challenge = req.query['hub.challenge']
  if (challenge) return res.send(challenge)
  res.json({ ok: true, instant: true })
})

// Does the CRM payload carry an explicit "don't auto-call this one" flag? Lets staff
// mark an already-handled lead without any config. Matches common field spellings.
function hasDoNotCallFlag(payload) {
  const truthy = (v) => [true, 1].includes(v) || ['true', '1', 'yes', 'y', 'on'].includes(String(v).toLowerCase())
  for (const [k, v] of Object.entries(payload || {})) {
    if (/^(do[_\s-]?not[_\s-]?call|dnc|skip[_\s-]?call|no[_\s-]?call)$/i.test(k) && truthy(v)) return true
  }
  return false
}

// Does the lead's CRM status say it was already worked (Contacted, Qualified, …)?
// Only brand-new leads should get an auto-call. Reads the common status field names
// and skips if the value contains any configured skip-term (case-insensitive, so
// "Working - Contacted" matches "contacted"). Empty list = off.
// "Not Contacted" / "To be contacted" are NEW-lead statuses that happen to contain
// the word "contacted" — they must always call, never skip. These win over any match.
const NEW_LIKE_STATUS = ['not contacted', 'uncontacted', 'not yet contacted', 'to be contacted', 'to contact', 'yet to contact', 'never contacted']
function statusSaysAlreadyWorked(payload, skipStatuses) {
  const terms = (skipStatuses || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  if (!terms.length) return null
  for (const [k, v] of Object.entries(payload || {})) {
    if (!/^(lead[_\s-]?status|status|stage|lifecyclestage|hs[_\s-]?lead[_\s-]?status)$/i.test(k)) continue
    const val = String(v ?? '').trim().toLowerCase()
    if (!val) continue
    if (NEW_LIKE_STATUS.some((n) => val.includes(n))) return null   // explicitly a new lead → call
    if (terms.some((t) => val.includes(t))) return val
  }
  return null
}

// Have we already had a call with this number (inbound OR outbound) within N days?
// If so, the person was already engaged — don't cold-call them again. N=0 disables.
async function contactedWithin(tenantId, phone, days) {
  if (!days || days <= 0) return false
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const { data } = await supabase.from('calls').select('id')
    .eq('tenant_id', tenantId).eq('caller_number', phone).gte('created_at', since).limit(1)
  return !!(data && data.length)
}

// Place one instant AI call for a resolved contact. Shared by the JSON/query path
// and the Salesforce SOAP path. Returns { called, reason?, callId?, providerId? }.
async function placeInstantCall(tenant, settings, { phone, name, payload }) {
  // Skip already-handled leads: only NEW leads should get an auto-call.
  const workedStatus = statusSaysAlreadyWorked(payload, settings.skip_statuses)
  if (workedStatus) { console.log(`[INSTANT] skip status="${workedStatus}" ${phone}`); return { called: false, reason: 'already_contacted', status: workedStatus } }
  if (hasDoNotCallFlag(payload)) { console.log(`[INSTANT] skip do_not_call ${phone}`); return { called: false, reason: 'do_not_call' } }
  if (await contactedWithin(tenant.id, phone, Number(settings.skip_recent_days || 0))) {
    console.log(`[INSTANT] skip recently_contacted ${phone} (within ${settings.skip_recent_days}d)`)
    return { called: false, reason: 'recently_contacted' }
  }

  const gate = await canDial(tenant.id, { phone }, {})   // suppression / DND
  if (!gate.ok) return { called: false, reason: gate.reason }

  const fromNumber = settings.from_number || tenant.phone_number
  const correlationId = randomUUID()
  const { data: call } = await supabase.from('calls').insert({
    tenant_id: tenant.id, caller_number: phone, status: 'active', direction: 'outbound',
  }).select().single()

  await setPending(correlationId, {
    type: 'instant', tenantId: tenant.id, tenantName: tenant.name,
    campaignId: null, contactId: null, runId: null,
    callId: call?.id || null, phone, fromNumber,
    config: {
      ...(tenant.config || {}), tenant_id: tenant.id,
      is_outbound: true,                       // we dialed them → outbound opening line
      contact_name: name || null, contact_fields: payload,
    },
  })

  try {
    const answerUrl = `https://${PUBLIC_BASE()}/answer-campaign?cid=${correlationId}`
    const { providerId } = await originate({ to: phone, from: fromNumber, correlationId, answerUrl })
    return { called: true, callId: call?.id || null, providerId }
  } catch (e) {
    console.error('[INSTANT] originate failed:', e.message)
    if (call?.id) await supabase.from('calls').update({ status: 'failed' }).eq('id', call.id)
    return { called: false, reason: 'originate_failed', error: e.message }
  }
}

router.post('/instant/:tenantId', async (req, res) => {
  // Auth token can arrive as a header, query param, or in the body. Google Lead Form
  // webhooks have no header/query support — they send their "Key" as body.google_key,
  // so we accept that too (the client sets their instant token as the Google Key).
  const token = req.headers['x-instant-token'] || req.query.token
    || (typeof req.body === 'object' ? (req.body?.token || req.body?.google_key) : undefined)
  const { data: tenant } = await supabase.from('tenants')
    .select('id, name, config, phone_number').eq('id', req.params.tenantId).maybeSingle()
  if (!tenant) return res.status(404).json({ error: 'not found' })

  const settings = tenant.config?.instant_call || {}
  if (!settings.token || token !== settings.token) return res.status(401).json({ error: 'invalid token' })
  if (settings.enabled === false) return res.status(403).json({ error: 'instant calls are disabled' })

  // ── Salesforce Outbound Message (SOAP XML) ──────────────────────────────────
  // Salesforce's no-code webhook posts SOAP XML (Content-Type text/xml) and needs
  // an <Ack>true</Ack> SOAP reply or it retries for 24h. Body arrives as a string
  // (express.text). Detect and handle it separately from JSON/form senders.
  const ct = req.headers['content-type'] || ''
  if (typeof req.body === 'string' && /xml/i.test(ct)) {
    const records = parseSalesforceOutbound(req.body)
    console.log(`[INSTANT] salesforce SOAP: ${records.length} record(s)`)
    let called = 0
    for (const rec of records) {
      const mapped = mapIngressPayload('salesforce', rec)
      const phone = normalizePhone(mapped.phone)
      console.log(`[INSTANT] sf record keys=[${Object.keys(rec).join(', ')}] mappedPhone=${mapped.phone || 'none'} → ${phone || 'INVALID'}`)
      if (!phone) continue
      const r = await placeInstantCall(tenant, settings, { phone, name: mapped.name, payload: rec })
      if (r.called) called++
    }
    // Always ACK so Salesforce stops retrying; we've logged any per-record misses.
    return res.type('text/xml').send(SOAP_ACK)
  }

  // ── JSON / form / query senders (Zoho, HubSpot, generic webhooks) ────────────
  // Some CRMs send fields as query params, others as the JSON/form body. Merge both
  // so we find the phone either way; drop the auth token from the payload.
  const { token: _t, ...queryFields } = req.query || {}
  const payload = { ...queryFields, ...(typeof req.body === 'object' ? req.body : {}) }
  const mapped = mapIngressPayload(settings.preset || 'generic', payload)
  const phone = normalizePhone(mapped.phone)
  // Log what actually arrived — the #1 cause of a webhook 400 is the sender putting
  // the phone under a key our preset doesn't read, or the record having no phone.
  console.log(`[INSTANT] ingress preset=${settings.preset || 'generic'} ct=${ct || 'none'} len=${req.headers['content-length'] || '0'} bodyKeys=[${Object.keys(typeof req.body === 'object' ? req.body : {}).join(', ')}] queryKeys=[${Object.keys(req.query || {}).join(', ')}] mappedPhone=${mapped.phone || 'none'} → ${phone || 'INVALID'}`)
  if (!phone) {
    return res.status(400).json({
      error: 'no usable phone in payload',
      hint: 'The chosen preset could not find a phone. Make sure the webhook sends a phone/mobile field the preset reads, and that the record has a phone number.',
      received_keys: Object.keys(payload),
    })
  }

  const r = await placeInstantCall(tenant, settings, { phone, name: mapped.name, payload })
  if (!r.called && r.reason === 'originate_failed') return res.status(502).json({ error: 'could not place the call', detail: r.error })
  if (!r.called) return res.json({ ok: true, called: false, reason: r.reason })
  res.json({ ok: true, called: true, call_id: r.callId, provider_id: r.providerId })
})

// Meta Lead Ads webhook verification handshake (GET with hub.challenge).
router.get('/:campaignId', (req, res) => {
  const challenge = req.query['hub.challenge']
  if (challenge) return res.send(challenge)
  res.json({ ok: true, campaignId: req.params.campaignId })
})

router.post('/:campaignId', async (req, res) => {
  const token = req.headers['x-campaign-token'] || req.query.token || req.body?.token
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', req.params.campaignId).maybeSingle()
  if (!campaign) return res.status(404).json({ error: 'campaign not found' })
  if (!campaign.config?.event_token || token !== campaign.config.event_token) {
    return res.status(401).json({ error: 'invalid campaign token' })
  }

  const payload = req.body || {}
  const preset = campaign.config?.ingest_source || 'generic'
  const mapped = mapIngressPayload(preset, payload)
  const phone = normalizePhone(mapped.phone)

  // Log the event regardless (audit trail).
  const { data: evt } = await supabase.from('campaign_events').insert({
    tenant_id: campaign.tenant_id, campaign_id: campaign.id,
    type: payload.type || payload.event || preset, payload, status: 'received',
  }).select().single()

  if (!phone) {
    await supabase.from('campaign_events').update({ status: 'rejected', detail: { reason: 'no_phone' } }).eq('id', evt?.id)
    return res.status(400).json({ error: 'no usable phone in payload' })
  }
  if (!REDIS_ENABLED) {
    await supabase.from('campaign_events').update({ status: 'error', detail: { reason: 'redis_disabled' } }).eq('id', evt?.id)
    return res.status(503).json({ error: 'queue backend not available' })
  }

  // Upsert the contact (dedupe on campaign+phone) and reset to pending so it dials.
  const { data: contact } = await supabase.from('campaign_contacts').upsert({
    tenant_id: campaign.tenant_id, campaign_id: campaign.id,
    name: mapped.name || null, phone, custom_fields: payload,
    dedupe_key: dedupeKey(phone), status: 'pending',
  }, { onConflict: 'campaign_id,dedupe_key' }).select().single()

  // Compliance gate (suppression / hours / DND) before dialing.
  const gate = await canDial(campaign.tenant_id, contact, campaign)
  if (!gate.ok) {
    await supabase.from('campaign_events').update({ status: 'rejected', detail: { reason: gate.reason } }).eq('id', evt?.id)
    return res.json({ ok: true, triggered: false, reason: gate.reason })
  }

  // Dial now: Template Call → broadcast queue, AI Call → dial queue.
  if (campaign.type === 'broadcast') {
    await enqueueBroadcast({ tenantId: campaign.tenant_id, campaignId: campaign.id, contactId: contact.id, runId: null })
  } else {
    await enqueueDial({ tenantId: campaign.tenant_id, campaignId: campaign.id, contactId: contact.id, runId: null })
  }

  await supabase.from('campaign_events').update({ status: 'triggered', detail: { contact_id: contact.id } }).eq('id', evt?.id)
  res.json({ ok: true, triggered: true, contact_id: contact.id })
})

export default router
