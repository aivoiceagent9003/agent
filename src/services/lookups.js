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
import telemetry from './telemetry.js'

// Hard cap so a slow/broken client API can never freeze the live phone call.
const LOOKUP_TIMEOUT_MS = 3500

// A miss returns an INSTRUCTION, not a status. A bare "No matching record was
// found." gets paraphrased straight to the caller — on a real call the agent said
// "Mee EMI details kosam look up chestunnanu, but matching record dorakaledu",
// narrating the tool and leaking the words "look up" and "record" into what should
// have been a natural question. Same pattern as the knowledge-tool miss path.
// Argument names that denote an identifier rather than a descriptive field.
const IDENTIFIER_KEY = /(phone|mobile|msisdn|cell|number|^id$|_id|_no$|code|account|policy|loan|ref|uid|aadhaar|pan)/i

// Last ten digits — the comparable part of an Indian number however it is written
// (+919003503664, 09003503664, 9003503664 all reduce to the same thing).
const last10 = (s) => ((String(s ?? '').match(/\d/g) || []).join('')).slice(-10)

/**
 * Identity gate on a fetched record.
 *
 * A lookup keyed on something the CALLER SPOKE proves nothing about who they are —
 * they can say any number at all. On a real inbound call the caller spoke a number
 * that was not the one they were calling from, and the agent read out that
 * account's name, EMI amount, due date and interest rate. Anyone who knows a phone
 * number could have extracted the loan position behind it.
 *
 * So when the record carries a phone number and it does NOT match the number this
 * call actually came from, the row is still handed to the model — it needs to know
 * a record exists — but wrapped in an instruction to verify the caller before
 * saying anything financial. Verification by question, not a flat refusal, so a
 * genuine customer ringing from their spouse's phone can still be helped.
 *
 * Off by construction for tenants that don't need it: verify_caller_identity=false.
 */
export function gateDisclosure(row, { callerNumber, tenantConfig = {} } = {}) {
  if (tenantConfig.verify_caller_identity === false) return { row, verified: true }
  const caller = last10(callerNumber)
  // No caller id at all (web test, blocked number) — cannot verify either way.
  if (!caller || caller.length < 10) return { row, verified: true }

  const values = Object.values(row || {}).map(v => String(v ?? ''))
  const phones = values.map(last10).filter(d => d.length === 10)
  // The record holds no phone number, so there is nothing to compare against; the
  // lookup key itself is the only evidence and the tenant's own data can't do better.
  if (!phones.length) return { row, verified: true }

  if (phones.includes(caller)) return { row, verified: true }
  return { row, verified: false, challenges: challengesFor(row) }
}

// Fields that make a workable spoken challenge, best first. Two rules decided this
// order: can a real account holder answer it instantly, and is it in the tenant's
// data at all.
//
// The registered mobile number is FIRST and is present in essentially every loan
// dataset. Asking the caller to STATE it is a knowledge test — it is not the same
// as caller-ID matching, which is the check that just failed, and it stays valid
// precisely when someone rings from a different handset.
//
// "Last payment amount" is deliberately absent. It was in the first version of this
// instruction and it killed a real call: the caller said, reasonably, that they did
// not remember it and offered their registered number instead — which the agent then
// refused, because the hardcoded list did not mention it. Nobody remembers what they
// last paid to the rupee.
const CHALLENGE_FIELDS = [
  [/phone|mobile|msisdn|cell|contact.?no/i,        'the mobile number registered on the account'],
  [/date.?of.?birth|^dob$|birth.?date/i,           'their date of birth as registered'],
  [/address|pin.?code|pincode|city|locality/i,     'their registered address'],
  [/email/i,                                       'the email address on the account'],
  [/start.?date|loan.?start|disburs|open.?date/i,  'the date the loan started'],
]

// Only offer challenges we can actually CHECK — a question whose answer is not in
// the record is theatre, and it sent a real caller round in circles being asked for
// a date of birth this tenant does not store.
function challengesFor(row) {
  const keys = Object.keys(row || {})
  const out = []
  for (const [re, label] of CHALLENGE_FIELDS) {
    if (keys.some(k => re.test(k) && String(row[k] ?? '').trim())) out.push(label)
    if (out.length >= 3) break
  }
  return out
}

