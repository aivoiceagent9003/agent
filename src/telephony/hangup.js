// telephony/hangup.js — end a live call leg from our side.
//
// Closing the media stream is usually enough on its own: with keepCallAlive the
// provider returns to the answer XML, finds nothing after the <Stream>, and drops the
// call. "Usually" is not good enough for the one feature whose entire job is to end
// the call reliably, so we also send the provider's explicit hangup.
//
// Both providers expose the same shape — DELETE on the per-call resource — so this
// goes through the same Plivo adapter as origination and transfer.
//
// Best-effort by design: it never throws. If the REST call fails, the stream close
// has almost certainly ended the call anyway, and a failed hangup must not take the
// process down or leave the caller listening to an exception.

import { credentials, authHeaders, hangupUrl, TAG } from './provider.js'

/**
 * @param {string} callUuid the provider's call handle (provider_call_id)
 * @returns {Promise<boolean>} whether the provider accepted the hangup
 */
export async function hangUpCall(callUuid) {
  if (!callUuid) return false
  const { authId, authToken, idVar, tokenVar } = credentials()
  if (!authId || !authToken) {
    console.warn(`[${TAG}] hangup skipped — ${idVar}/${tokenVar} not set`)
    return false
  }
  try {
    const res = await fetch(hangupUrl(authId, callUuid), {
      method: 'DELETE',
      headers: authHeaders({ authId, authToken }),
    })
    // 204 is the documented success. Anything 2xx counts; 404 means the call has
    // already ended, which is the outcome we wanted regardless.
    if (res.ok || res.status === 404) {
      console.log(`[${TAG}] ☎️ hung up ${callUuid} (${res.status})`)
      return true
    }
    console.warn(`[${TAG}] hangup returned ${res.status} for ${callUuid}`)
    return false
  } catch (e) {
    console.warn(`[${TAG}] hangup failed for ${callUuid}: ${e.message}`)
    return false
  }
}
