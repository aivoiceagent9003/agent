// services/campaigns/sources.js — where a campaign's contacts come from.
//
// Four ways to load contacts, all funnelling into the same buildContacts →
// importContacts pipeline so dedupe, phone-validation and custom_fields behave
// identically no matter the origin:
//
//   1. FILE      — CSV / Excel / TXT / PDF / Word uploaded in the dashboard
//                  (parseFileToRows, called by the /contacts/import route).
//   2. GOOGLE    — a shared Google Sheet link, pulled (and optionally polled)
//      SHEET       by the worker (fetchGoogleSheetRows / syncSource).
//   3. DATABASE  — the client's own Postgres/MySQL, queried by the worker
//                  (pullFromDatabase / syncSource). Drivers are lazy-loaded.
//   4. REALTIME  — CRM / webhook / Meta & Google Lead Ads POSTing into
//                  /api/events/:id the instant a lead appears (INGRESS_PRESETS).
//
// Batch sources (2, 3) are pulled in the worker via syncSource(sourceId); the
// realtime source (4) is handled by src/api/events.js using the presets here.

import { supabase } from '../../api/db.js'
import { parseCSV } from '../lookups.js'
import { buildContacts, importContacts, normalizePhone } from './contacts.js'

// ─── File parsing (any format → array of row objects) ────────────────────────
// Returns rows shaped like CSV rows ({ column: value, … }); buildContacts maps
// name/phone columns and keeps the rest as custom_fields. For unstructured files
// (PDF/Word/free text) we can't know columns, so we scrape phone-looking tokens.
export async function parseFileToRows(buffer, filename = '', mimetype = '') {
  const name = String(filename).toLowerCase()
  const mime = String(mimetype).toLowerCase()

  // Excel (.xlsx/.xls) — SheetJS reads the first sheet into row objects.
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel')) {
    const XLSX = (await import('xlsx')).default || (await import('xlsx'))
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return []
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  }

  // PDF — extract text, then scrape phone numbers.
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    return rowsFromText(result?.text || '')
  }

  // Word (.docx) — extract text, then scrape phone numbers.
  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.extractRawText({ buffer })
    return rowsFromText(value || '')
  }

  // CSV / TSV / TXT — structured if it has a header row with a phone column,
  // otherwise fall back to scraping phone tokens from the raw text.
  const text = buffer.toString('utf8')
  if (name.endsWith('.csv') || name.endsWith('.tsv') || mime.includes('csv')) {
    return parseCSV(text)
  }
  // Plain .txt or unknown: try CSV first (it may be comma/newline delimited),
  // but if that yields no phones, scrape the text.
  const csvRows = looksTabular(text) ? parseCSV(text) : []
  if (csvRows.length && csvRows.some(r => Object.values(r).some(v => normalizePhone(v)))) return csvRows
  return rowsFromText(text)
}

function looksTabular(text) {
  const first = String(text).split(/\r?\n/).find(l => l.trim())
  return !!first && (first.includes(',') || first.includes('\t'))
}

// Scrape phone-looking tokens out of free text → one contact per number.
// Grabs +CC and 8–15 digit runs (with spaces/dashes/parens), then validates.
function rowsFromText(text) {
  const matches = String(text).match(/\+?\d[\d\s().-]{7,17}\d/g) || []
  const seen = new Set()
  const rows = []
  for (const m of matches) {
    const phone = normalizePhone(m)
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    rows.push({ phone })
  }
  return rows
}

// ─── Google Sheets (public/link-shared) ──────────────────────────────────────
// Any Google Sheets URL → its CSV export, fetched with plain HTTP (no OAuth).
// The sheet must be shared "anyone with the link can view".
export function sheetCsvUrl(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (!m) return null
  const id = m[1]
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || '0'
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
}

export async function fetchGoogleSheetRows(url) {
  const csvUrl = sheetCsvUrl(url)
  if (!csvUrl) throw new Error('Not a valid Google Sheets link')
  const resp = await fetch(csvUrl, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`Sheet fetch failed (${resp.status}) — is it shared "anyone with the link"?`)
  const text = await resp.text()
  if (text.trim().startsWith('<')) throw new Error('Got an HTML page, not CSV — check the sheet is link-shared for viewing')
  return parseCSV(text)
}

