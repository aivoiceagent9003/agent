// services/campaigns/contacts.js — contact import, phone validation, dedupe.
//
// Reuses parseCSV from src/services/lookups.js (already handles quoted fields, BOM,
// mixed line endings). Normalizes phones to E.164, derives a dedupe_key, and bulk
// inserts into campaign_contacts (the unique index on (campaign_id, dedupe_key)
// makes re-imports idempotent).

import { supabase } from '../../api/db.js'
import { parseCSV } from '../lookups.js'

const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '91'   // India by default

// Normalize a raw phone string to E.164 (+<cc><number>), or null if implausible.
export function normalizePhone(raw, countryCode = DEFAULT_CC) {
  if (!raw) return null
  let s = String(raw).trim()
  const hasPlus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  let e164
  if (hasPlus) e164 = '+' + digits
  else if (digits.length === 10) e164 = `+${countryCode}${digits}`               // bare local number
  else if (digits.startsWith(countryCode) && digits.length > 10) e164 = '+' + digits
  else if (digits.length > 10) e164 = '+' + digits
  else return null                                                                // too short
  // E.164 allows up to 15 digits total.
  const nd = e164.slice(1)
  if (nd.length < 8 || nd.length > 15) return null
  return e164
}

export const dedupeKey = (phone) => (phone || '').replace(/\D/g, '')

// Map arbitrary column names to our fields (name/phone), keep the rest as custom_fields.
const NAME_KEYS = ['name', 'full_name', 'fullname', 'contact', 'customer', 'first_name']
const PHONE_KEYS = ['phone', 'mobile', 'number', 'phone_number', 'contact_number', 'msisdn', 'cell']

function mapRow(row) {
  const lower = {}
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v
  const nameKey = NAME_KEYS.find(k => lower[k])
  const phoneKey = PHONE_KEYS.find(k => lower[k])
  const name = nameKey ? String(lower[nameKey]).trim() : null
  const rawPhone = phoneKey ? lower[phoneKey] : Object.values(lower)[0]
  const custom = { ...row }
  if (nameKey) delete custom[Object.keys(row).find(k => k.toLowerCase().trim() === nameKey)]
  if (phoneKey) delete custom[Object.keys(row).find(k => k.toLowerCase().trim() === phoneKey)]
  return { name, rawPhone, custom }
}

// Parse rows (from CSV text or a pasted list) into normalized contact records.
export function buildContacts(rows) {
  const out = []
  const invalid = []
  for (const row of rows) {
    const { name, rawPhone, custom } = mapRow(row)
    const phone = normalizePhone(rawPhone)
    if (!phone) { invalid.push(rawPhone); continue }
    out.push({ name, phone, custom_fields: custom, dedupe_key: dedupeKey(phone) })
  }
  // In-batch dedupe.
  const seen = new Set()
  const deduped = out.filter(c => (seen.has(c.dedupe_key) ? false : seen.add(c.dedupe_key)))
  return { contacts: deduped, invalidCount: invalid.length, duplicateCount: out.length - deduped.length }
}

// Parse a pasted list: one phone (optionally "phone,name") per line.
export function parsePastedList(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [phone, ...rest] = line.split(/[,\t]/)
    return { phone, name: rest.join(' ').trim() || null }
  })
}

// Insert contacts for a campaign. Uses upsert on the dedupe index so re-imports and
// overlapping lists never create duplicates. Returns counts.
export async function importContacts(tenantId, campaignId, contacts) {
  if (!contacts.length) return { inserted: 0 }
  const rows = contacts.map(c => ({
    tenant_id: tenantId, campaign_id: campaignId,
    name: c.name || null, phone: c.phone,
    custom_fields: c.custom_fields || {}, dedupe_key: c.dedupe_key || dedupeKey(c.phone),
    status: 'pending',
  }))
  let inserted = 0
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500)
    const { error, count } = await supabase
      .from('campaign_contacts')
      .upsert(slice, { onConflict: 'campaign_id,dedupe_key', ignoreDuplicates: true, count: 'exact' })
    if (error) { console.error('[CONTACTS] import error:', error.message); throw new Error(error.message) }
    inserted += count ?? slice.length
  }
  return { inserted }
}

// Import from CSV text.
export async function importFromCSV(tenantId, campaignId, csvText) {
  const rows = parseCSV(csvText)
  const { contacts, invalidCount, duplicateCount } = buildContacts(rows)
  const { inserted } = await importContacts(tenantId, campaignId, contacts)
  return { inserted, invalidCount, duplicateCount, parsed: rows.length }
}
