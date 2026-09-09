
// When the AI can't help, transfer the live call to a human agent's phone. Plivo and
// Vobiz share the same mechanism: the Call API redirects the caller leg to <Dial> XML.

import { signDestination, isE164, webhookQuery } from '../api/webhook-auth.js'
import { credentials, authHeaders, transferUrl, TAG } from '../telephony/provider.js'
import 'dotenv/config'

// ─── Handoff intent detection ─────────────────────────────────────────────────
// Layer 1: explicit keywords (instant, no LLM needed)

const HANDOFF_KEYWORDS = [
  // English
  'human', 'agent', 'representative', 'real person', 'speak to someone',
  'talk to someone', 'manager', 'supervisor', 'customer service',
  'transfer me', 'connect me', 'real agent', 'live agent',
  // Hindi (romanized + script)
  'इंसान', 'व्यक्ति', 'एजेंट', 'manager se baat',
  // Telugu
  'మనిషి', 'వ్యక్తి', 'ఏజెంట్',
]

// Detect if the caller's transcript explicitly asks for a human
export function detectHandoffKeyword(transcript) {
  const lower = transcript.toLowerCase()
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
}

// Layer 2: LLM signal detection
// The LLM is instructed to emit [HANDOFF] when it decides it cannot help.
// We strip the token before speaking and use it as the transfer trigger.
export function detectHandoffSignal(llmReply) {
  return /\[HANDOFF\]/i.test(llmReply)
}

export function stripHandoffSignal(text) {
  return text.replace(/\[HANDOFF\]/gi, '').trim()
}

// ─── Perform the warm transfer ────────────────────────────────────────────────
// Redirects the LIVE call over Vobiz so the caller reaches a human, ending the
// media stream.
//
//   callSid       — the engine's call id (kept for logging)
//   handoffNumber — the human agent's phone number to dial
//   callerNumber  — the caller (unused today; kept for logging/future use)
//   callControl   — per-call transport info set by vobiz.js:
//                   { provider_call_id, business_number }.
export async function transferToHuman(callSid, handoffNumber, callerNumber, callControl = {}) {
  if (!handoffNumber) {
    console.error('[HANDOFF] ❌ No handoff number configured — cannot transfer')
    return false
  }
  try {
    return await transferViaVobiz(callControl.provider_call_id, handoffNumber, callControl.business_number)
  } catch (err) {
    console.error('[HANDOFF] ❌ Transfer failed:', err.message)
    return false
  }
}

// Normalize an Indian phone number to E.164 (+91XXXXXXXXXX). Vobiz outbound
// dialing (the <Dial> and its callerId) needs E.164 — a national-format number
// like "08071583556" (leading zero, no country code) can make the dial fail →
// the caller hears a busy tone. Handles "0XXXXXXXXXX", "XXXXXXXXXX", "91XXXXXXXXXX"
// and "+91XXXXXXXXXX"; anything already starting with '+' is left as-is.
function toE164India(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('+')) return s
  let d = s.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)   // drop trunk '0'
  if (d.length === 10) return `+91${d}`                       // bare 10-digit
  if (d.length === 12 && d.startsWith('91')) return `+${d}`   // 91 + 10 digits
  return `+${d}`                                              // best effort
}

// ─── Transfer the live call via the provider's Call API (Plivo / Vobiz) ───────
// Both providers redirect a call LEG to a URL that returns fresh XML. We redirect
// the caller leg ('aleg') to our /vobiz/transfer endpoint, which returns <Dial> XML
// that connects the caller to the human agent (see vobizTransferXml in vobiz.js).
//   callUuid       — the CallUUID captured at /answer (REST control handle)
//   businessNumber — the tenant's DID, used as the caller ID when dialing
// ⚠️ CONFIRM-ON-FIRST-CALL: the transfer endpoint/params follow the documented
// Plivo-compatible shape; override with PLIVO_TRANSFER_URL / VOBIZ_TRANSFER_URL if
// the console differs.
async function transferViaVobiz(callUuid, handoffNumber, businessNumber) {
  const { authId, authToken, idVar, tokenVar } = credentials()
  if (!authId || !authToken) {
    console.error(`[HANDOFF] ❌ ${idVar} / ${tokenVar} not set — cannot transfer`)
    return false
  }
  if (!callUuid) {
    console.error(`[HANDOFF] ❌ No ${TAG} CallUUID for this call — was it captured at /answer? Cannot transfer`)
    return false
  }
  const host = process.env.PUBLIC_HOST || process.env.NGROK_URL
  if (!host) {
    console.error(`[HANDOFF] ❌ PUBLIC_HOST / NGROK_URL not set — ${TAG} cannot fetch the transfer XML`)
    return false
  }

  // Both numbers must be E.164 for the provider to dial out — otherwise the <Dial>
  // can fail and the caller hears a busy tone.
  const dest = toE164India(handoffNumber)
  const callerId = toE164India(businessNumber)

  // Refuse to build a transfer for anything that isn't a phone number, so a bad
  // handoff_number in a tenant's config can never reach the dial XML.
  if (!isE164(dest)) {
    console.error(`[HANDOFF] ❌ handoff number is not E.164 after normalisation: ${dest}`)
    return false
  }

  // The URL Vobiz fetches for the caller leg: returns <Dial> to the human.
  //
  // Two credentials ride along, and they do different jobs. `k` is the shared
  // webhook secret that gates the endpoint at all. `sig` is an HMAC over this
  // specific (to, callerId) pair — so even someone holding `k` cannot swap in
  // their own destination, which is what turns the endpoint from an open relay
  // into one that only dials numbers we chose.
  const sig = signDestination(dest, callerId)
  const alegUrl =
    `https://${host}/vobiz/transfer?${webhookQuery()}` +
    `&to=${encodeURIComponent(dest)}` +
    (callerId ? `&callerId=${encodeURIComponent(callerId)}` : '') +
    `&sig=${sig}`

  const url = transferUrl(authId, callUuid)

  console.log(`[HANDOFF] 🔀 ${TAG} transfer ${callUuid} → ${dest} callerId=${callerId || '(default)'} (aleg_url=${alegUrl})`)
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ authId, authToken }),
    body: JSON.stringify({ legs: 'aleg', aleg_url: alegUrl, aleg_method: 'POST' }),
  })
  const text = await res.text()
  console.log(`[HANDOFF] ${TAG} transfer response ${res.status}: ${text.slice(0, 300)}`)
  if (!res.ok) throw new Error(`${TAG} transfer ${res.status}: ${text.slice(0, 200)}`)
  console.log(`[HANDOFF] ✅ ${TAG} transfer initiated for ${callUuid}`)
  return true
}