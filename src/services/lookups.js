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

// ─── Per-call result cache ───────────────────────────────────────────────────
// A caller asks about their loan, then the interest rate, then the outstanding
// balance, then what is left to pay. That is ONE row and four questions, and it was
// four round trips to the database — 200-460ms each, landing in the silence after
// they finished speaking, so they heard every one.
//
// The cache lives on the per-call state object the engine already owns, and that is
// the whole design. A global cache with a time limit was the obvious first answer
// and it was wrong: on a real call five conversational turns passed between two
// lookups, the sixty-second entry had expired, and the row was fetched again.
// Lengthening the timer only trades that for stale money figures. The right lifetime
// was never a duration — it is the call, which is exactly how long this object lives.
//
// It therefore cannot go stale across calls, cannot leak between callers, needs no
// eviction timer, and needs no invalidation when a client re-uploads their data: the
// next call builds a fresh one.
//
// WHAT IS CACHED is the RAW backend result, before the identity gate. The gate
// depends on what the caller has said so far, so it re-runs against the cached row
// on every lookup — a cached "verified" would be a way to inherit a verification.
const CALL_CACHE_MAX = 50   // a pathological model cannot grow this without bound

// Values are normalised the way resolveTable compares them, so "LN100046",
// "ln 100046" and "ln-100046" are one entry rather than three.
function cacheKey(name, args) {
  const parts = Object.entries(args || {})
    .map(([k, v]) => [k, String(v ?? '').trim().toLowerCase().replace(/[\s\-_/]+/g, '')])
    .filter(([, v]) => v)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  return `${name}|${parts.join('&')}`
}

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
export function gateDisclosure(row, { callerNumber, tenantConfig = {}, spokenDigits = null, alreadyVerified = false } = {}) {
  if (tenantConfig.verify_caller_identity === false) return { row, verified: true }
  // Passing the challenge holds for the rest of the call. Without this the gate had
  // no memory of the answer and re-fired on every lookup: on a real call the caller
  // gave their registered number, got their EMI details, asked a follow-up question,
  // and was challenged all over again — and because the instruction said "STILL not
  // verified", the agent invented a second requirement, apologised, and made them
  // repeat the number they had just given. Re-interrogating someone who has already
  // answered is worse than not asking at all.
  if (alreadyVerified) return { row, verified: true }
  const caller = last10(callerNumber)
  // No caller id at all (web test, blocked number) — cannot verify either way.
  if (!caller || caller.length < 10) return { row, verified: true }

  const values = Object.values(row || {}).map(v => String(v ?? ''))
  const phones = values.map(last10).filter(d => d.length === 10)
  // The record holds no phone number, so there is nothing to compare against; the
  // lookup key itself is the only evidence and the tenant's own data can't do better.
  if (!phones.length) return { row, verified: true }

  if (phones.includes(caller)) return { row, verified: true }
  // The caller may have SAID the registered number — which is exactly the challenge
  // this gate asks for. Checking it here compares their answer against the record in
  // code, rather than handing the model the record and trusting it to grade itself.
  if (spokenDigits && phones.some(p => spokenDigits.has(p))) {
    return { row, verified: true, verifiedBy: 'spoken' }
  }
  // Only checkable challenges: the caller's answer must be something the code can
  // compare, because the record is not released until it does.
  return { row, verified: false, challenges: challengesFor(row, { checkableOnly: true }) }
}

/**
 * Record any phone-length number the caller said, so gateDisclosure can check their
 * answer against the record. Called once per caller turn by the engine.
 *
 * Digits only. A number the transcript spelled out in words will not match, and that
 * is the safe direction to fail: the gate simply stays closed and the model asks.
 */
