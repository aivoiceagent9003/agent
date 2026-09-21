// tts.js — Sarvam text-to-speech. The ONLY remaining use of TTS is the campaign
// platform's "Template Call" type (a pre-rendered spoken message, no conversation):
// services/campaigns/broadcast.js renders a template to μ-law audio via fetchTTSAudio.
// Live AI calls do NOT use this — they run the Soniox cascade, which has its own TTS.

import 'dotenv/config'

// ─── Language Detection ───────────────────────────────────────────────────────

const SARVAM_LANG = {
  en: 'en-IN', hi: 'hi-IN', te: 'te-IN',
  ta: 'ta-IN', kn: 'kn-IN', ml: 'ml-IN',
  mr: 'mr-IN', bn: 'bn-IN',
}

function detectLang(text) {
  if (/[ఀ-౿]/.test(text)) return 'te'
  if (/[ऀ-ॿ]/.test(text)) return 'hi'
  if (/[஀-௿]/.test(text)) return 'ta'
  if (/[ಀ-೿]/.test(text)) return 'kn'
  if (/[ഀ-ൿ]/.test(text)) return 'ml'
  if (/[ঀ-৿]/.test(text)) return 'bn'
  return 'en'
}

// ─── Render text → base64 μ-law 8k (used by campaign Template Calls) ─────────

export async function fetchTTSAudio(text) {
  const langCode = detectLang(text)
  const targetLang = SARVAM_LANG[langCode] ?? 'en-IN'

  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      target_language_code: targetLang,
      model: 'bulbul:v3',
      speaker: 'priya',
      speech_sample_rate: 8000,
      output_audio_codec: 'mulaw',
    }),
  })

  const data = await res.json()
  if (!data.audios?.[0]) throw new Error(`Sarvam TTS error: ${JSON.stringify(data)}`)
  return data.audios[0]  // base64 mulaw string
}