const NO_RECORD = 'No matching record was found.'
// Built per call from the fields this record actually holds, so the agent can only
// ask a question it is able to check.
function unverifiedInstruction(challenges = []) {
  const base =
    `\n\nIDENTITY NOT VERIFIED: this call is not coming from the phone number on this record. ` +
    `Do NOT read out any amount, balance, due date, interest rate or other financial detail yet, ` +
    `and do not confirm or deny anything about the account — not even the account holder's name.`

  if (!challenges.length) {
    // Nothing in this record can be checked, so any question would be theatre.
    return base +
      ` There is nothing on this record you can use to verify them, so do not invent a ` +
      `security question. Say you are not able to go through the account details on this call, ` +
      `offer to have a colleague call back on the registered number, and hand off. [HANDOFF]`
  }

  const list = challenges.length === 1
    ? challenges[0]
    : challenges.slice(0, -1).join(', ') + ', or ' + challenges[challenges.length - 1]

  return base +
    ` Ask them for ${list}. Compare their answer with this record and continue only if it matches. ` +
    `Asking for the registered mobile number is perfectly valid even though this call came from a ` +
    `different number — you are testing what they KNOW, not where they are calling from. Ask for ` +
    `ONE thing at a time, naturally, the way a colleague would — never announce it as a security ` +
    `check, never say "for security reasons", and never read out the correct answer. If they cannot ` +
    `answer any of them, offer a callback on the registered number or hand off. [HANDOFF]`
}
const NO_RECORD_INSTRUCTION =
  `${NO_RECORD} Do NOT mention lookups, records, systems, databases or searching to the ` +
  `caller — they do not care how you find things, and naming the machinery is what makes ` +
  `you sound like a robot. Simply ask, naturally and in the caller's language, for the one ` +
  `detail you still need (their customer ID or registered phone number), the way a colleague would.`

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
export async function runLookup(tenantConfig, name, args = {}, { callerNumber = null } = {}) {
  const lookups = Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : []
  const lk = lookups.find(l => sanitizeName(l.name) === name)
  if (!lk) return `No lookup named ${name} is configured.`

  const t0 = Date.now()
  try {
    const result = await withTimeout(resolveBackend(tenantConfig, lk, args), LOOKUP_TIMEOUT_MS)
    const ms = Date.now() - t0
    console.log(`[LOOKUP] "${name}" ${JSON.stringify(args)} → ${result ? 'hit' : 'miss'} (${ms}ms)`)
    telemetry.recordLatency('lookup', ms, { tenantId: tenantConfig.tenant_id })
    const hit = !(result === null || result === undefined || result === '')
    telemetry.incr(`lookup:${name}:${hit ? 'hit' : 'miss'}`)
    if (!hit) return NO_RECORD_INSTRUCTION

    // Identity gate before the model can read anything financial aloud.
    const { verified, challenges = [] } = typeof result === 'object' && result !== null
      ? gateDisclosure(result, { callerNumber, tenantConfig })
      : { verified: true }
    const payload = typeof result === 'string' ? result : JSON.stringify(result)
    if (!verified) {
      console.warn(`[LOOKUP] "${name}" → caller ${callerNumber || '(unknown)'} is NOT the number on this record — gated; can ask for: ${challenges.length ? challenges.join(' / ') : 'nothing (handoff)'}`)
      telemetry.incr(`lookup:${name}:unverified`)
      telemetry.recordServiceEvent({
        component: 'compliance', severity: 'warning', kind: 'lookup_identity_unverified',
        detail: { lookup: name, callerNumber },
      })
      return payload + unverifiedInstruction(challenges)
    }
    return payload
  } catch (e) {
    const ms = Date.now() - t0
    console.error(`[LOOKUP] "${name}" failed:`, e.message)
    telemetry.recordLatency('lookup', ms, { tenantId: tenantConfig.tenant_id })
    const timeout = /timeout/i.test(e.message)
    telemetry.incr(`lookup:${name}:${timeout ? 'timeout' : 'error'}`)
    telemetry.incr(timeout ? 'tool_timeouts_total' : 'tool_errors_total')
    telemetry.recordServiceEvent({ component: 'tool', severity: 'error', kind: timeout ? 'lookup_timeout' : 'lookup_error', detail: { lookup: name, error: e.message } })
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

  // Which of these arguments are IDENTIFIERS? A phone number, an account / policy
  // / loan / customer id, a reference code. Those must match EXACTLY: a substring
  // hit on a mistyped or misheard identifier resolves to a different human being,
  // and this data is their money. A NAME is the opposite — partial and phonetic
  // matches are the whole point there ("Rekha" vs "Rekha Rao"), and a name is
  // never treated as proof of identity anyway.
  const idEntries = Object.entries(args).filter(([k, v]) => {
    const val = String(v ?? '').trim()
    if (!val) return false
    if (IDENTIFIER_KEY.test(String(k))) return true
    const digits = (val.match(/\d/g) || []).length
    const bare = val.replace(/[\s\-_/]+/g, '').length
    return digits >= 4 && digits / Math.max(1, bare) >= 0.5   // 8109439690, LN100087
  })
  // Strict mode: at least one identifier was supplied, so ONLY an exact match on
  // an identifier value may be returned. No first-fuzzy-row fallback.
  const strict = idEntries.length > 0
  const wantedIds = idEntries.map(([, v]) => norm(v)).filter(Boolean)

  const query = async (probe, limit) =>
    supabase
      .from('lookup_rows')
      .select('row')
      .eq('tenant_id', tenantId)
      .eq('dataset', dataset)
      .ilike('search_text', `%${probe}%`)
      .limit(limit)

  // In strict mode the match must be on an IDENTIFIER value, not just any column —
  // otherwise a shared surname in some other field could satisfy an "exact" match
  // while the account number never did.
  const findExact = rows =>
    (rows || []).find(r => Object.values(r.row || {})
      .some(val => (strict ? wantedIds : wanted).includes(norm(val))))

  // ── Phase 1: full-value probes (raw + space-stripped) ──────────────────────
  // Handles "ORD 1002" (query) vs "ORD1002" (stored). The fuzzy first-row
  // fallback survives ONLY for non-identifier lookups (a partial name); when an
  // identifier was supplied, a substring hit that is not an exact match is a
  // DIFFERENT record and must be refused.
  const mainProbes = new Set()
  for (const v of values) {
    mainProbes.add(v.toLowerCase())
    mainProbes.add(v.replace(/\s+/g, '').toLowerCase())
  }
  for (const probe of [...mainProbes].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const { data, error } = await query(probe, 5)
    if (error) throw new Error(error.message)
    if (data && data.length) {
      const exact = findExact(data)
      if (exact) {
        console.log(`[LOOKUP] table probe "${probe}" matched ${data.length} → exact`)
        return exact.row
      }
      if (strict) {
        console.warn(`[LOOKUP] probe "${probe}" matched ${data.length} row(s) but NO exact identifier match — refusing (would be someone else's record)`)
        continue
      }
      console.log(`[LOOKUP] table probe "${probe}" matched ${data.length} → fuzzy`)
      return data[0].row
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
