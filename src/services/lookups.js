// lookups.js — Dynamic, per-caller data lookups (orders, dues, bookings…).
//
// This is the COUNTERPART to RAG: RAG (rag.js) answers from STATIC knowledge that
// is the same for every caller; lookups fetch LIVE, caller-specific data the LLM
// asks for via tool calls. Order status, outstanding dues, a booking — none of
// that belongs in the knowledge base, it changes per caller and per minute.
//
// Each tenant configures one or more "lookups" in tenant.config.lookups. At call
// time we expose them to the LLM as tools (buildLookupTools). When the LLM calls
// one, runLookup resolves it against the configured backend:
//   - http  → call the client's own REST API (for clients that have one)
//   - table → query a data sheet the client uploaded (lookup_rows) — the no-API path
//
// Shape of one lookup in tenant.config.lookups:
//   {
//     name: 'lookup_order',
//     description: "Look up an order by its ID or the caller's phone number",
//     parameters: [
//       { name: 'order_id', description: 'The order ID', required: false },
//       { name: 'phone',    description: "The caller's phone number", required: false },
//     ],
//     backend: { type: 'http', url: 'https://shop.com/api/orders/{order_id}',
//                method: 'GET', headers: { Authorization: 'Bearer xxx' } }
//     // — OR —
//     backend: { type: 'table', dataset: 'orders' }
//   }

import { supabase } from '../api/db.js'

// Hard cap so a slow/broken client API can never freeze the live phone call.
const LOOKUP_TIMEOUT_MS = 3500

