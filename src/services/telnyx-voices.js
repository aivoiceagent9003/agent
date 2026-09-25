// telnyx-voices.js — the voices a tenant can pick for their agent, and the one a call uses.
//
// Calls are spoken by Telnyx Ultra (see telnyx-tts.js), so the portal's voice picker
// offers Ultra voices. The list is fetched rather than hardcoded, because Telnyx adds
// voices, and cached, because a picker does not need to be live to the second.
//
// INDIAN ONLY. The account can reach over a thousand Ultra voices; about 120 speak an
// Indian language or Indian English, and those are the only ones that belong on a
// Hyderabad line. Telnyx returns a real `language` field, so the accent is read from
// that rather than guessed from a description.
//
// FIELD NAMES ARE THE PICKER'S (VoicePicker.tsx reads id, label, gender, accent, note,
// kind). Telnyx's own fields are mapped here, in one place: `name` is the display name,
// and — confusingly — `label` is Telnyx's description.

const API = 'https://api.telnyx.com/v2/text-to-speech/voices'
const CACHE_MS = Number(process.env.TELNYX_VOICE_CACHE_MS || 10 * 60 * 1000)

// "Ramya", a warm Telugu female voice — the platform default when a tenant has not
// picked one. It is Cartesia's own voice id: Ultra is Cartesia Sonic-3, resold.
export const DEFAULT_VOICE = process.env.TELNYX_TTS_VOICE || 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'

const ACCENTS = {
  'en-IN': 'Indian English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada',
  ml: 'Malayalam', mr: 'Marathi', pa: 'Punjabi', bn: 'Bengali', gu: 'Gujarati', ur: 'Urdu', or: 'Odia',
}

let cache = null   // { at, voices }

// If Telnyx is unreachable the picker still has to render something.
const FALLBACK = [
  { id: DEFAULT_VOICE, label: 'Ramya', gender: 'female', accent: 'Telugu', note: 'Warm, welcoming Telugu female.', kind: 'built-in' },
]

/** @returns {Promise<{id, label, gender, accent, note, kind}[]>} */
export async function listTelnyxVoices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.voices
  const key = String(process.env.TELNYX_API_KEY || '').trim()
  if (!key) return FALLBACK
  let list = []
  try {
    const res = await fetch(API, { headers: { Authorization: `Bearer ${key}` } })
    if (res.ok) { const j = await res.json(); list = j.voices || j.data || [] }
  } catch { /* the picker degrades to FALLBACK rather than failing the page */ }

  const voices = list
    .filter(v => String(v.id).startsWith('Telnyx.Ultra.') && ACCENTS[v.language])
    .map(v => ({
      id: v.id,
      // "Sindhu - Conversational Partner" → "Sindhu"; the rest reads better as the note.
      label: String(v.name || '').split(/\s+-\s+/)[0].trim() || 'Voice',
      gender: v.gender ? String(v.gender).toLowerCase() : null,
      accent: ACCENTS[v.language],
      note: v.label || String(v.name || '').split(/\s+-\s+/).slice(1).join(' - '),
      kind: 'built-in',
    }))
  if (!voices.length) return FALLBACK
  cache = { at: Date.now(), voices }
  return voices
}

/**
 * The voice a call is spoken in. A tenant's `tts_voice` is used only when it is a
 * Telnyx voice: tenants set up before Telnyx still carry Soniox names ("Ishita") or
 * Gemini names ("Kore"), and Telnyx refuses both mid-call.
 */
export function resolveVoice(tenantConfig = {}) {
  const chosen = String(tenantConfig.tts_voice || '').trim()
  return chosen.startsWith('Telnyx.') ? chosen : DEFAULT_VOICE
}

/** Test seam. */
export function _resetVoiceCache() { cache = null }
