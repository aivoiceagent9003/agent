// gemini-voices.js — The prebuilt voice catalog for Gemini Live models.
//
// These are Google's built-in Live-API voices (named after stars/myth, e.g.
// Aoede, Kore, Puck). IMPORTANT: they are NOT language-specific — every voice is
// multilingual and speaks Indic languages (Telugu, Hindi, Tamil, Kannada, …)
// NATIVELY. There is no "Sameera"/"Padmaja" here; you pick a voice for its TONE,
// and it will speak whatever language the caller uses. The `note` is Google's
// published tone descriptor.
//
// `recommended` voices are warm/natural ones that tend to work well for Indian
// phone personas — the picker lists them first.
//
// If a specific preview model rejects some voices, trim the catalog WITHOUT a
// code change via GEMINI_VOICES_AVAILABLE (comma-separated ids).

// A curated set of 3 female + 3 male voices. All are from Gemini's 8 original
// prebuilt voices, so they're the most reliably supported across Live models.
// `gender` is the perceived gender (Google doesn't officially label these).
export const GEMINI_VOICES = [
  // ── Female ──
  { id: 'Aoede', gender: 'female', note: 'Breezy, warm (default)' },
  { id: 'Kore',  gender: 'female', note: 'Firm, confident' },
  { id: 'Leda',  gender: 'female', note: 'Youthful, friendly' },
  // ── Male ──
  { id: 'Charon', gender: 'male', note: 'Informative, steady' },
  { id: 'Orus',   gender: 'male', note: 'Firm, clear' },
  { id: 'Puck',   gender: 'male', note: 'Upbeat, energetic' },
]

export const DEFAULT_GEMINI_VOICE = 'Aoede'

// Resolve a stored voice name to a valid catalog voice (case-insensitive). Falls
// back to the default when the name is empty or not a Gemini voice — this guards
// against legacy configs that saved a Sarvam/Smallest id (e.g. "priya"), which
// would otherwise make the Gemini Live session reject on connect.
export function resolveGeminiVoice(name, fallback = DEFAULT_GEMINI_VOICE) {
  const wanted = String(name || '').trim().toLowerCase()
  if (!wanted) return fallback
  const hit = GEMINI_VOICES.find(v => v.id.toLowerCase() === wanted)
  return hit ? hit.id : fallback
}

// The catalog shaped for the /voices API + picker UI, honoring the optional
// GEMINI_VOICES_AVAILABLE allow-list. label = the voice name; gender is left
// 'neutral' because Google doesn't officially publish it (tone is in `note`).
export function listGeminiVoices() {
  const allow = (process.env.GEMINI_VOICES_AVAILABLE || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const voices = allow.length
    ? GEMINI_VOICES.filter(v => allow.includes(v.id.toLowerCase()))
    : GEMINI_VOICES
  return voices.map(v => ({
    id: v.id,
    label: v.id,
    gender: v.gender || 'neutral',
    note: v.note,
  }))
}
