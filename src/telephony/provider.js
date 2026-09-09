// telephony/provider.js — which telephony provider we are talking to, and the two
// things that differ between them.
//
// Vobiz and Plivo expose the SAME API surface: POST /v1/Account/{auth_id}/Call/ with
// { from, to, answer_url, answer_method }, a `request_uuid` in the response, a
// CallUUID as the per-call control handle, Plivo-style <Stream>/<Dial> XML, and
// playAudio/clearAudio WebSocket frames. That is why the adapters in vobiz.js and
// campaign.js work for both without change.
//
// Exactly three things differ, and they all live here:
//   1. AUTH     — Vobiz sends X-Auth-ID / X-Auth-Token headers; Plivo uses HTTP Basic.
//   2. BASE URL — api.vobiz.ai/api/v1 vs api.plivo.com/v1.
//   3. HEADERS  — custom SIP/extra headers come back prefixed X-VH- (Vobiz) or
//                 X-PH- (Plivo). parseExtraHeaders strips either, so no config needed.
//
// Select with TELEPHONY_PROVIDER=plivo|vobiz (default vobiz, so an existing deploy
// that has not set it keeps behaving exactly as before).

import 'dotenv/config'

export const PROVIDER = String(process.env.TELEPHONY_PROVIDER || 'vobiz').trim().toLowerCase()
export const IS_PLIVO = PROVIDER === 'plivo'

// Human-readable tag for logs, so a line tells you which provider produced it.
export const TAG = IS_PLIVO ? 'PLIVO' : 'VOBIZ'

/**
 * Account credentials for the selected provider.
 * @returns {{ authId: string, authToken: string, idVar: string, tokenVar: string }}
 *          idVar/tokenVar are the env var NAMES, so error messages can name the
 *          variable the operator actually has to set rather than a generic one.
 */
export function credentials() {
  return IS_PLIVO
    ? {
        authId: process.env.PLIVO_AUTH_ID || '',
        authToken: process.env.PLIVO_AUTH_TOKEN || '',
        idVar: 'PLIVO_AUTH_ID',
        tokenVar: 'PLIVO_AUTH_TOKEN',
      }
    : {
        authId: process.env.VOBIZ_AUTH_ID || '',
        authToken: process.env.VOBIZ_AUTH_TOKEN || '',
        idVar: 'VOBIZ_AUTH_ID',
        tokenVar: 'VOBIZ_AUTH_TOKEN',
      }
}

/**
 * Auth headers for a Call API request. This is the ONE genuinely incompatible bit:
 * Plivo authenticates with HTTP Basic (auth_id:auth_token), Vobiz with two custom
 * headers. Everything else about the request is identical.
 */
export function authHeaders({ authId, authToken }) {
  if (IS_PLIVO) {
    const basic = Buffer.from(`${authId}:${authToken}`).toString('base64')
    return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' }
  }
  return { 'X-Auth-ID': authId, 'X-Auth-Token': authToken, 'Content-Type': 'application/json' }
}

// Account-scoped Call API base, e.g. https://api.plivo.com/v1/Account/<id>/Call/
function callApiBase(authId) {
  return IS_PLIVO
    ? `https://api.plivo.com/v1/Account/${authId}/Call/`
    : `https://api.vobiz.ai/api/v1/Account/${authId}/Call/`
}

/**
 * Where to POST to ORIGINATE a new outbound call.
 * PLIVO_OUTBOUND_URL / VOBIZ_OUTBOUND_URL override it if a console shows different.
 */
export function originateUrl(authId) {
  const override = IS_PLIVO ? process.env.PLIVO_OUTBOUND_URL : process.env.VOBIZ_OUTBOUND_URL
  return override || callApiBase(authId)
}

/**
 * Where to POST to REDIRECT a live call leg (human handoff). Both providers take
 * the call uuid as a path segment on the Call API.
 * The override may contain {call_uuid} as a placeholder.
 */
export function transferUrl(authId, callUuid) {
  const override = IS_PLIVO ? process.env.PLIVO_TRANSFER_URL : process.env.VOBIZ_TRANSFER_URL
  if (override) return override.replace('{call_uuid}', encodeURIComponent(callUuid))
  return `${callApiBase(authId)}${encodeURIComponent(callUuid)}/`
}