// Tool/function names must match ^[a-zA-Z0-9_-]+$ for the OpenAI API. We also use
// the sanitized form as the stable identifier when matching a tool call back to
// its config, so build it the same way everywhere.
export function sanitizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool specs — turn a tenant's configured lookups into OpenAI tool definitions.
// Returns [] when lookups are disabled or none are configured (so the LLM call
// stays exactly as it is today for tenants that don't use this feature).
// ─────────────────────────────────────────────────────────────────────────────
export function buildLookupTools(tenantConfig = {}) {
  if (tenantConfig.enable_lookups === false) return []
  const lookups = Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : []

  const tools = []
  for (const lk of lookups) {
    if (!lk?.name) continue
    const properties = {}
    const required = []
    for (const p of lk.parameters || []) {
      if (!p?.name) continue
      properties[p.name] = { type: 'string', description: p.description || '' }
      if (p.required) required.push(p.name)
    }
    tools.push({
      type: 'function',
      function: {
        name: sanitizeName(lk.name),
        description: lk.description || `Look up ${lk.name}`,
        parameters: { type: 'object', properties, required },
      },
    })
  }
  return tools
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a tool call by name with the given args. Returns a short string the LLM
// can read back to the caller. NEVER throws — a failed lookup returns a friendly
// fallback so the call keeps going.
// ─────────────────────────────────────────────────────────────────────────────
export async function runLookup(tenantConfig, name, args = {}) {
  const lookups = Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : []
  const lk = lookups.find(l => sanitizeName(l.name) === name)
  if (!lk) return `No lookup named ${name} is configured.`

  const t0 = Date.now()
  try {
    const result = await withTimeout(resolveBackend(tenantConfig, lk, args), LOOKUP_TIMEOUT_MS)
    console.log(`[LOOKUP] "${name}" ${JSON.stringify(args)} → ${result ? 'hit' : 'miss'} (${Date.now() - t0}ms)`)
    if (result === null || result === undefined || result === '') {
      return 'No matching record was found.'
    }
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (e) {
    console.error(`[LOOKUP] "${name}" failed:`, e.message)
    return 'That information could not be retrieved right now.'
  }
}

function resolveBackend(tenantConfig, lk, args) {
  const backend = lk.backend || {}
  if (backend.type === 'http') return resolveHttp(backend, args)
  if (backend.type === 'table') return resolveTable(tenantConfig.tenant_id, backend.dataset, args)
  return Promise.resolve(null)
}

// ─── http backend — call the client's own REST API ──────────────────────────
// {order_id} placeholders in the URL are filled from args; any leftover args go
// into the query string (GET) or JSON body (POST/PUT/…).
async function resolveHttp(backend, args) {
  const method = (backend.method || 'GET').toUpperCase()
  const used = new Set()
  let url = (backend.url || '').replace(/\{(\w+)\}/g, (_, k) => {
    used.add(k)
    return encodeURIComponent(args[k] ?? '')
  })

  const remaining = Object.entries(args).filter(
    ([k, v]) => !used.has(k) && v != null && String(v) !== ''
  )

  const init = { method, headers: { ...(backend.headers || {}) } }
  if (method === 'GET' || method === 'HEAD') {
    if (remaining.length) {
      const qs = new URLSearchParams(remaining.map(([k, v]) => [k, String(v)])).toString()
      url += (url.includes('?') ? '&' : '?') + qs
    }
  } else {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json'
    init.body = JSON.stringify(Object.fromEntries(remaining))
  }

  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  try { return JSON.parse(text) } catch { return text.slice(0, 800) }
}

// ─── table backend — query an uploaded data sheet (the no-API path) ─────────
// Narrow with an ILIKE on search_text using the most specific arg value, then
// prefer an exact field match on any provided value.
async function resolveTable(tenantId, dataset, args) {
  if (!tenantId || !dataset) return null

  const values = Object.values(args)
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
  if (!values.length) return null

  // Compare ignoring case, spaces, and separators so "ORD 1002", "ORD1002" and
  // "ord-1002" are all treated as equal — regardless of how the caller said it or
  // how the sheet stored it.
  const norm = s => String(s).trim().toLowerCase().replace(/[\s\-_/]+/g, '')
  const wanted = values.map(norm).filter(Boolean)

  const query = async (probe, limit) =>
    supabase
      .from('lookup_rows')
      .select('row')
      .eq('tenant_id', tenantId)
      .eq('dataset', dataset)
      .ilike('search_text', `%${probe}%`)
      .limit(limit)

  const findExact = rows =>
    (rows || []).find(r => Object.values(r.row || {}).some(val => wanted.includes(norm(val))))

  // ── Phase 1: full-value probes (raw + space-stripped) ──────────────────────
  // Specific enough that a fuzzy first-row fallback is acceptable (e.g. a partial
  // name match). Handles "ORD 1002" (query) vs "ORD1002" (stored).
  const mainProbes = new Set()
  for (const v of values) {
    mainProbes.add(v.toLowerCase())
    mainProbes.add(v.replace(/\s+/g, '').toLowerCase())
  }
  for (const probe of [...mainProbes].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const { data, error } = await query(probe, 5)
    if (error) throw new Error(error.message)
    if (data && data.length) {
      console.log(`[LOOKUP] table probe "${probe}" matched ${data.length}`)
      return (findExact(data) || data[0]).row
    }
  }

  // ── Phase 2: token probes (alpha/digit runs) ───────────────────────────────
  // Bridges spacing mismatches the other way — "ORD1002" (query) vs "ORD 1002"
  // (stored): the digit run "1002" is contiguous either way. Only accept an EXACT
  // normalized match here so a loose token never returns the wrong row.
  const tokens = new Set()
  for (const v of values) for (const t of (v.match(/[a-zA-Z]+|[0-9]+/g) || [])) {
    if (t.length >= 2) tokens.add(t.toLowerCase())
  }
  for (const probe of [...tokens].sort((a, b) => b.length - a.length)) {
    const { data, error } = await query(probe, 20)
    if (error) throw new Error(error.message)
    const exact = findExact(data)
    if (exact) {
      console.log(`[LOOKUP] table token "${probe}" → exact match`)
      return exact.row
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset ingestion — store an uploaded data sheet for the `table` backend.
// Each row is kept as jsonb plus a flattened `search_text` for fast ILIKE.
// ─────────────────────────────────────────────────────────────────────────────
export async function ingestDataset(tenantId, dataset, rows, { replace = true } = {}) {
  if (!tenantId || !dataset || !Array.isArray(rows) || !rows.length) {
    return { rows_added: 0 }
  }

  if (replace) {
    await supabase.from('lookup_rows').delete().eq('tenant_id', tenantId).eq('dataset', dataset)
  }

  const records = rows.map(row => ({
    tenant_id: tenantId,
    dataset,
    row,
    search_text: Object.values(row).map(v => String(v ?? '')).join(' ').toLowerCase(),
  }))

  let added = 0
  let firstError = null
  for (let i = 0; i < records.length; i += 500) {
    const slice = records.slice(i, i + 500)
    const { error } = await supabase.from('lookup_rows').insert(slice)
    if (error) {
      firstError = firstError || error.message
      console.error('[LOOKUP] dataset insert error:', error.message)
    } else {
      added += slice.length
    }
  }
  // If nothing was stored, surface the DB error instead of a silent 0 — the usual
  // cause is the lookup_rows table not existing yet (run sql/lookups.sql).
  if (added === 0 && firstError) throw new Error(firstError)
  return { rows_added: added }
}

// List a tenant's datasets with row counts (for the builder UI).
export async function listDatasets(tenantId) {
  if (!tenantId) return []
  const { data, error } = await supabase
    .from('lookup_rows')
    .select('dataset')
    .eq('tenant_id', tenantId)
  if (error) { console.error('[LOOKUP] listDatasets error:', error.message); return [] }
  const counts = new Map()
  for (const r of data || []) counts.set(r.dataset, (counts.get(r.dataset) || 0) + 1)
  return [...counts.entries()].map(([dataset, rows]) => ({ dataset, rows }))
}

export async function deleteDataset(tenantId, dataset) {
  if (!tenantId || !dataset) return
  await supabase.from('lookup_rows').delete().eq('tenant_id', tenantId).eq('dataset', dataset)
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal CSV parser — header row + data rows, handles quoted fields, escaped
// quotes ("") and commas/newlines inside quotes. Returns an array of objects
// keyed by the header names.
// ─────────────────────────────────────────────────────────────────────────────
export function parseCSV(text) {
  // Strip a UTF-8 BOM (Excel adds one) so it doesn't corrupt the first header.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  const rows = []
  let field = ''
  let record = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      record.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      // End of record. Handle all line endings: \n, \r, and \r\n (as one).
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field); rows.push(record); field = ''; record = []
    } else {
      field += c
    }
  }
  if (field.length || record.length) { record.push(field); rows.push(record) }
  if (!rows.length) return []

  const headers = rows[0].map(h => h.trim()).filter(Boolean)
  if (!headers.length) return []

  return rows
    .slice(1)
    .filter(r => r.some(v => (v ?? '').trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])))
}

// Helper: reject a promise that runs past `ms` so a slow lookup can't hang a call.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('lookup timeout')), ms)),
  ])
}