// ─── Direct database (client's own Postgres / MySQL) ─────────────────────────
// Runs a client-supplied SELECT and returns the rows. Drivers (pg / mysql2) are
// lazy-loaded so the app still runs if they aren't installed. Config:
//   { engine: 'postgres'|'mysql', host, port, database, user, password, ssl?, query }
export async function pullFromDatabase(config = {}) {
  const engine = (config.engine || 'postgres').toLowerCase()
  const query = config.query
  if (!query) throw new Error('database source needs a query')

  if (engine === 'postgres' || engine === 'pg') {
    let pg
    try { pg = (await import('pg')).default } catch { throw new Error("Postgres driver not installed — run: npm i pg") }
    const client = new pg.Client({
      host: config.host, port: config.port ? Number(config.port) : 5432,
      database: config.database, user: config.user, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
    })
    await client.connect()
    try { const { rows } = await client.query(query); return rows } finally { await client.end().catch(() => {}) }
  }

  if (engine === 'mysql' || engine === 'mariadb') {
    let mysql
    try { mysql = (await import('mysql2/promise')).default } catch { throw new Error("MySQL driver not installed — run: npm i mysql2") }
    const conn = await mysql.createConnection({
      host: config.host, port: config.port ? Number(config.port) : 3306,
      database: config.database, user: config.user, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 10_000,
    })
    try { const [rows] = await conn.query(query); return rows } finally { await conn.end().catch(() => {}) }
  }

  throw new Error(`Unsupported database engine: ${engine}`)
}

// ─── Sync a batch source (worker entrypoint) ─────────────────────────────────
// Pulls the latest rows from a google_sheet/database source and imports them
// (dedupe makes re-syncs idempotent, so polling only ever adds NEW contacts).
export async function syncSource(sourceId) {
  const { data: src } = await supabase.from('contact_sources').select('*').eq('id', sourceId).maybeSingle()
  if (!src) return { skipped: 'missing' }

  try {
    let rows = []
    if (src.kind === 'google_sheet') rows = await fetchGoogleSheetRows(src.config?.url)
    else if (src.kind === 'database') rows = await pullFromDatabase(src.config || {})
    else return { skipped: `unsupported kind: ${src.kind}` }

    const { contacts, invalidCount, duplicateCount } = buildContacts(rows)
    const { inserted } = await importContacts(src.tenant_id, src.campaign_id, contacts)

    // Report the campaign's ACTUAL contact count, not the newly-inserted delta — a
    // re-sync inserts 0 (already-imported numbers are dedupe-skipped), which would
    // otherwise make the source read "0 rows" even though the contacts are all there.
    const { count: total } = await supabase.from('campaign_contacts')
      .select('*', { count: 'exact', head: true }).eq('campaign_id', src.campaign_id)

    await supabase.from('contact_sources').update({
      status: 'ready', row_count: total ?? ((src.row_count || 0) + inserted),
      last_synced_at: new Date().toISOString(),
      last_result: { parsed: rows.length, inserted, skipped_existing: contacts.length - inserted, invalidCount, duplicateCount, total, at: new Date().toISOString() },
    }).eq('id', sourceId)

    return { inserted, parsed: rows.length, invalidCount, duplicateCount, total }
  } catch (e) {
    console.error('[SOURCE] sync failed:', src.kind, e.message)
    await supabase.from('contact_sources').update({
      status: 'error', last_result: { error: e.message, at: new Date().toISOString() },
    }).eq('id', sourceId)
    return { error: e.message }
  }
}

