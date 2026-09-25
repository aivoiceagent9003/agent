// telephony/provider.js — Plivo's Call API: credentials, auth, and the URLs for
// originating, transferring and hanging up a call.
//
// Plivo is the only carrier. Everything that talks to its REST API — the campaign
// dialer, the human handoff, the hangup — builds its request from here, so the account
// and the URL shapes live in one place. Custom SIP headers come back prefixed X-PH-;
// the adapters in plivo.js and campaign.js strip that.

import 'dotenv/config'

export const PROVIDER = 'plivo'

// Tag for log lines, so a line tells you it came from the carrier leg.
export const TAG = 'PLIVO'

/**
 * Account credentials.
 * @returns {{ authId: string, authToken: string, idVar: string, tokenVar: string }}
 *          idVar/tokenVar are the env var NAMES, so error messages can name the
 *          variable the operator actually has to set rather than a generic one.
 */
export function credentials() {
  return {
    authId: process.env.PLIVO_AUTH_ID || '',
    authToken: process.env.PLIVO_AUTH_TOKEN || '',
    idVar: 'PLIVO_AUTH_ID',
    tokenVar: 'PLIVO_AUTH_TOKEN',
  }
}

/** Auth headers for a Call API request: HTTP Basic, auth_id:auth_token. */
export function authHeaders({ authId, authToken }) {
  const basic = Buffer.from(`${authId}:${authToken}`).toString('base64')
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }
}

// Account-scoped Call API base, e.g. https://api.plivo.com/v1/Account/<id>/Call/
const callApiBase = (authId) => `https://api.plivo.com/v1/Account/${authId}/Call/`

/** Where to POST to ORIGINATE a new outbound call. PLIVO_OUTBOUND_URL overrides it. */
export function originateUrl(authId) {
  return process.env.PLIVO_OUTBOUND_URL || callApiBase(authId)
}

/**
 * Where to send the explicit HANGUP for a live call leg (DELETE).
 * Same per-call resource as the transfer, but deliberately NOT sharing
 * transferUrl: that one honours PLIVO_TRANSFER_URL, which may point at a
 * different endpoint entirely, and issuing a DELETE against it would be wrong.
 */
export function hangupUrl(authId, callUuid) {
  return `${callApiBase(authId)}${encodeURIComponent(callUuid)}/`
}

/**
 * Where to POST to REDIRECT a live call leg (human handoff): the call uuid as a path
 * segment on the Call API. PLIVO_TRANSFER_URL overrides it and may contain a
 * {call_uuid} placeholder.
 */
export function transferUrl(authId, callUuid) {
  const override = process.env.PLIVO_TRANSFER_URL
  if (override) return override.replace('{call_uuid}', encodeURIComponent(callUuid))
  return `${callApiBase(authId)}${encodeURIComponent(callUuid)}/`
}
