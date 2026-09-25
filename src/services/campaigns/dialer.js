// services/campaigns/dialer.js — outbound origination behind a provider interface.
//
// DialerProvider.originate({ to, from, correlationId, answerUrl }) → { providerId }
// or throws. The dial worker calls this; the answer webhook + WS then bind the media
// stream to the campaign via correlationId (see campaign-registry.js).
//
// The carrier is Plivo; its credentials and URLs come from telephony/provider.js.

import { credentials, authHeaders, originateUrl, TAG, PROVIDER } from '../../telephony/provider.js'
import 'dotenv/config'

// Public base URL the provider calls back to (answer webhook) / streams to (WS).
// Prefers PUBLIC_HOST (the real deployment hostname); NGROK_URL is the dev-only
// fallback, same as the inbound path.
const PUBLIC_HOST = process.env.PUBLIC_HOST || process.env.NGROK_URL || ''

// The carrier requires BOTH numbers in full E.164. A national-format caller ID
// like '08071583556' (how tenant.phone_number is often stored) is ACCEPTED by the API
// (201 "call queued") but can't be originated from → the phone never rings ("Busy Line").
// Normalise Indian national numbers to E.164; anything already in +CC form passes through
// untouched, so an operator-entered caller ID is respected.
function toE164India(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('+')) return s
  const cc = String(process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91'
  let d = s.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)            // drop national trunk '0'
  if (d.length === 10) return `+${cc}${d}`                            // bare 10-digit
  if (d.length === cc.length + 10 && d.startsWith(cc)) return `+${d}` // already CC + 10, no '+'
  return `+${d}`                                                      // best effort
}

// ─── Outbound adapter (Plivo Call API) ────────────────────────────────────────
// POST <base>/Account/{AUTH_ID}/Call/ with body { from, to, answer_url,
// answer_method }. On answer the provider fetches answer_url, which returns our
// <Stream> XML (see src/telephony/campaign.js answerCampaign) and audio flows over
// the WS. We thread the campaign correlation_id through the answer_url query string,
// so it survives back to /answer-campaign and the WS 'start' without relying on the
// provider echoing custom params.
//
// Auth and base URL come from telephony/provider.js.
async function providerOriginate({ to, from, correlationId, answerUrl }) {
  const { authId, authToken, idVar, tokenVar } = credentials()
  if (!authId || !authToken) throw new Error(`${idVar} / ${tokenVar} not set — get them from the ${TAG} console`)
  if (!from) throw new Error(`${TAG} originate: missing caller-id (campaign from_number or tenant phone_number)`)

  // Force E.164 so a national-format caller ID can't silently fail to ring.
  const fromE164 = toE164India(from)
  const toE164 = toE164India(to)

  const url = originateUrl(authId)
  const body = {
    from: fromE164,           // your DID (caller ID), E.164
    to: toE164,               // recipient, E.164
    answer_url: answerUrl,    // returns <Stream> XML; carries ?cid=<correlationId>
    answer_method: 'POST',
  }

  console.log(`[${TAG}] originate → ${url}  from=${fromE164} to=${toE164}`)
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ authId, authToken }),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  // Log the provider's real answer every time — a 2xx here only means "request
  // accepted", not "phone rang". This is the ground truth for silent no-rings.
  console.log(`[${TAG}] response ${res.status}: ${text.slice(0, 500)}`)
  if (!res.ok) throw new Error(`${TAG} originate ${res.status}: ${text.slice(0, 200)}`)
  let json = {}
  try { json = JSON.parse(text) } catch { /* tolerate non-JSON */ }
  // Both providers return a request/call uuid on success.
  const providerId = json.request_uuid || json.call_uuid || json.CallUUID || json.uuid || correlationId
  if (!json.request_uuid && !json.call_uuid && !json.CallUUID && !json.uuid) {
    console.warn(`[${TAG}] no call/request uuid in response — provider may have accepted the request without dialing. Check caller-ID ownership, account balance, and that the number is provisioned for outbound.`)
  }
  return { providerId }
}

// ─── Public API ────────────────────────────────────────────────────────────────
// answerUrl is where the provider fetches call instructions on answer (<Stream> XML).
export async function originate({ to, from, correlationId, answerUrl }) {
  if (!to) throw new Error('originate: missing destination number')
  return providerOriginate({ to, from, correlationId, answerUrl })
}

export function dialerInfo() {
  const { authId, authToken } = credentials()
  return {
    provider: PROVIDER,
    ready: !!(authId && authToken),
    publicHost: PUBLIC_HOST || null,
  }
}