export function noteSpokenDigits(state, text) {
  if (!state) return
  if (!state.spokenDigits) state.spokenDigits = new Set()
  for (const m of String(text || '').matchAll(/\d[\d\s-]{8,}\d/g)) {
    const d = last10(m[0])
    if (d.length === 10) state.spokenDigits.add(d)
  }
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
//
// The third element says whether the CODE can check the answer. Only spoken digits
// are captured from the transcript, so only the mobile number qualifies. That flag
// is load-bearing now that the record is withheld until verification: a question
// nothing can check would never release the record, so a genuine caller would
// answer correctly and be asked again forever. An unverifiable challenge was
// merely weak before; it is a trap now.
const CHALLENGE_FIELDS = [
  [/phone|mobile|msisdn|cell|contact.?no/i,        'the mobile number registered on the account', true],
  [/date.?of.?birth|^dob$|birth.?date/i,           'their date of birth as registered', false],
  [/address|pin.?code|pincode|city|locality/i,     'their registered address', false],
  [/email/i,                                       'the email address on the account', false],
  [/start.?date|loan.?start|disburs|open.?date/i,  'the date the loan started', false],
]

// Only offer challenges we can actually CHECK — a question whose answer is not in
// the record is theatre, and it sent a real caller round in circles being asked for
// a date of birth this tenant does not store.
function challengesFor(row, { checkableOnly = false } = {}) {
  const keys = Object.keys(row || {})
  const out = []
  for (const [re, label, checkable] of CHALLENGE_FIELDS) {
    if (checkableOnly && !checkable) continue
    if (keys.some(k => re.test(k) && String(row[k] ?? '').trim())) out.push(label)
    if (out.length >= 3) break
  }
  return out
}

const NO_RECORD = 'No matching record was found.'

// What the model gets INSTEAD of the record while the caller is unverified.
//
// Previously the full row was sent, followed by an instruction not to use it. The
// data and the prohibition travelled together, so the only thing standing between
// a caller and someone else's loan position was the model choosing to obey — and
// the instruction also asked it to compare the caller's answer against a record it
// was simultaneously told to keep secret. It was grading its own exam with the
// answer key in hand. On one call it thanked the account holder by name before
// asking anything; on another it released the outstanding amount one turn after a
// number was spoken, before any code had compared that number to anything.
//
// Now the row stays on this side. The model is told a record exists so it does not
// apologise for failing to find one, and nothing else.
const WITHHELD = JSON.stringify({
  record_found: true,
  details_withheld: 'caller identity not verified',
})

// Built per call from the fields this record actually holds, so the agent can only
// ask a question it is able to check.
function unverifiedInstruction(challenges = [], alreadyAsked = false) {
  // Second and later gated lookups on the SAME call. Re-sending the full script
  // re-primed the model every time: on a real call it asked for the registered
  // mobile number in three consecutive turns while the caller was trying to correct
  // their customer ID, and the caller ended up saying "I'm saying 1000 and you're
  // saying 100". Once asked, the reminder is a constraint, not a fresh instruction.
  // What the model must understand in both branches: it does not have the record.
  // Saying "do not read out the balance" would be nonsense — there is no balance in
  // front of it. The risk to guard against now is the opposite one, inventing a
  // figure to fill the silence.
  const nothingHeld =
    `You have NOT been given this account's details — no name, no amounts, no dates. ` +
    `You therefore cannot state any of them, and you must not guess, estimate or invent ` +
    `one. Do not confirm or deny anything about the account, including whether it exists.`

  const reLookup =
    `THE MOMENT THEY ANSWER, CALL THIS LOOKUP AGAIN with the same details you used before. ` +
    `That second call is what checks their answer and returns the account — it is the only ` +
    `way you will ever get it. Do not tell them they are verified, do not thank them for ` +
    `confirming, and do not carry on as though you now have their information: until you ` +
    `call the lookup again you still have nothing.`

  if (alreadyAsked) {
    return `\n\nIDENTITY STILL NOT VERIFIED — you have ALREADY asked for this on this call. ` +
      `Do NOT ask again in this reply. If the caller is correcting you, answering something else, ` +
      `or asking a new question, deal with THAT first and completely. Only return to verification ` +
      `once that is settled, and ask at most once more. ${nothingHeld}\n\n${reLookup}`
  }

  const base =
    `\n\nIDENTITY NOT VERIFIED: this call is not coming from the phone number on this record. ` +
    nothingHeld

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
    ` Ask them for ${list}. ` +
    `Asking for the registered mobile number is perfectly valid even though this call came from a ` +
    `different number — you are testing what they KNOW, not where they are calling from. Ask ONE ` +
    `thing, once, and then WAIT for their answer. ` +
    `Never announce it as a security step: do NOT say "for security", "security purpose", ` +
    `"security kosam", "verification ke liye" or any equivalent in any language. Just ask it the ` +
    `way a colleague would — "and which mobile number is registered on this?".\n\n` +
    `${reLookup}\n\n` +
    `If they cannot answer, offer a callback on the registered number or hand off. [HANDOFF]`
}
const NEVER_NARRATE =
  `Do NOT mention lookups, records, systems, databases or searching to the caller — they do ` +
  `not care how you find things, and naming the machinery is what makes you sound like a robot.`

function noRecordInstruction(args = {}) {
  // The identifier we actually searched with, as a string, so the model reads back
  // what it USED rather than what it believes it heard.
  const searched = Object.entries(args)
    .map(([k, v]) => [k, String(v ?? '').trim()])
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} "${v}"`)

  if (!searched.length) {
    return `${NO_RECORD} ${NEVER_NARRATE} Simply ask, naturally and in the caller's language, ` +
      `for the one detail you still need (their customer ID or registered phone number), the ` +
      `way a colleague would.`
  }

  return `${NO_RECORD} You searched using ${searched.join(' and ')}. ${NEVER_NARRATE}\n\n` +
    `ALMOST CERTAINLY YOU HAVE ONE CHARACTER WRONG — that is far more likely than the caller ` +
    `not existing, so do NOT tell them there is no record and do NOT suggest a technical fault. ` +
    `Read back the EXACT value above, one character at a time, and ask them to confirm it: ` +
    `"L, N, one, zero, zero, zero, seven, seven — is that right?". Say every character ` +
    `separately. NEVER say "double", "triple", "double-zero" or any similar grouping — that is ` +
    `how the wrong number gets confirmed as the right one.\n\n` +
    `If they correct a character, use their corrected value EXACTLY as given and try again. If ` +
    `they confirm it unchanged, ask for a DIFFERENT detail instead — their registered phone ` +
    `number if you tried an ID, or their ID if you tried a number — and try that.`
}

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
// `state` is a per-CALL scratch object owned by the engine. It exists so the
// identity challenge is issued once per call rather than once per lookup.
export async function runLookup(tenantConfig, name, args = {}, { callerNumber = null, state = null } = {}) {
  const lookups = Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : []
  const lk = lookups.find(l => sanitizeName(l.name) === name)
  if (!lk) return `No lookup named ${name} is configured.`

  const t0 = Date.now()
  const key = cacheKey(name, args)
  try {
    // Only HITS are cached. A miss almost always means the identifier was misheard,
    // and the caller's correction produces a different key anyway — so caching one
    // saves nothing and would hide a row that had only just been uploaded.
    const cached = state?.rows?.get(key)
    let result, ms
    if (cached !== undefined) {
      result = cached
      ms = Date.now() - t0
      console.log(`[LOOKUP] ⚡ "${name}" ${JSON.stringify(args)} → cache hit (${ms}ms)`)
      telemetry.incr(`lookup:${name}:cache_hit`)
      telemetry.recordLatency('lookup', ms, { tenantId: tenantConfig.tenant_id, cache: true })
    } else {
      result = await withTimeout(resolveBackend(tenantConfig, lk, args), LOOKUP_TIMEOUT_MS)
      ms = Date.now() - t0
      console.log(`[LOOKUP] "${name}" ${JSON.stringify(args)} → ${result ? 'hit' : 'miss'} (${ms}ms)`)
      telemetry.incr(`lookup:${name}:cache_miss`)
      telemetry.recordLatency('lookup', ms, { tenantId: tenantConfig.tenant_id })
    }
    const hit = !(result === null || result === undefined || result === '')
    telemetry.incr(`lookup:${name}:${hit ? 'hit' : 'miss'}`)
    if (!hit) return noRecordInstruction(args)
    if (cached === undefined && state) {
      if (!state.rows) state.rows = new Map()
      if (state.rows.size < CALL_CACHE_MAX) state.rows.set(key, result)
    }

    // Identity gate before the model can read anything financial aloud.
    const { verified, verifiedBy, challenges = [] } = typeof result === 'object' && result !== null
      ? gateDisclosure(result, {
          callerNumber, tenantConfig,
          spokenDigits: state?.spokenDigits,
          alreadyVerified: Boolean(state?.identityVerified),
        })
      : { verified: true }
    const payload = typeof result === 'string' ? result : JSON.stringify(result)
    if (!verified) {
      console.warn(`[LOOKUP] "${name}" → caller ${callerNumber || '(unknown)'} is NOT the number on this record — gated; can ask for: ${challenges.length ? challenges.join(' / ') : 'nothing (handoff)'}`)
      telemetry.incr(`lookup:${name}:unverified`)
      telemetry.recordServiceEvent({
        component: 'compliance', severity: 'warning', kind: 'lookup_identity_unverified',
        detail: { lookup: name, callerNumber },
      })
      const alreadyAsked = Boolean(state?.identityChallengeSent)
      if (state) state.identityChallengeSent = true
      // WITHHELD, not payload. The record never leaves this function until the
      // code — not the model — has matched the caller's answer against it.
      return WITHHELD + unverifiedInstruction(challenges, alreadyAsked)
    }
    // Latch it. Once this caller is verified they stay verified for the call.
    if (state && !state.identityVerified) {
      state.identityVerified = true
      if (verifiedBy === 'spoken') {
        console.log(`[LOOKUP] "${name}" → caller verified: they stated the registered number`)
        telemetry.incr(`lookup:${name}:verified_by_answer`)
      }
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

  // Compare ignoring case, spaces and the punctuation people write inside numbers,
  // so "ORD 1002", "ORD1002", "ord-1002" and "+91 71851-88888" all reduce to the
  // same thing — regardless of how the caller said it or how the sheet stored it.
  //
  // Currency symbols and thousands commas are deliberately NOT stripped. Stripping
  // them would turn the EMI amount "₹96,212" into "96212", which could then satisfy
  // an exact match for a customer ID of 96212 and return a stranger's row.
  const norm = s => String(s).trim().toLowerCase().replace(/[\s\-_/.+()]+/g, '')
  const wanted = values.map(norm).filter(Boolean)

  // A phone number, however it happens to be written. The last ten digits ARE the
  // number: "+91 7185188888", "917185188888", "07185188888" and "7185188888" are one
  // phone, and callers say the short form while spreadsheets store the long one.
  //
  // This is why a correct number was refused on a real call. The record held
  // "+91 7185188888", the caller said "7185188888", exact string matching said no,
  // and strict mode — rightly — would not fall back to the fuzzy row. So the lookup
  // rejected the right record and the caller was told twice that they did not exist.
  //
  // Bounded at 13 digits so a long account number never gets matched on its tail.
  // Values containing letters are never treated as phone numbers: an ID keeps full,
  // exact, character-for-character matching, because that is someone's money.
  const phoneKey = (raw) => {
    const n = norm(raw)
    if (!/^[0-9]+$/.test(n)) return null
    return n.length >= 10 && n.length <= 13 ? n.slice(-10) : null
  }

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
  const wantedIds = new Set(idEntries.map(([, v]) => norm(v)).filter(Boolean))
  const wantedPhones = new Set(idEntries.map(([, v]) => phoneKey(v)).filter(Boolean))

  // An identifier matches if the whole normalised value is identical, or — for phone
  // numbers only — if the last ten digits are.
  const matchesIdentifier = (val) => {
    if (wantedIds.has(norm(val))) return true
    const p = phoneKey(val)
    return p !== null && wantedPhones.has(p)
  }

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
      .some(val => (strict ? matchesIdentifier(val) : wanted.includes(norm(val)))))

  // ── Phase 1: full-value probes (raw + space-stripped) ──────────────────────
  // Handles "ORD 1002" (query) vs "ORD1002" (stored). The fuzzy first-row
  // fallback survives ONLY for non-identifier lookups (a partial name); when an
  // identifier was supplied, a substring hit that is not an exact match is a
  // DIFFERENT record and must be refused.
  const mainProbes = new Set()
  for (const v of values) {
    mainProbes.add(v.toLowerCase())
    mainProbes.add(v.replace(/\s+/g, '').toLowerCase())
    // The bare ten digits, so the substring probe still finds a row when the caller
    // gave the number WITH a country code and the sheet stored it without, or the
    // other way round.
    const p = phoneKey(v)
    if (p) mainProbes.add(p)
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

  // Nothing matched. Before reporting a plain miss, say whether the sheet this
  // lookup points at exists at all — because those are completely different
  // faults and they look identical in the log.
  //
  // A tenant had 100,000 correct rows in a sheet named after the file they
  // uploaded, while their lookup still searched a sheet named "Loan Status" that
  // had never existed. Every call failed, and the only trace was "→ miss", which
  // reads as "that customer isn't in your data". One extra count on the miss path
  // is a cheap price for not losing an afternoon to that again.
  const { count } = await supabase
    .from('lookup_rows')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('dataset', dataset)
  if (!count) {
    console.warn(
      `[LOOKUP] ⚠️ dataset "${dataset}" holds NO rows for this tenant — the lookup is ` +
      `pointed at a sheet that was never uploaded (or was renamed). Every lookup will ` +
      `miss until the lookup's dataset name matches an uploaded sheet.`,
    )
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset ingestion — store an uploaded data sheet for the `table` backend.
// Each row is kept as jsonb plus a flattened `search_text` for fast ILIKE.
// ─────────────────────────────────────────────────────────────────────────────

// The one place search_text is derived. Every write path — bulk ingest, a single
// row created by hand, a single row edited — must go through this, because a row
// whose search_text disagrees with its `row` is invisible to the live call: the
// ILIKE probe never finds it, and the caller is told they do not exist.
export function searchTextFor(row) {
  return Object.values(row || {}).map(v => String(v ?? '')).join(' ').toLowerCase()
}

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
    search_text: searchTextFor(row),
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

// A tenant is not expected to have more sheets than this. The bound exists so a
// bug in the cursor walk below can never become an unbounded query loop.
const MAX_DATASETS = 200

/**
 * The distinct sheet names a tenant has, without reading their rows.
 *
 * PostgREST has no DISTINCT, so this walks the names: ask for the first row
 * ordered by dataset, then the first row whose dataset sorts after that one, and
 * so on. Each request returns exactly one row and lands on the
 * (tenant_id, dataset) index, so a tenant with three sheets and a million rows
 * costs four tiny queries.
 *
 * The obvious alternative — select every row's dataset and reduce client-side —
 * is what was here, and it is wrong twice over. PostgREST caps a select at 1000
 * rows, so it both undercounts and, worse, can miss a sheet entirely: with 100k
 * rows in "loans" and 5 in "orders", the first 1000 rows are all "loans" and
 * "orders" vanishes from the client's dashboard.
 */
async function distinctDatasets(tenantId) {
  const names = []
  let after = null
  for (let i = 0; i < MAX_DATASETS; i++) {
    let q = supabase
      .from('lookup_rows')
      .select('dataset')
      .eq('tenant_id', tenantId)
      .order('dataset', { ascending: true })
      .limit(1)
    if (after !== null) q = q.gt('dataset', after)
    const { data, error } = await q
    if (error) { console.error('[LOOKUP] distinctDatasets error:', error.message); break }
    if (!data?.length) break
    names.push(data[0].dataset)
    after = data[0].dataset
  }
  return names
}

/**
 * A tenant's uploaded sheets, one entry each: row count and when it was last
 * uploaded — the two things the manager UI shows.
 *
 * The count comes from the database with head: true, so the number is exact and
 * no rows cross the wire. Counting them here instead reported 1000 for a sheet of
 * 100,000, because that is where PostgREST stops sending.
 */
export async function listDatasets(tenantId) {
  if (!tenantId) return []

  const names = await distinctDatasets(tenantId)

  return Promise.all(names.map(async (dataset) => {
    const [{ count }, { data: latest }] = await Promise.all([
      // head: true → the server counts, and sends no rows at all.
      supabase.from('lookup_rows')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('dataset', dataset),
      supabase.from('lookup_rows')
        .select('created_at')
        .eq('tenant_id', tenantId).eq('dataset', dataset)
        .order('created_at', { ascending: false }).limit(1),
    ])
    return { dataset, rows: count ?? 0, updated_at: latest?.[0]?.created_at ?? null }
  }))
}

export async function deleteDataset(tenantId, dataset) {
  if (!tenantId || !dataset) return
  await supabase.from('lookup_rows').delete().eq('tenant_id', tenantId).eq('dataset', dataset)
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing the data — browse, add, correct and remove single rows.
//
// Until now the only way to change a dataset was to re-upload the whole sheet,
// which replaces every row. That is the wrong tool for the job people actually
// have: one customer paid their EMI, one phone number was typed wrong, one new
// account opened. Re-uploading to fix a single cell means exporting, editing and
// re-importing thousands of rows — and any row added since the last export is
// silently destroyed, because the upload path replaces rather than merges.
//
// These are ordinary CRUD functions with two non-negotiables:
//   1. tenant_id is in the WHERE clause of every read and write. A row id is a
//      uuid, but guessing is not the threat — a bug that drops the scope is, and
//      this table holds other businesses' customer records.
//   2. search_text is rewritten from the row on every write (searchTextFor).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_COLUMNS = 60
const MAX_KEY_LENGTH = 200
const MAX_VALUE_LENGTH = 2000

// A refusal the client caused and can fix, flagged so the route can answer 400
// with this exact wording. A database failure carries no flag and must never have
// its message forwarded — it would leak schema detail to a tenant.
const invalid = (message) => Object.assign(new Error(message), { invalid: true })

/**
 * Validate and clean one row before it is stored.
 *
 * Values are coerced to trimmed strings so a hand-typed row is indistinguishable
 * from an uploaded one — the CSV parser produces strings for everything, and the
 * matching in resolveTable normalises strings. A row where the EMI is the number
 * 96212 in one record and the string "96,212" in the next is a matching bug
 * waiting to happen.
 *
 * Nested objects and arrays are refused rather than flattened: search_text would
 * render them "[object Object]", so the row would exist and never be findable.
 *
 * @throws {Error} with a message meant to be shown to the client.
 */
export function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw invalid('A row must be an object of column names and values.')
  }

  const entries = Object.entries(row)
  if (entries.length > MAX_COLUMNS) {
    throw invalid(`A row can have at most ${MAX_COLUMNS} columns.`)
  }

  const clean = {}
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey).trim()
    if (!key) continue                                    // an unnamed column is not a column
    if (key.length > MAX_KEY_LENGTH) {
      throw invalid(`Column name "${key.slice(0, 40)}…" is too long.`)
    }
    if (rawValue !== null && rawValue !== undefined && typeof rawValue === 'object') {
      throw invalid(`Column "${key}" must hold a single value, not a list or a nested object.`)
    }
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim()
    if (value.length > MAX_VALUE_LENGTH) {
      throw invalid(`The value in "${key}" is too long (limit ${MAX_VALUE_LENGTH} characters).`)
    }
    clean[key] = value
  }

  if (!Object.keys(clean).length) throw invalid('A row needs at least one column.')
  if (!Object.values(clean).some(v => v !== '')) throw invalid('A row cannot be entirely empty.')
  return clean
}

/**
 * The column set of a dataset, in the order it was first seen.
 *
 * Rows are jsonb with no enforced schema, so this is derived rather than stored.
 * Taking the union — not just the first row's keys — matters because a hand-added
 * row may carry a column the original sheet did not, and a column that exists in
 * the data but not in the header would be invisible in the editor.
 */
export function datasetColumns(rows = []) {
  const cols = []
  const seen = new Set()
  for (const r of rows) {
    for (const k of Object.keys(r?.row || {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k) }
    }
  }
  return cols
}

/**
 * A page of rows, optionally filtered by a free-text query.
 *
 * The filter runs against search_text with the same ILIKE the live call uses, so
 * what a client can find in the editor is what the agent can find on a call. That
 * is the point: when a caller says the lookup failed, the client can reproduce it.
 *
 * @returns {Promise<{rows: Array<{id: string, row: object}>, total: number, columns: string[]}>}
 */
export async function listDatasetRows(tenantId, dataset, { q = '', limit = 50, offset = 0 } = {}) {
  if (!tenantId || !dataset) return { rows: [], total: 0, columns: [] }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const from = Math.max(Number(offset) || 0, 0)

  const build = (select, opts) => {
    let query = supabase
      .from('lookup_rows')
      .select(select, opts)
      .eq('tenant_id', tenantId)
      .eq('dataset', dataset)
    const needle = String(q || '').trim().toLowerCase()
    // escape ILIKE wildcards so a literal % or _ in a search box is not a wildcard
    if (needle) query = query.ilike('search_text', `%${needle.replace(/[%_]/g, m => '\\' + m)}%`)
    return query
  }

  const [{ data, error }, { count }] = await Promise.all([
    build('id, row').order('created_at', { ascending: true }).range(from, from + size - 1),
    build('id', { count: 'exact', head: true }),
  ])
  if (error) throw new Error(error.message)

  const rows = (data || []).map(r => ({ id: r.id, row: r.row || {} }))

  // Columns come from the whole dataset, not just this page — otherwise the
  // editor's columns would shift as you paged or searched.
  const { data: sample } = await supabase
    .from('lookup_rows').select('row')
    .eq('tenant_id', tenantId).eq('dataset', dataset).limit(200)

  return { rows, total: count ?? rows.length, columns: datasetColumns(sample || []) }
}

/** Add one row. Returns the stored row with its new id. */
export async function createDatasetRow(tenantId, dataset, row) {
  if (!tenantId || !dataset) throw invalid('A dataset is required.')
  const clean = normalizeRow(row)
  const { data, error } = await supabase
    .from('lookup_rows')
    .insert({ tenant_id: tenantId, dataset, row: clean, search_text: searchTextFor(clean) })
    .select('id, row')
    .single()
  if (error) throw new Error(error.message)
  return { id: data.id, row: data.row }
}

/**
 * Replace one row's contents.
 *
 * This is a replace, not a merge: the editor sends the row as the client sees it,
 * and a merge would make deleting a column impossible. dataset is in the WHERE
 * clause alongside tenant_id so a stale id from another dataset cannot be edited
 * through the wrong screen.
 *
 * @returns {Promise<{id, row}|null>} null when no such row belongs to this tenant.
 */
export async function updateDatasetRow(tenantId, dataset, id, row) {
  if (!tenantId || !dataset || !id) throw invalid('A row id is required.')
  const clean = normalizeRow(row)
  const { data, error } = await supabase
    .from('lookup_rows')
    .update({ row: clean, search_text: searchTextFor(clean) })
    .eq('tenant_id', tenantId).eq('dataset', dataset).eq('id', id)
    .select('id, row')
  if (error) throw new Error(error.message)
  return data?.length ? { id: data[0].id, row: data[0].row } : null
}

/** Remove one row. Returns false when it was not this tenant's to remove. */
export async function deleteDatasetRow(tenantId, dataset, id) {
  if (!tenantId || !dataset || !id) return false
  const { data, error } = await supabase
    .from('lookup_rows')
    .delete()
    .eq('tenant_id', tenantId).eq('dataset', dataset).eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  return !!data?.length
}

/**
 * Turn an uploaded data sheet into rows, whichever format it arrived in.
 *
 * The upload's type check accepts .xlsx and .xls, but the only parser here was
 * the CSV one — so an Excel file was decoded as UTF-8 text and fed to it. A zip
 * container does not fail that; it parses. A real three-column sheet came back as
 * 32 rows whose first column name began "PK...xl/_rels/workbook.xml.rels", and
 * because upload replaces, those rows took the place of the client's actual data.
 * Nothing errored, and the next caller simply did not exist any more.
 *
 * SheetJS is already a dependency and already reads contact lists this way. The
 * values are coerced to trimmed strings (raw: false) so an Excel row is stored
 * identically to the same row saved as CSV — matching compares strings, and a
 * number stored as 96212 in one sheet and "96,212" in another is a lookup that
 * works for one client and not the next.
 */
export async function parseSheetFile(buffer, filename = '', mimetype = '') {
  const name = String(filename).toLowerCase()
  const mime = String(mimetype).toLowerCase()
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls') ||
    mime.includes('spreadsheet') || mime.includes('excel')

  if (!isExcel) return parseCSV(Buffer.from(buffer).toString('utf8'))

  const XLSX = (await import('xlsx')).default || (await import('xlsx'))
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]     // the first sheet, as with contacts
  if (!sheet) return []

  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
    .map(r => Object.fromEntries(
      Object.entries(r)
        .map(([k, v]) => [String(k).trim(), String(v ?? '').trim()])
        .filter(([k]) => k),
    ))
    .filter(r => Object.values(r).some(v => v !== ''))
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
