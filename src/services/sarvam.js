// services/sarvam.js — Sarvam AI multilingual pipeline
// Handles:
//   1. STT via saaras:v3 REST (mulaw → PCM conversion for non-English audio)
//   2. Translation (any Indic language ↔ English) via sarvam-translate:v1
//   3. Language identification
//   4. Transliteration utilities
//
// The live call pipeline uses Deepgram for turn detection (reliable, low latency)
// and this module for accurate Indic language transcription + translation.

import 'dotenv/config'

const SARVAM_KEY = process.env.SARVAM_API_KEY
const SARVAM_BASE = 'https://api.sarvam.ai'

// ─── Language map ─────────────────────────────────────────────────────────────
// BCP-47 codes Sarvam supports for STT (saaras:v3)
export const SARVAM_STT_LANGS = {
  'hi': 'hi-IN',   // Hindi
  'te': 'te-IN',   // Telugu
  'ta': 'ta-IN',   // Tamil
  'kn': 'kn-IN',   // Kannada
  'ml': 'ml-IN',   // Malayalam
  'mr': 'mr-IN',   // Marathi
  'bn': 'bn-IN',   // Bengali
  'gu': 'gu-IN',   // Gujarati
  'pa': 'pa-IN',   // Punjabi
  'od': 'od-IN',   // Odia
  'en': 'en-IN',   // English (Indian accent)
  'unknown': 'unknown',  // auto-detect
}

// Languages Sarvam TTS (bulbul:v3) supports
export const SARVAM_TTS_LANGS = {
  'hi-IN': 'hi-IN', 'te-IN': 'te-IN', 'ta-IN': 'ta-IN',
  'kn-IN': 'kn-IN', 'ml-IN': 'ml-IN', 'mr-IN': 'mr-IN',
  'bn-IN': 'bn-IN', 'gu-IN': 'gu-IN', 'pa-IN': 'pa-IN',
  'od-IN': 'od-IN', 'en-IN': 'en-IN',
}

// Human-readable names (used for logs + UI)
export const LANG_NAMES = {
  'hi-IN': 'Hindi', 'te-IN': 'Telugu', 'ta-IN': 'Tamil',
  'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi',
  'bn-IN': 'Bengali', 'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi',
  'od-IN': 'Odia', 'en-IN': 'English',
}

// ─── Convert mulaw 8kHz → PCM 16kHz (for Sarvam STT) ─────────────────────────
// Twilio sends 8-bit mulaw at 8000 Hz. Sarvam STT expects PCM at 8kHz or 16kHz.
// We decode mulaw bytes → 16-bit PCM samples at 8kHz and wrap in a WAV header.
// No external library needed — mulaw decoding is a simple lookup table.

const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256)
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF
    const sign = u & 0x80
    const exp = (u >> 4) & 0x07
    let mantissa = (u & 0x0F) << 1
    mantissa += 33
    if (exp > 0) mantissa += 0x100
    if (exp > 1) mantissa <<= exp - 1
    table[i] = sign ? 33 - mantissa : mantissa - 33
  }
  return table
})()

function mulawToWav(mulawBuffer) {
  const sampleRate = 8000
  const numSamples = mulawBuffer.length
  const pcm = Buffer.alloc(numSamples * 2)

  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulawBuffer[i]], i * 2)
  }

  // WAV header
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)              // PCM chunk size
  header.writeUInt16LE(1, 20)               // PCM format
  header.writeUInt16LE(1, 22)               // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)  // byte rate
  header.writeUInt16LE(2, 32)               // block align
  header.writeUInt16LE(16, 34)              // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

