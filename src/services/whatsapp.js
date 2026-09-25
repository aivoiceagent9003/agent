// services/whatsapp.js — WhatsApp Business messaging (brochures / booking details).
//
// MODEL: messages send from the PLATFORM's own WhatsApp number (one WABA, set via
// env) so clients need ZERO technical setup. Each client's identity travels in the
// message CONTENT — business name + contact number are filled into approved template
// variables — so the customer sees who it's really from. (The sender header shows the
// platform's verified name; that's the trade-off for a shared number.)
//
// A client CAN still bring their own number: if tenant.config.whatsapp has its own
// phone_number_id + token, that overrides the platform number for them. Otherwise
// everyone rides the platform credentials.
//
// Template variable convention — GENERIC, works for any industry (create on the WABA):
//   document     : {{1}} customer, {{2}} what it is ("brochure for X" / "menu" / "price list"),
//                  {{3}} business name, {{4}} contact phone  + a DOCUMENT header (the file)
//   confirmation : {{1}} customer, {{2}} what's confirmed ("site visit to X" / "appointment" /
//                  "table for 4"), {{3}} date, {{4}} time, {{5}} contact phone
// The industry-specific wording lives in variable {{2}} (supplied by the agent), never in
// the fixed template text — so ONE template set serves every business.
//
// Env (platform credentials):
//   WHATSAPP_PROVIDER=meta|360dialog   WHATSAPP_PHONE_NUMBER_ID   WHATSAPP_TOKEN
//   WHATSAPP_API_BASE (optional)   WHATSAPP_DEFAULT_LANG (default 'en')
//   WHATSAPP_TEMPLATE_BROCHURE   WHATSAPP_TEMPLATE_BOOKING

import { getSendableUrl } from './sendables.js'
import { supabase } from '../api/db.js'

// The platform-wide WhatsApp sender (env). Used for every tenant unless they bring
// their own number.
export function platformCfg() {
  return {
    provider: process.env.WHATSAPP_PROVIDER || 'meta',
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    token: process.env.WHATSAPP_TOKEN || '',
    api_base: process.env.WHATSAPP_API_BASE || '',
    default_language: process.env.WHATSAPP_DEFAULT_LANG || 'en',
    templates: {
      // Generic, industry-neutral templates. (Legacy BROCHURE/BOOKING names still read.)
      document: process.env.WHATSAPP_TEMPLATE_DOCUMENT || process.env.WHATSAPP_TEMPLATE_BROCHURE || '',
      confirmation: process.env.WHATSAPP_TEMPLATE_CONFIRMATION || process.env.WHATSAPP_TEMPLATE_BOOKING || '',
    },
    // Which value fills {{1}},{{2}},… for each template. Configurable so ANY approved
    // template layout works without a code change. Tokens: customer | about | topic |
    // business | phone | date | time.
    params: {
      document: parseParams(process.env.WHATSAPP_DOCUMENT_PARAMS, ['customer', 'about', 'business', 'phone']),
      confirmation: parseParams(process.env.WHATSAPP_CONFIRMATION_PARAMS, ['customer', 'about', 'date', 'time', 'phone']),
    },
  }
}

function parseParams(raw, fallback) {
  const list = String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.length ? list : fallback
}

// Map the configured token list onto the actual values for this send.
// WhatsApp REJECTS empty text parameters (#131008), so every slot must be non-empty —
// fall back to a dash rather than failing the whole message.
function buildParams(tokens, values) {
  return (tokens || []).map((t) => {
    const v = values[t]
    const s = v == null ? '' : String(v).trim()
    return s || '-'
  })
}

// Per-tenant WhatsApp block (accepts a tenant row or an already-merged tenantConfig).
export function tenantWa(source) {
  return source?.config?.whatsapp || source?.whatsapp || {}
}

// Which credentials actually send for this tenant: their own number if fully set,
// else the shared platform number.
export function resolveCfg(source) {
  const wa = tenantWa(source)
  if (wa.phone_number_id && wa.token) {
    return {
      provider: wa.provider || 'meta', phone_number_id: wa.phone_number_id, token: wa.token,
      api_base: wa.api_base || '', default_language: wa.default_language || 'en',
      templates: {
        document: wa.templates?.document || wa.templates?.brochure || '',
        confirmation: wa.templates?.confirmation || wa.templates?.booking || '',
      },
      params: platformCfg().params,   // variable mapping is a template-layout concern
    }
  }
  return platformCfg()
}

// Can we send for this tenant at all? True once a platform (or tenant) number exists
// and the tenant hasn't turned WhatsApp off.
export function whatsappReady(source) {
  if (tenantWa(source).enabled === false) return false
  const cfg = resolveCfg(source)
  return !!(cfg.phone_number_id && cfg.token)
}

