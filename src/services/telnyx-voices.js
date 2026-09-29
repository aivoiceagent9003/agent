// telnyx-voices.js — the voices a tenant can pick for their agent, and the one a call uses.
//
// Calls are spoken by Telnyx Ultra (see telnyx-tts.js), so the portal's voice picker
// offers Ultra voices.
//
// A SHORT, CHOSEN LIST — at most three per language, for the languages a caller can pick
// (call-language.js). The picker used to list every Indian Ultra voice on the account,
// fetched live: ~120 of them, 58 for Hindi alone, among them storytellers, film actors
// and meditation guides. Too many choices, and many of them wrong for a phone line. These
// were picked from Telnyx's own descriptions for support and conversational calls, with a
// mix of female and male; Kannada, Malayalam and Marathi have only two on the account.
// Ramya stays for Telugu — she is the default every call uses unless a voice is picked.
//
// To swap one: GET https://api.telnyx.com/v2/text-to-speech/voices lists them all, with
// `language` and a description in `label`. Only Ultra voices (id "Telnyx.Ultra.…").
//
// FIELD NAMES ARE THE PICKER'S (VoicePicker.tsx reads id, label, gender, accent, note,
// kind, isDefault).

// "Ramya", a warm Telugu female voice — the platform default when a tenant has not
// picked one. It is Cartesia's own voice id: Ultra is Cartesia Sonic-3, resold.
export const RAMYA = 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'
export const DEFAULT_VOICE = process.env.TELNYX_TTS_VOICE || RAMYA

const voice = (id, label, gender, accent, note) => ({ id: `Telnyx.Ultra.${id}`, label, gender, accent, note })

export const VOICES = [
  voice('3cbf8fed-74d5-4690-b715-711fcf8d825f', 'Pooja', 'female', 'Indian English', 'Bright and positive, made for call-centre conversations.'),
  voice('87177869-f798-48ae-870f-e07d0c960a1e', 'Anu', 'female', 'Indian English', 'Calm, made for call-centre conversations.'),
  voice('a0cc0d65-5317-4652-b166-d9d34a244c6f', 'Neil', 'male', 'Indian English', 'Clear and crisp, for support, sales and reception.'),

  voice('cf061d8b-a752-4865-81a2-57570a6e0565', 'Ramya', 'female', 'Telugu', 'Warm, welcoming Telugu female that puts listeners at ease instantly.'),
  voice('07bc462a-c644-49f1-baf7-82d5599131be', 'Sindhu', 'female', 'Telugu', 'Clear and natural, for everyday conversations.'),
  voice('ebecd063-10f4-422e-a8ff-556ce5c4d4e4', 'Pavan', 'male', 'Telugu', 'Energetic and upbeat, for customer support.'),

  voice('92da9281-7cf3-4c61-be0f-face03a3312f', 'Preeti', 'female', 'Hindi', 'Clear and approachable, for customer support.'),
  voice('e604287d-0c9b-4e0e-82a7-71d21af2cade', 'Shreya', 'female', 'Hindi', 'Warm and friendly Hinglish, for customer support.'),
  voice('97303aad-1a66-4edf-870a-58e6ba545005', 'Amrit', 'male', 'Hindi', 'Warm and conversational, for customer support.'),

  voice('96e6974d-57a9-4325-89c8-43f065f8bd95', 'Akshara', 'female', 'Tamil', 'Bright and organised, for support conversations.'),
  voice('25d2c432-139c-4035-bfd6-9baaabcdd006', 'Kavya', 'female', 'Tamil', 'Friendly and natural, for everyday conversations.'),
  voice('19f28c21-ae34-499f-b64a-f7b09cd9b516', 'Karthik', 'male', 'Tamil', 'Clear and calm, for customer support.'),

  voice('7c6219d2-e8d2-462c-89d8-7ecba7c75d65', 'Divya', 'female', 'Kannada', 'Lively and cheerful.'),
  voice('6baae46d-1226-45b5-a976-c7f9b797aae2', 'Prakash', 'male', 'Kannada', 'Firm and articulate.'),

  voice('b426013c-002b-4e89-8874-8cd20b68373a', 'Latha', 'female', 'Malayalam', 'Bright and clear, for customer support and greetings.'),
  voice('374b80da-e622-4dfc-90f6-1eeb13d331c9', 'Vijay', 'male', 'Malayalam', 'Friendly and easygoing, for everyday support.'),

  voice('5c32dce6-936a-4892-b131-bafe474afe5f', 'Anika', 'female', 'Marathi', 'Energetic and approachable, for sales and support.'),
  voice('f227bc18-3704-47fe-b759-8c78a450fdfa', 'Suresh', 'male', 'Marathi', 'Clear and well enunciated.'),

  voice('48b9e1de-e2fa-4914-8b32-31c437813548', 'Ananya', 'female', 'Bengali', 'Clear and steady, for customer service.'),
  voice('59ba7dee-8f9a-432f-a6c0-ffb33666b654', 'Pooja', 'female', 'Bengali', 'Soft-spoken, for natural conversation.'),
  voice('2ba861ea-7cdc-43d1-8608-4045b5a41de5', 'Rubel', 'male', 'Bengali', 'Casual, for everyday conversations.'),
]

/**
 * The voices the picker offers. Async and shaped as before, so the API route and the
 * picker did not change when this stopped being fetched from Telnyx.
 * @returns {Promise<{id, label, gender, accent, note, kind, isDefault}[]>}
 */
export async function listTelnyxVoices() {
  return VOICES.map(v => ({ ...v, kind: 'built-in', isDefault: v.id === DEFAULT_VOICE }))
}

/**
 * The voice a call is spoken in. A tenant's `tts_voice` is used only when it is a
 * Telnyx voice: tenants set up before Telnyx still carry Soniox names ("Ishita") or
 * Gemini names ("Kore"), and Telnyx refuses both mid-call. A Telnyx voice no longer in
 * the picker's list still works — trimming the list must not change anyone's calls.
 */
export function resolveVoice(tenantConfig = {}) {
  const chosen = String(tenantConfig.tts_voice || '').trim()
  return chosen.startsWith('Telnyx.') ? chosen : DEFAULT_VOICE
}
