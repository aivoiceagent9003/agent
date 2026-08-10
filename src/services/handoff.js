
// When the AI can't help, transfer the live call to a human agent's phone over
// Vobiz (Plivo-compatible): the Call API redirects the caller leg to <Dial> XML.

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

// ─── Vobiz: transfer the live call via the Vobiz Call API (Plivo-compatible) ───
// Vobiz redirects a call LEG to a URL that returns fresh XML. We redirect the
// caller leg ('aleg') to our /vobiz/transfer endpoint, which returns <Dial> XML
// that connects the caller to the human agent (see vobizTransferXml in vobiz.js).
//   callUuid       — the Vobiz CallUUID captured at /answer (REST control handle)
//   businessNumber — the tenant's Vobiz DID, used as the caller ID when dialing
// ⚠️ CONFIRM-ON-FIRST-CALL: the transfer endpoint/params follow Vobiz's documented
// Plivo-compatible shape; override with VOBIZ_TRANSFER_URL if the console differs.
async function transferViaVobiz(callUuid, handoffNumber, businessNumber) {
  const authId = process.env.VOBIZ_AUTH_ID
  const authToken = process.env.VOBIZ_AUTH_TOKEN
  if (!authId || !authToken) {
    console.error('[HANDOFF] ❌ VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN not set — cannot transfer')
    return false
  }
  if (!callUuid) {
    console.error('[HANDOFF] ❌ No Vobiz CallUUID for this call — was it captured at /answer? Cannot transfer')
    return false
  }
  const host = process.env.PUBLIC_HOST || process.env.NGROK_URL
  if (!host) {
    console.error('[HANDOFF] ❌ PUBLIC_HOST / NGROK_URL not set — Vobiz cannot fetch the transfer XML')
    return false
  }

  // Both numbers must be E.164 for Vobiz to dial out — otherwise the <Dial> can
  // fail and the caller hears a busy tone.
  const dest = toE164India(handoffNumber)
  const callerId = toE164India(businessNumber)

  // The URL Vobiz fetches for the caller leg: returns <Dial> to the human.
  const alegUrl =
    `https://${host}/vobiz/transfer?to=${encodeURIComponent(dest)}` +
    (callerId ? `&callerId=${encodeURIComponent(callerId)}` : '')

  const url = process.env.VOBIZ_TRANSFER_URL
    ? process.env.VOBIZ_TRANSFER_URL.replace('{call_uuid}', encodeURIComponent(callUuid))
    : `https://api.vobiz.ai/api/v1/Account/${authId}/Call/${encodeURIComponent(callUuid)}/`

  console.log(`[HANDOFF] 🔀 Vobiz transfer ${callUuid} → ${dest} callerId=${callerId || '(default)'} (aleg_url=${alegUrl})`)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Auth-ID': authId, 'X-Auth-Token': authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ legs: 'aleg', aleg_url: alegUrl, aleg_method: 'POST' }),
  })
  const text = await res.text()
  console.log(`[HANDOFF] Vobiz transfer response ${res.status}: ${text.slice(0, 300)}`)
  if (!res.ok) throw new Error(`Vobiz transfer ${res.status}: ${text.slice(0, 200)}`)
  console.log(`[HANDOFF] ✅ Vobiz transfer initiated for ${callUuid}`)
  return true
}