// ─── STT via Sarvam saaras:v3 REST ───────────────────────────────────────────
// Transcribes a mulaw audio buffer using Sarvam's REST API (not WebSocket).
// Use this for a completed utterance — the audio buffer accumulated during the turn.
// Returns: { transcript, detected_language_code }
export async function transcribeWithSarvam(mulawBuffer, languageCode = 'unknown', prompt = '') {
  if (!SARVAM_KEY) throw new Error('SARVAM_API_KEY not set')
  if (!mulawBuffer || mulawBuffer.length === 0) return { transcript: '', detected_language_code: 'en-IN' }

  const wavBuffer = mulawToWav(mulawBuffer)
  const langCode = SARVAM_STT_LANGS[languageCode] || 'unknown'

  // Build + send one multipart request. `withPrompt` toggles the domain-vocab
  // hint — saaras may not accept it on every plan, so we can retry without it.
  async function send(withPrompt) {
    const boundary = `----SarvamBoundary${Date.now()}`
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsaaras:v3`,
      `--${boundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\n${langCode}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\ntranscribe`,
      `--${boundary}\r\nContent-Disposition: form-data; name="with_timestamps"\r\n\r\nfalse`,
      // Domain vocabulary hint — biases saaras toward our project names /
      // real-estate terms so spoken English proper nouns ("3BHK", "Akara") aren't
      // mangled into phonetic Telugu (which then translates to "Turbobike"/"sisters").
      ...(withPrompt && prompt
        ? [`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`]
        : []),
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ]

    const bodyParts = []
    for (const p of parts.slice(0, -1)) bodyParts.push(Buffer.from(p + '\r\n'))
    bodyParts.push(Buffer.from(parts[parts.length - 1]))
    bodyParts.push(wavBuffer)
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    return fetch(`${SARVAM_BASE}/speech-to-text`, {
      method: 'POST',
      headers: {
        'api-subscription-key': SARVAM_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat(bodyParts),
    })
  }

  let res = await send(true)
  // If the prompt field tripped a 4xx, retry once without it so Telugu STT still
  // works (just without the vocab bias) instead of failing the whole turn.
  if (!res.ok && prompt && res.status >= 400 && res.status < 500) {
    console.warn(`[SARVAM] STT ${res.status} with prompt — retrying without prompt`)
    res = await send(false)
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sarvam STT error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return {
    transcript: data.transcript || '',
    detected_language_code: data.language_code || 'en-IN',
  }
}

// ─── Translation via sarvam-translate:v1 ──────────────────────────────────────
// Translates text between any 22 Indian languages + English.
// Proper nouns (brand names, place names) are preserved by injecting them
// as untranslatable tokens and restoring them after translation.
export async function translateText(text, targetLang = 'en-IN', sourceLang = 'auto') {
  if (!SARVAM_KEY) throw new Error('SARVAM_API_KEY not set')
  if (!text?.trim()) return text
  if (sourceLang !== 'auto' && sourceLang === targetLang) return text

  // Protect tokens that must survive translation unchanged:
  //   - glossary terms, proper nouns
  //   - numbers with real-estate units (3BHK, 2.4 crore, 1200 sq ft, etc.)
  //   - standalone numbers and currency figures
  // Each is swapped for a NOUN<n> placeholder, restored after translation.
  const properNouns = []

  const glossaryTerms = (arguments[3] || [])  // optional string[]

  let protected_ = text

  // 1. Glossary terms (exact, case-insensitive)
  for (const term of glossaryTerms) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    protected_ = protected_.replace(regex, (match) => {
      const idx = properNouns.length
      properNouns.push(match)
      return `NOUN${idx}`
    })
  }

  // 2. Numbers + real-estate units (3BHK, 2.4 crore, 2,600 sq ft, ₹50L, etc.)
  // \d[\d,]* captures comma-formatted numbers like 2,600 or 1,00,000 as one token
  protected_ = protected_.replace(
    /\b\d[\d,]*(?:\.\d+)?\s*(?:BHK|bhk|crore|cr|lakh|lac|L|sqft|sq\.?\s*ft|sq\.?\s*yards?|acres?|km|sq\s*m)\b|\b\d+BHK\b|₹\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:cr|crore|L|lakh))?\b|\b\d[\d,]*(?:\.\d+)?\b/gi,
    (match) => {
      const idx = properNouns.length
      properNouns.push(match)
      return `NOUN${idx}`
    }
  )

  // 3. Capitalised proper nouns
  protected_ = protected_.replace(/\b([A-Z][a-zA-Z]{1,}(?:\s+[A-Z][a-zA-Z]{1,})*)\b/g, (match, _g, offset, full) => {
    const common = new Set(['My', 'I', 'The', 'A', 'An', 'This', 'That', 'What', 'How',
      'Can', 'Do', 'Is', 'Are', 'Will', 'Please', 'Tell', 'Hi', 'Hello', 'We', 'You',
      'Our', 'Your', 'Let', 'Yes', 'No', 'Ok', 'Sure'])
    const words = match.split(' ')

    // A SINGLE capitalised word at the start of a sentence is just grammatical
    // capitalisation (Could, Would, Thank, It, Expediting…), not a proper noun —
    // protecting it leaves English words leaking into the translation. Only treat
    // sentence boundaries (start of text or after . ! ?) as such, NOT commas, so
    // mid-sentence proper nouns like "ORD" still get protected.
    const before = full.slice(0, offset).replace(/\s+$/, '')
    const sentenceInitial = before === '' || /[.!?]$/.test(before)
    if (words.length === 1 && sentenceInitial) return match

    if (words.every(w => common.has(w))) return match
    const idx = properNouns.length
    properNouns.push(match)
    return `NOUN${idx}`
  })

  const res = await fetch(`${SARVAM_BASE}/translate`, {
    method: 'POST',
    headers: {
      'api-subscription-key': SARVAM_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: protected_,
      source_language_code: sourceLang,
      target_language_code: targetLang,
      speaker_gender: 'Female',
      // 'modern-colloquial' = natural spoken Indic without leaking common English
      // words ("Could", "Would", "please"). 'code-mixed' caused that leakage.
      // Proper nouns / numbers / tech terms are already protected via NOUN tokens.
      mode: 'modern-colloquial',
      model: 'mayura:v1',
      enable_preprocessing: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sarvam translate error ${res.status}: ${err}`)
  }

  const data = await res.json()
  let translated = data.translated_text || text

  // Restore protected proper nouns
  translated = translated.replace(/NOUN(\d+)/g, (_, idx) => properNouns[parseInt(idx)] || _)

  return translated
}