// ─── Realtime ingress presets (CRM / webhook / lead ads) ─────────────────────
// Each preset knows how to pull a phone + name out of that system's payload
// shape. Everything in the payload is still kept as custom_fields. Used by
// src/api/events.js. Add a client's exact CRM here and it "just works".
export const INGRESS_PRESETS = {
  // Plain webhook: { phone|mobile|number, name, ... } at the top level.
  generic: (p) => ({
    phone: p.phone ?? p.mobile ?? p.number ?? p.phone_number ?? p.contact_number,
    name: p.name ?? p.full_name ?? p.customer ?? null,
  }),

  // Zoho CRM webhook (Leads/Contacts module).
  zoho: (p) => ({
    phone: p.Phone ?? p.Mobile ?? p.phone ?? p.mobile,
    name: p.Full_Name ?? p.Last_Name ?? [p.First_Name, p.Last_Name].filter(Boolean).join(' ') ?? null,
  }),

  // Salesforce (Lead/Contact) outbound message or flow.
  salesforce: (p) => ({
    phone: p.MobilePhone ?? p.Phone ?? p.mobilephone ?? p.phone,
    name: p.Name ?? [p.FirstName, p.LastName].filter(Boolean).join(' ') ?? null,
  }),

  // HubSpot workflow webhook (properties.* shape).
  hubspot: (p) => {
    const pr = p.properties || p
    return {
      phone: pr.mobilephone ?? pr.phone ?? p.phone,
      name: pr.firstname || pr.lastname ? [pr.firstname, pr.lastname].filter(Boolean).join(' ') : (pr.name ?? null),
    }
  },

  // Meta (Facebook/Instagram) Lead Ads — field_data: [{name, values:[...]}].
  meta_lead_ads: (p) => {
    const fields = {}
    for (const f of p.field_data || p.entry?.[0]?.changes?.[0]?.value?.field_data || []) {
      fields[f.name] = Array.isArray(f.values) ? f.values[0] : f.values
    }
    return {
      phone: fields.phone_number ?? fields.phone ?? p.phone,
      name: fields.full_name ?? fields.name ?? [fields.first_name, fields.last_name].filter(Boolean).join(' ') ?? null,
      extra: fields,
    }
  },

  // Google Lead Form Ads — user_column_data: [{column_id, string_value}].
  google_lead_ads: (p) => {
    const cols = {}
    for (const c of p.user_column_data || []) cols[String(c.column_id).toUpperCase()] = c.string_value
    return {
      phone: cols.PHONE_NUMBER ?? cols.PHONE ?? p.phone,
      name: cols.FULL_NAME ?? cols.NAME ?? [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' ') ?? null,
      extra: cols,
    }
  },
}

// Last-resort, case-insensitive scan of any payload for a phone / name. Makes the
// ingress forgiving: even if the client picked the wrong preset or their CRM uses
// different casing/field names (Phone vs phone vs Mobile_Number), we still find it.
// Looks one level into nested objects (e.g. Zoho/HubSpot `{ properties: {...} }`).
function scanFields(payload, depth = 0) {
  let phone, name
  for (const [k, v] of Object.entries(payload || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) {
      const inner = scanFields(v, depth + 1)
      phone ||= inner.phone; name ||= inner.name
      continue
    }
    if (v == null || v === '') continue
    const val = String(v).trim()
    if (!val) continue
    if (!phone && /(phone|mobile|cell|whatsapp|msisdn|contact_?number|^number$)/i.test(k)) phone = val
    if (!name && /(full_?name|^name$|first_?name|last_?name|customer|contact_?name)/i.test(k)) name = val
  }
  return { phone, name }
}

// Resolve { phone, name } from a payload using the campaign's chosen preset, then
// fall back to the generic mapping, then to a case-insensitive scan of everything.
export function mapIngressPayload(preset, payload) {
  const fn = INGRESS_PRESETS[preset] || INGRESS_PRESETS.generic
  let out = {}
  try { out = fn(payload) || {} } catch { out = {} }
  if (!out.phone) out.phone = INGRESS_PRESETS.generic(payload).phone
  if (!out.name) out.name = INGRESS_PRESETS.generic(payload).name
  if (!out.phone || !out.name) {
    const scanned = scanFields(payload)
    if (!out.phone) out.phone = scanned.phone
    if (!out.name) out.name = scanned.name
  }
  return out
}