function endpoint(cfg) {
  if (cfg.provider === '360dialog') return `${(cfg.api_base || 'https://waba-v2.360dialog.io').replace(/\/$/, '')}/messages`
  const base = (cfg.api_base || 'https://graph.facebook.com/v21.0').replace(/\/$/, '')
  return `${base}/${cfg.phone_number_id}/messages`
}
function authHeaders(cfg) {
  return cfg.provider === '360dialog'
    ? { 'D360-API-KEY': cfg.token, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }
}
// WhatsApp requires the recipient in international format — country code + national
// number, digits only, NO leading '+'. Plivo can deliver the caller as a bare 10-digit
// national number (e.g. '9003503664'); sent as-is the Cloud API ACCEPTS the request
// (returns a message id) but silently never delivers. Add the country code for bare
// national numbers so the brochure/confirmation actually reaches the caller.
function normalizeWa(to) {
  let d = String(to || '').replace(/[^\d]/g, '')
  if (!d) return ''
  const cc = String(process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91'
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)   // drop national trunk '0'
  if (d.length === 10) d = cc + d                             // bare 10-digit → prepend country code
  return d
}

async function post(cfg, to, message) {
  if (!cfg.phone_number_id || !cfg.token) throw new Error('WhatsApp is not configured')
  const recipient = normalizeWa(to)
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...message }
  const res = await fetch(endpoint(cfg), { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${text.slice(0, 300)}`)
  let json = {}
  try { json = JSON.parse(text) } catch { /* tolerate */ }
  // A 200 + wamid means WhatsApp ACCEPTED the request — NOT that it was delivered.
  // Log the actual recipient we sent to + the resolved wa_id so a silent non-delivery
  // (wrong number format, or a test/sandbox sender that only delivers to allow-listed
  // recipients) is visible here instead of masquerading as success.
  const wamid = json.messages?.[0]?.id || null
  const waId = json.contacts?.[0]?.wa_id || null
  const status = json.messages?.[0]?.message_status || null   // 'accepted' | 'held_for_quality_assessment' | …
  console.log(`[WHATSAPP] → sender=${cfg.phone_number_id} to=${recipient} http=${res.status} wamid=${wamid || 'none'} wa_id=${waId || 'none'}${status ? ` status=${status}` : ''}`)
  return { id: wamid, raw: json }
}

// Which document to send for what the caller asked about now lives in
// services/sendables.js (resolveSendable) — sendable files are their own store,
// deliberately not the knowledge base.

// Business-initiated messages MUST use an approved template. bodyParams fill
// {{1}},{{2}},{{3}}…; headerDocumentUrl attaches a PDF (brochure).
export async function sendTemplate(cfg, { to, template, language, bodyParams = [], headerDocumentUrl, headerDocumentFilename }) {
  if (!template) throw new Error('No WhatsApp template configured')
  const components = []
  if (headerDocumentUrl) components.push({ type: 'header', parameters: [{ type: 'document', document: { link: headerDocumentUrl, filename: headerDocumentFilename || 'document.pdf' } }] })
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t ?? '') })) })
  console.log(`[WHATSAPP] template="${template}" lang=${language || cfg.default_language || 'en'} params=[${bodyParams.map((p) => JSON.stringify(p)).join(', ')}]${headerDocumentUrl ? ' +doc' : ''}`)
  return post(cfg, to, {
    type: 'template',
    template: { name: template, language: { code: language || cfg.default_language || 'en' }, ...(components.length ? { components } : {}) },
  })
}

// ─── High-level: the agent's two intents (industry-neutral) ──────────────────
// `who` = { businessName, businessPhone, customerName }. `about` = what the item is,
// in the caller's words ("brochure for My Home Apas", "lunch menu", "price list") —
// it fills {{2}} so the message reads naturally for ANY business.
//
// Document template vars: {{1}} customer, {{2}} about, {{3}} business name, {{4}} contact
export async function sendDocument({ tenantId, cfg, to, docId, who = {}, about, topic, filename = 'document.pdf' }) {
  if (!docId) throw new Error('No document configured to send')
  const url = await getSendableUrl(tenantId, docId, 600)   // 10-min signed link; WhatsApp fetches it
  if (!url) throw new Error('Document not found')
  const values = {
    customer: who.customerName || 'there', about: about || 'the document', topic: topic || about || '',
    business: who.businessName || 'our team', phone: who.businessPhone || '',
  }
  return sendTemplate(cfg, {
    to, template: cfg.templates?.document,
    bodyParams: buildParams(cfg.params?.document, values),
    headerDocumentUrl: url, headerDocumentFilename: filename,
  })
}

// Confirmation template vars: driven by cfg.params.confirmation (default:
// {{1}} customer, {{2}} about, {{3}} date, {{4}} time, {{5}} contact)
export async function sendConfirmation({ cfg, to, who = {}, about, topic, date, time }) {
  const values = {
    customer: who.customerName || 'there', about: about || 'your appointment', topic: topic || about || '',
    business: who.businessName || 'our team', phone: who.businessPhone || '',
    date: date || 'to be confirmed', time: time || 'to be confirmed',
  }
  return sendTemplate(cfg, {
    to, template: cfg.templates?.confirmation,
    bodyParams: buildParams(cfg.params?.confirmation, values),
  })
}

// Best-effort audit log (no-ops if the table isn't present). See sql/whatsapp.sql.
export async function logWhatsApp(tenantId, { to, kind, messageId, status, error }) {
  try {
    await supabase.from('whatsapp_messages').insert({
      tenant_id: tenantId, to_number: normalizeWa(to), kind, message_id: messageId || null,
      status: status || (error ? 'failed' : 'sent'), error: error || null,
    })
  } catch { /* table optional */ }
}
