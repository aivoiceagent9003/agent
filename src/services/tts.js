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

// ─── Core fetch — used by deepgram.js prefetchTTS too ────────────────────────

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

// ─── Simple one-shot speak — used only for index.js direct calls ──────────────

export async function speakReply(twilioWs, streamSid, text) {
  try {
    console.log(`[TTS] Speaking (${detectLang(text)}): "${text}"`)
    const t0 = Date.now()

    const payload = await fetchTTSAudio(text)
    console.log(`[TTS] Synthesized in ${Date.now() - t0}ms`)

    if (twilioWs.readyState === 1) {
      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload }
      }))
    }

    const audioBuffer = Buffer.from(payload, 'base64')
    const playbackMs = Math.round((audioBuffer.length / 8000) * 1000)
    console.log(`[TTS] ✅ Sent (${Date.now() - t0}ms, ${audioBuffer.length}B / ${playbackMs}ms audio)`)

  } catch (err) {
    console.error('[TTS] Error:', err.message)
  }
}