// ─── Language identification ───────────────────────────────────────────────────
// Identifies the language of a given text string.
// Returns: BCP-47 language code e.g. 'te-IN'
export async function identifyLanguage(text) {
  if (!SARVAM_KEY) throw new Error('SARVAM_API_KEY not set')
  if (!text?.trim()) return 'en-IN'

  const res = await fetch(`${SARVAM_BASE}/text-lid`, {
    method: 'POST',
    headers: {
      'api-subscription-key': SARVAM_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: text }),
  })

  if (!res.ok) return 'en-IN'  // fall back gracefully

  const data = await res.json()
  return data.language_code || 'en-IN'
}

// ─── Transliteration ──────────────────────────────────────────────────────────
// Converts text between scripts — e.g. "namaste" → "नमस्ते" or vice versa.
// Useful for displaying Indian names in their native script.
export async function transliterate(text, sourceScript = 'en-IN', targetScript = 'hi-IN') {
  if (!SARVAM_KEY) throw new Error('SARVAM_API_KEY not set')
  if (!text?.trim()) return text

  const res = await fetch(`${SARVAM_BASE}/transliterate`, {
    method: 'POST',
    headers: {
      'api-subscription-key': SARVAM_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      source_language_code: sourceScript,
      target_language_code: targetScript,
      numerals_format: 'international',
    }),
  })

  if (!res.ok) return text
  const data = await res.json()
  return data.transliterated_text || text
}

// ─── Codemix helper ───────────────────────────────────────────────────────────
// Converts natural transliterated text (Hinglish, Tenglish etc.) into proper
// mixed script. E.g. "mujhe ek 3BHK chahiye Kokapet mein" →
// "मुझे एक 3BHK चाहिए Kokapet में"
// Uses saaras:v3 codemix mode via the STT REST API (pass text-as-audio workaround)
// In practice — use translateText() for most cases instead.
export async function codemixNormalise(text, lang = 'hi-IN') {
  if (!text?.trim()) return text
  // Simple heuristic: if text is already in script, return as-is
  const hasIndic = /[\u0900-\u097F\u0C00-\u0C7F\u0B80-\u0BFF\u0C80-\u0CFF\u0D00-\u0D7F\u0980-\u09FF]/.test(text)
  if (hasIndic) return text
  // Transliterate from Latin to target script
  return transliterate(text, 'en-IN', lang)
}