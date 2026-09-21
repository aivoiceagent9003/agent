// soniox-voices.js — the voices a tenant can pick for their agent.
//
// Replaces gemini-voices.js. The platform used to run Gemini Live speech-to-speech, so
// the picker offered Gemini's prebuilt voices; the cascade synthesises with Soniox, and
// handing Soniox a Gemini voice name ("Kore") is a 400 in the middle of a call.
//
// Two kinds, and the difference matters to whoever is choosing:
//   BUILT-IN   Soniox's own voices, available to everyone, listed by the API.
//   CLONED     voices this ACCOUNT has cloned in the Soniox console. These are
//              per-account, not per-tenant — every tenant on this key can see and use
//              every clone on it. Worth knowing before clients start cloning their own.
//
// The list is fetched rather than hardcoded, because Soniox adds voices, and cached
// because a picker does not need to be live to the second.

const API = 'https://api.soniox.com/v1'
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const CACHE_MS = Number(process.env.SONIOX_VOICE_CACHE_MS || 10 * 60 * 1000)

let cache = null   // { at, voices }

// If Soniox is unreachable the picker still has to render something, and these are the
// ones most used on Indian lines. A stale name is better than an empty dropdown.
const FALLBACK = [
  { id: 'Arjun', gender: 'male', description: 'Indian English, warm and even. A safe default for Indian callers.', kind: 'built-in' },
  { id: 'Priya', gender: 'female', description: 'Indian English, friendly and clear.', kind: 'built-in' },
  { id: 'Dev', gender: 'male', description: 'Indian accent, built for AI agents.', kind: 'built-in' },
  { id: 'Kavya', gender: 'female', description: 'Hindi, natural conversational tone.', kind: 'built-in' },
  { id: 'Adrian', gender: 'male', description: 'Neutral English.', kind: 'built-in' },
]

async function fetchJson(path) {
  const key = process.env.SONIOX_API_KEY
  if (!key) return null
  try {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } })
    return res.ok ? await res.json() : null
  } catch {
    return null   // the picker degrades to FALLBACK rather than failing the page
  }
}

/**
 * Every voice this account can speak with, built-in and cloned.
 * @returns {Promise<{id, name, gender, description, kind}[]>}
 */
export async function listSonioxVoices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.voices

  const [models, cloned] = await Promise.all([fetchJson('/tts-models'), fetchJson('/voices')])

  const builtIn = (models?.models || [])
    .find(m => m.id === TTS_MODEL)?.voices
    ?.map(v => ({ id: v.id, name: v.id, gender: v.gender || null, description: v.description || '', kind: 'built-in' })) || []

  // A clone is referenced by its UUID, not its name — that is what goes in the config.
  const clones = (cloned?.voices || [])
    .filter(v => v.models?.some(m => m.model === TTS_MODEL && m.status === 'ready'))
    .map(v => ({
      id: v.id,
      name: v.name || 'Cloned voice',
      gender: null,
      description: 'Cloned in the Soniox console.',
      kind: 'cloned',
    }))

  const voices = [...clones, ...builtIn]
  if (!voices.length) return FALLBACK
  cache = { at: Date.now(), voices }
  return voices
}

/**
 * The voice to hand Soniox for this tenant.
 *
 * NOT `config.voice` — that field held a Gemini Live voice name for years and some
 * tenants still carry one. Passing "Kore" to Soniox fails the call, so the cascade
 * reads `tts_voice` and falls back to the server default instead.
 */
export function resolveSonioxVoice(tenantConfig = {}) {
  return String(tenantConfig.tts_voice || process.env.SONIOX_TTS_VOICE || 'Adrian').trim()
}

/** Test seam. */
export function _resetVoiceCache() { cache = null }
