import WebSocket from 'ws'
import https from 'https'
import 'dotenv/config'
import { streamAIReply, warmupLLM, getHistory } from './llm.js'
import {
  detectHandoffKeyword,
  detectHandoffSignal,
  stripHandoffSignal,
  transferToHuman,
} from './handoff.js'
import { retrieveKnowledge, warmupRAG } from './rag.js'
import { transcribeWithSarvam, translateText, LANG_NAMES } from './sarvam.js'

// ─── Language Detection (for TTS language selection) ──────────────────────────

const SARVAM_LANG = {
  en: 'en-IN', hi: 'hi-IN', te: 'te-IN',
  ta: 'ta-IN', kn: 'kn-IN', ml: 'ml-IN',
  mr: 'mr-IN', bn: 'bn-IN',
}

// Detect the DOMINANT language. Defaults to English unless a non-Latin
// script CLEARLY dominates (more than 60% of the alphabetic characters).
// This stops a 1-2 word name in another script from flipping an English
// sentence — a real Hindi/Telugu sentence is overwhelmingly non-Latin.
function detectLang(text) {
  const scripts = {
    te: (text.match(/[ఀ-౿]/g) || []).length,
    hi: (text.match(/[ऀ-ॿ]/g) || []).length,
    ta: (text.match(/[஀-௿]/g) || []).length,
    kn: (text.match(/[ಀ-೯]/g) || []).length,
    ml: (text.match(/[ഀ-ൿ]/g) || []).length,
    bn: (text.match(/[ঀ-৿]/g) || []).length,
  }
  const en = (text.match(/[a-zA-Z]/g) || []).length

  // Find the strongest non-Latin script
  let bestLang = null
  let bestCount = 0
  for (const [lang, count] of Object.entries(scripts)) {
    if (count > bestCount) {
      bestCount = count
      bestLang = lang
    }
  }

  const total = en + bestCount
  if (total === 0) return 'en'

  // Only switch to the non-Latin language if it dominates (>60% of letters).
  // Otherwise it's English with a foreign name sprinkled in → stay English.
  if (bestLang && bestCount / total > 0.6) {
    return bestLang
  }

  return 'en'
}

// ─── Silence Thresholds ───────────────────────────────────────────────────────
// Deepgram has built-in endpointing — UtteranceEnd is the PRIMARY turn-end signal.
// FALLBACK is a safety net for when UtteranceEnd misses; kept moderate so a
// missed UtteranceEnd doesn't leave the caller waiting too long.
const FALLBACK_SILENCE = 1800  // ms — generous so it rarely beats Deepgram's own final
// Silence window for interim-based turn end. Resets on every new interim, so it
// measures silence SINCE THE LAST WORD. Long enough to survive mid-sentence
// pauses, short enough to feel responsive once the caller truly stops.
const SILENCE_MS = 2500

// ─── PCM16LE → mulaw encoder (Twilio needs mulaw 8kHz) ───────────────────────
// ITU-T G.711 standard mulaw encoder with amplitude normalization.
// Normalizes quiet audio to 70% of full scale before encoding so mulaw
// quantization noise stays inaudible relative to the signal.
function pcmToMulaw(pcmBuf) {
  const samples = pcmBuf.length >> 1

  // Find peak amplitude
  let peak = 0
  for (let i = 0; i < samples; i++) {
    const v = Math.abs(pcmBuf.readInt16LE(i << 1))
    if (v > peak) peak = v
  }

  // Boost to 80% of full scale if audio is below that level (boost only, never cut)
  const TARGET = 26213  // 0.8 × 32767
  const gain = (peak > 0 && peak < TARGET) ? TARGET / peak : 1.0

  const out = Buffer.alloc(samples)
  for (let i = 0; i < samples; i++) {
    let s = Math.round(pcmBuf.readInt16LE(i << 1) * gain)
    if (s > 32635) s = 32635
    else if (s < -32635) s = -32635
    const sign = s < 0 ? 0x80 : 0
    if (s < 0) s = -s
    s += 132                                                          // G.711 bias
    let exp = 7
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    const mantissa = (s >> (exp + 3)) & 0x0F
    out[i] = ~(sign | (exp << 4) | mantissa) & 0xFF
  }
  return out
}

// ─── Smallest AI TTS (HTTP streaming, PCM→mulaw) ─────────────────────────────

// Waves API uses ISO language codes (not full names)
const SMALLEST_LANG_CODES = {
  te: 'te', hi: 'hi', ta: 'ta', kn: 'kn',
  ml: 'ml', mr: 'mr', bn: 'bn', gu: 'gu',
  pa: 'pa', en: 'en',
}

// Voice IDs for Waves model (sameera=Indian English, padmaja=Telugu)
const SMALLEST_VOICES = {
  te: process.env.SMALLEST_VOICE_TE || process.env.SMALLEST_VOICE || 'padmaja',
  hi: process.env.SMALLEST_VOICE_HI || process.env.SMALLEST_VOICE || 'sameera',
  ta: process.env.SMALLEST_VOICE_TA || process.env.SMALLEST_VOICE || 'sameera',
  kn: process.env.SMALLEST_VOICE_KN || process.env.SMALLEST_VOICE || 'sameera',
  ml: process.env.SMALLEST_VOICE_ML || process.env.SMALLEST_VOICE || 'sameera',
  en: process.env.SMALLEST_VOICE_EN || process.env.SMALLEST_VOICE || 'sameera',
}

// ─── TTS audio cache ─────────────────────────────────────────────────────────
// The greeting and the short fillers are byte-for-byte identical on every call,
// yet each was costing a fresh ~600-2100ms synth round-trip. Cache the finished
// mulaw so repeated short phrases play instantly. Only short, reusable phrases
// are cached (greeting ~62 chars, fillers ~8) — long per-call sentences are
// unique, so caching them would just waste memory.
const TTS_CACHE = new Map()        // key: `${voiceId}|${language}|${text}` → mulaw Buffer
const TTS_CACHE_MAX = 200          // bound memory (LRU-ish: oldest evicted first)
const TTS_CACHE_MAXLEN = 120       // only cache phrases this short (greeting + fillers)

class SmallestAITTSClient {
  constructor(apiKey, voice) {
    this.apiKey = apiKey
    // Tenant-chosen voice. When set, it overrides the per-language default map for
    // every language. When null, fall back to SMALLEST_VOICES per language.
    this.voice = (voice || '').trim() || null
    this.totalBytes = 0
    this.firstChunkTime = null
    this.startTime = null
    this._chain = Promise.resolve()
    this.speaker = this.voice || SMALLEST_VOICES.en  // compat field used by REST fallback check
  }

  speak(text, onChunk, forceLang) {
    const run = () => this._speakNow(text, onChunk, forceLang)
    this._chain = this._chain.then(run, run)
    return this._chain
  }

  // Pre-synthesize a phrase into the cache WITHOUT going through _chain, so it
  // never blocks/delays a real speak() (e.g. the greeting). Used at call start
  // to warm the connection and pre-cache fillers. Best-effort.
  async warmup(text, forceLang) {
    try { await smallestSynth(this.apiKey, text, forceLang, this.voice) } catch { /* ignore */ }
  }

  async _speakNow(text, onChunk, forceLang) {
    this.totalBytes = 0
    this.firstChunkTime = null
    this.startTime = Date.now()

    const mulaw = await smallestSynth(this.apiKey, text, forceLang, this.voice)

    this.firstChunkTime = Date.now()
    this.totalBytes = mulaw.length
    if (onChunk) onChunk(mulaw)

    const playbackMs = Math.round((this.totalBytes / 8000) * 1000)
    console.log(`[TTS] ✅ Done | ${this.totalBytes}B | ${playbackMs}ms audio`)
    return playbackMs
  }

  connect() {}  // no-op — HTTP is stateless
  close() {}
}

// Module-level synth: cache-check → Waves HTTP → mulaw → cache-set. Holds no
// per-call state, so it's safe to run concurrently (warmup alongside a real
// speak) without clobbering instance fields used for playback timing.
async function smallestSynth(apiKey, text, forceLang, forceVoice) {
  const langCode = forceLang || detectLang(text)
  const voiceId = forceVoice || SMALLEST_VOICES[langCode] || SMALLEST_VOICES.en
  const language = SMALLEST_LANG_CODES[langCode] || 'en'

  const cacheable = text.length <= TTS_CACHE_MAXLEN
  const cacheKey = `${voiceId}|${language}|${text}`
  if (cacheable && TTS_CACHE.has(cacheKey)) {
    const cached = TTS_CACHE.get(cacheKey)
    TTS_CACHE.delete(cacheKey); TTS_CACHE.set(cacheKey, cached)  // refresh LRU recency
    console.log(`[TTS] ⚡ cache hit "${text.slice(0, 24)}" | ${cached.length}B`)
    return cached
  }

  const t0 = Date.now()
  console.log(`[TTS] Smallest AI Waves → voice:${voiceId} lang:${language}`)

  // Waves /api/v1/tts — returns raw PCM16LE (no WAV header)
  const postData = JSON.stringify({ text, voice_id: voiceId, sample_rate: 8000, language })

  const pcmBuf = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'waves-api.smallest.ai',
      path: '/api/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => reject(new Error(`Smallest AI Waves ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0,200)}`)))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })

    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Smallest AI Waves timeout')) })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })

  if (pcmBuf.length === 0) throw new Error('Smallest AI Waves: empty response')
  console.log(`[TTS] 🔊 Audio ready in ${Date.now() - t0}ms | PCM: ${pcmBuf.length}B`)

  // Response is raw PCM16LE — convert directly to mulaw
  const mulaw = pcmToMulaw(pcmBuf)

  // Cache short, reusable phrases so the next call replays them instantly.
  if (cacheable) {
    TTS_CACHE.set(cacheKey, mulaw)
    if (TTS_CACHE.size > TTS_CACHE_MAX) {
      TTS_CACHE.delete(TTS_CACHE.keys().next().value)  // evict oldest
    }
  }

  return mulaw
}

// ─── Sarvam WebSocket TTS ────────────────────────────────────────────────────

const TTS_WS_URL = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`

class SarvamTTSClient {
  constructor(apiKey, speaker = 'priya') {
    this.apiKey = apiKey
    this.speaker = speaker      // configurable voice (per tenant)
    this.ws = null
    this.currentLang = null
    this.currentResolve = null
    this.currentReject = null
    this.totalBytes = 0
    this.firstChunkTime = null
    this.startTime = null
    this._onChunk = null
    this._chain = Promise.resolve()  // serializes concurrent speak() calls
  }

  async connect(langCode) {
    const targetLang = SARVAM_LANG[langCode] ?? 'en-IN'

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentLang === langCode) {
      return
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(TTS_WS_URL, {
        headers: { 'api-subscription-key': this.apiKey }
      })

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'config',
          data: {
            target_language_code: targetLang,
            speaker: this.speaker,    // configurable per tenant (defaults to priya)
            speech_sample_rate: 8000,
            output_audio_codec: 'mulaw',
            pace: 1.15,               // slightly faster than default for natural conversational speed
            temperature: 0.7,         // a touch higher = more expressive/human prosody
          }
        }))
        this.ws = ws
        this.currentLang = langCode
        console.log(`[TTS WS] Connected (${targetLang}) ✅`)
        resolve()
      })

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())

          if (msg.type === 'audio' && msg.data?.audio) {
            const chunk = Buffer.from(msg.data.audio, 'base64')
            if (!this.firstChunkTime && this.startTime) {
              this.firstChunkTime = Date.now()
              console.log(`[TTS] 🔊 First chunk in ${this.firstChunkTime - this.startTime}ms`)
            }
            this.totalBytes += chunk.length
            if (this._onChunk) this._onChunk(chunk)
          }

          if (msg.type === 'event' && msg.data?.event_type === 'final') {
            const playbackMs = Math.round((this.totalBytes / 8000) * 1000)
            console.log(`[TTS] ✅ Done | ${this.totalBytes}B | ${playbackMs}ms audio`)
            if (this.currentResolve) {
              this.currentResolve(playbackMs)
              this.currentResolve = null
              this.currentReject = null
            }
          }
        } catch { /* ignore */ }
      })

      ws.on('error', (err) => {
        console.error('[TTS WS] Error:', err.message)
        this.ws = null
        if (this.currentReject) {
          this.currentReject(err)
          this.currentResolve = null
          this.currentReject = null
        }
        reject(err)
      })

      ws.on('close', () => {
        console.log('[TTS WS] Closed')
        this.ws = null
        if (this.currentReject) {
          if (this.totalBytes > 0 && this.currentResolve) {
            const playbackMs = Math.round((this.totalBytes / 8000) * 1000)
            this.currentResolve(playbackMs)
          } else {
            this.currentReject(new Error('TTS WS closed'))
          }
          this.currentResolve = null
          this.currentReject = null
        }
      })
    })
  }

  // Public speak — serializes calls so two sentences never share the socket
  // at the same time (which would overwrite currentResolve and hang the queue).
  speak(text, onChunk, forceLang) {
    const run = () => this._speakNow(text, onChunk, forceLang)
    // Chain this call after the previous one finishes (success OR failure)
    this._chain = this._chain.then(run, run)
    return this._chain
  }

  async _speakNow(text, onChunk, forceLang) {
    // Use the forced language (locked per turn) if given, else detect per text
    const langCode = forceLang || detectLang(text)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.currentLang !== langCode) {
      await this.connect(langCode)
    }

    this.totalBytes = 0
    this.firstChunkTime = null
    this.startTime = Date.now()
    this._onChunk = onChunk

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.currentReject) return
        this.currentReject(new Error('TTS WS response timeout'))
        this.currentResolve = null
        this.currentReject = null
      }, 12000)
      this.currentResolve = resolve
      this.currentReject = reject
      this.currentResolve = (value) => {
        clearTimeout(timeout)
        resolve(value)
      }
      this.currentReject = (err) => {
        clearTimeout(timeout)
        reject(err)
      }
      this.ws.send(JSON.stringify({ type: 'text', data: { text } }))
      this.ws.send(JSON.stringify({ type: 'flush' }))
    })
  }

  close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

function normalizeTTSLang(langOrText, textFallback = '') {
  if (Object.values(SARVAM_LANG).includes(langOrText)) return langOrText
  if (SARVAM_LANG[langOrText]) return SARVAM_LANG[langOrText]
  return SARVAM_LANG[detectLang(textFallback || langOrText || '')] ?? 'en-IN'
}

async function fetchTTSAudioRest(text, langCode, speaker = 'priya') {
  const targetLang = normalizeTTSLang(langCode, text)
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
      speaker,
      speech_sample_rate: 8000,
      output_audio_codec: 'mulaw',
    }),
  })

  const data = await res.json()
  if (!data.audios?.[0]) throw new Error(`Sarvam REST TTS error: ${JSON.stringify(data)}`)
  return Buffer.from(data.audios[0], 'base64')
}

// Replace Arabic digits with English words so Indic TTS doesn't read them
// in the local language (e.g. "3" → "moodu" in Telugu, "teen" in Hindi).
// Applied to translated text just before TTS — never to raw transcripts.
function spokenNumerals(text) {
  const ones = ['zero','one','two','three','four','five','six','seven','eight','nine',
    'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
  const tens_ = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']
  function n2w(n) {
    n = parseInt(String(n).replace(/,/g, ''), 10)
    if (isNaN(n)) return String(n)
    if (n < 20) return ones[n]
    if (n < 100) return tens_[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '')
    if (n < 1000) return ones[Math.floor(n/100)] + ' hundred' + (n%100 ? ' ' + n2w(n%100) : '')
    if (n < 100000) return n2w(Math.floor(n/1000)) + ' thousand' + (n%1000 ? ' ' + n2w(n%1000) : '')
    return String(n)
  }
  return text
    // "2.4 crore" / "2.4 lakh" → "two point four crore"
    .replace(/\b([0-9])\.([0-9])\s*(crore|lakh|cr|L)\b/gi,
      (_, i, d, u) => `${ones[+i]} point ${ones[+d]} ${u}`)
    // "3 crore" / "5 lakh" → "three crore" / "five lakh"
    .replace(/\b([0-9])\s*(crore|lakh|cr|L)\b/gi,
      (_, n, u) => `${ones[+n]} ${u}`)
    // "3BHK" → "three BHK"
    .replace(/\b([0-9])(BHK)\b/gi,
      (_, n, u) => `${ones[+n]} ${u.toUpperCase()}`)
    // comma-formatted numbers: 2,600 → "two thousand six hundred"
    .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => n2w(m))
    // remaining multi-digit numbers: 2600, 65 → words
    .replace(/\b([0-9]{2,})\b/g, (_, n) => n2w(n))
    // lone digit
    .replace(/\b([0-9])\b/g, (_, n) => ones[+n])
}

async function streamTTSToTwilio(text, twilioWs, streamSid, ttsClient, forceLang, isCancelled) {
  const CHUNK_SIZE = 320
  let leftover = Buffer.alloc(0)

  const onChunk = (chunk) => {
    if (twilioWs.readyState !== 1) return
    if (isCancelled && isCancelled()) return  // barge-in: stop sending audio
    const combined = Buffer.concat([leftover, chunk])
    let offset = 0
    while (offset + CHUNK_SIZE <= combined.length) {
      const piece = combined.slice(offset, offset + CHUNK_SIZE)
      twilioWs.send(JSON.stringify({
        event: 'media', streamSid,
        media: { payload: piece.toString('base64') }
      }))
      offset += CHUNK_SIZE
    }
    leftover = combined.slice(offset)
  }

  let playbackMs
  try {
    playbackMs = await ttsClient.speak(text, onChunk, forceLang)
  } catch (e) {
    console.warn(`[TTS] Failed: ${e.message}`)
    if (ttsClient instanceof SarvamTTSClient) {
      // Sarvam WS failed — fall back to Sarvam REST
      leftover = Buffer.alloc(0)
      const audio = await fetchTTSAudioRest(text, forceLang, ttsClient.speaker)
      onChunk(audio)
      playbackMs = Math.round((audio.length / 8000) * 1000)
    } else {
      throw e  // Smallest AI REST already failed — nothing to fall back to
    }
  }

  if (leftover.length > 0 && twilioWs.readyState === 1 && !(isCancelled && isCancelled())) {
    twilioWs.send(JSON.stringify({
      event: 'media', streamSid,
      media: { payload: leftover.toString('base64') }
    }))
  }

  return playbackMs
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function createDeepgramConnection(callSid, tenantConfig, twilioWs, streamSid, onTranscript, onReady, callerNumber) {
  let isBusy = false
  let handoffTriggered = false  // once true, no more turns — call is transferring
  let isAgentSpeaking = false
  let speakCooldownUntil = 0
  let pendingTranscript = null
  let finished = false
  let dgWs = null
  let dgReady = false
  let latestTranscript = ''
  let interimText = ''  // tracks latest interim result (used if no final arrives)
  let lastFiredAt = 0   // timestamp of last fireFinal — suppresses duplicate triggers
  let firstTurnDone = false  // Deepgram's endpointing is flaky on the FIRST utterance only
  let endSpeechTimer = null
  let interimSafetyTimer = null  // last-resort timer for interim-only speech
  let vadFallbackTimer = null    // fires when VAD detected speech but Deepgram produced nothing
  let lastSpeechStartedAt = 0   // timestamp of last SpeechStarted — used by VAD fallback
  let currentTurnAudio = []     // accumulates mulaw chunks for the current turn (Sarvam STT)
  let keepAliveTimer = null
  let sessionLang = 'en-IN'     // persists detected language across turns — never resets mid-call
  let echoProtectionUntil = 0   // suppress VAD fallbacks until agent's audio tail finishes playing
  let consecutiveEnglishTurns = 0 // require 2 in a row before flipping an Indic session to English

  // ── Barge-in state ──────────────────────────────────────────────────────────
  let bargeInRequested = false  // set true when caller interrupts agent speech
  let ttsCancelled = false      // tells the TTS queue/consumer to stop streaming

  const ttsProvider = (process.env.TTS_PROVIDER || 'sarvam').toLowerCase()
  let ttsClient
  if (ttsProvider === 'smallest') {
    const chosenVoice = (tenantConfig.voice || '').trim() || null
    console.log(`[TTS] Provider: Smallest AI${chosenVoice ? ` (voice: ${chosenVoice})` : ''}`)
    ttsClient = new SmallestAITTSClient(process.env.SMALLEST_AI_API_KEY, chosenVoice)
  } else {
    const VALID_V3_VOICES = ['priya', 'ritu', 'neha', 'kavya', 'shreya', 'simran',
      'pooja', 'roopa', 'ishita', 'aditya', 'rohan', 'kabir', 'dev', 'rahul']
    const chosenVoice = VALID_V3_VOICES.includes(tenantConfig.voice) ? tenantConfig.voice : 'priya'
    console.log('[TTS] Provider: Sarvam')
    ttsClient = new SarvamTTSClient(process.env.SARVAM_API_KEY, chosenVoice)
  }

  // Warm up the embedding model in the background so the first RAG query
  // isn't a ~3s cold start. Fire-and-forget; no await.
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
    warmupRAG()
  }
  // Warm up the LLM too — first completion is otherwise a ~1.7s cold start.
  warmupLLM()

  // Warm up TTS in the background: pre-synthesize the short fillers into the
  // cache so the FIRST user turn's filler plays instantly (otherwise it's a
  // ~600ms cold synth on the critical path), and so the HTTPS connection to the
  // provider is already warm. Fire-and-forget — never blocks the greeting.
  if (ttsClient instanceof SmallestAITTSClient) {
    // Fillers are always spoken in English now, so warm them in the English voice.
    const fillers = tenantConfig.filler_phrases || [
      'Please wait a moment sir, let me check that for you.',
      'Sure sir, let me find that information for you.',
      'Just a moment please, I am looking that up now.',
      'One moment sir, let me pull up those details.',
      'Let me check that for you sir, just a second.',
    ]
    for (const p of fillers) {
      ttsClient.warmup(p, 'en')  // chain-free — never delays the greeting
    }
  }

  // ─── Domain vocabulary (shared by Deepgram keyterms + Sarvam STT prompt) ────
  // Priming both recognisers with project names + real-estate terms keeps spoken
  // English proper nouns ("3BHK", "Akara", "Kokapet") from being mangled — Deepgram
  // keeps them in Latin; Sarvam keeps them recognisable instead of turning "Akara"
  // into phonetic Telugu that translates to "sisters".
  const domainTerms = tenantConfig.stt_keyterms || [
    'Kokapet', 'Tellapur', 'Kollur', 'Gachibowli', 'Hyderabad',
    'BHK', '2BHK', '3BHK', 'crore', 'lakh', 'RERA', 'clubhouse', 'square feet',
    'My Home Apas', 'My Home Akara', 'My Home Tarkshya',
    'My Home 99', 'My Home Vihanga', 'My Home Bhooja',
  ]
  // Sarvam's prompt biases recognition toward these terms (comma-separated phrase).
  const sarvamPrompt = domainTerms.join(', ')

  // ─── Deepgram STT — persistent, reliable streaming ─────────────────────────
  // Deepgram takes raw mulaw 8kHz directly (no upsampling/WAV needed).
  // It has rock-solid persistent connections and built-in endpointing.

  function connectDeepgram() {
    if (finished || dgWs) return

    // Deepgram params:
    // - nova-2 model, multi-language (handles en + hi well; Indian English strong)
    // - encoding=mulaw, sample_rate=8000 — matches Twilio exactly, no conversion
    // - endpointing=300 — Deepgram detects end of speech after 300ms silence
    // - interim_results — get partials + finals
    // - utterance_end_ms — fires UtteranceEnd event for clean turn detection
    // English-first mode: keeps English proper nouns (place names, BHK) in
    // Latin script instead of mangling them into Devanagari. Hinglish still
    // works — Hindi words in an English sentence get romanized.
    // Keyterm Prompting primes Nova-3 with our domain vocabulary so it
    // transcribes venture names and real-estate terms correctly.
    const keytermParams = domainTerms.map(k => `&keyterm=${encodeURIComponent(k)}`).join('')

    const url =
      `wss://api.deepgram.com/v1/listen?` +
      `model=nova-3` +
      `&language=en` +
      `&encoding=mulaw` +
      `&sample_rate=8000` +
      `&channels=1` +
      `&interim_results=true` +
      `&endpointing=500` +
      `&utterance_end_ms=1000` +
      `&vad_events=true` +
      `&smart_format=true` +
      keytermParams

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    })

    ws.on('open', () => {
      console.log('[Deepgram STT] Connected ✅ (persistent)')
      dgWs = ws
      dgReady = true
      latestTranscript = ''
      if (onReady) onReady()

      // Keep-alive ping every 8s — Deepgram closes idle connections after 10s
      keepAliveTimer = setInterval(() => {
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, 8000)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        // ── Transcript results (interim + final) ─────────────────────────────
        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0]
          const transcript = alt?.transcript?.trim()
          const isFinal = msg.is_final
          const speechFinal = msg.speech_final  // Deepgram: speaker actually stopped

          // Echo guard — ignore everything while agent audio is playing.
          // (Barge-in was removed: it caused interrupted speech to get stuck
          // and not be processed as the next turn.)
          if (isAgentSpeaking) return
          if (!transcript) return

          // Deepgram is actively transcribing — reset VAD fallback so it fires
          // 2500ms from the LAST recognized word, not from SpeechStarted.
          // This prevents early cutoff when a sentence takes more than 2.5s to speak.
          if (vadFallbackTimer) {
            clearTimeout(vadFallbackTimer)
            vadFallbackTimer = setTimeout(() => {
              vadFallbackTimer = null
              if (isBusy || isAgentSpeaking || finished) return
              if (Date.now() - lastFiredAt < 2000) return
              if (Date.now() - lastSpeechStartedAt < 1000) return
              const dgWords = (latestTranscript || interimText).trim().split(/\s+/).filter(Boolean).length
              if (Date.now() < echoProtectionUntil && dgWords < 3) {
                // Suppress ONLY when Deepgram has no real words — that's echo. If
                // Deepgram captured a clear interim (≥3 words), it's the caller
                // speaking, so let it through instead of dropping the turn.
                console.log('[STT] VAD fallback suppressed — echo window from long response')
                return
              }
              const audioSize = currentTurnAudio.reduce((s, c) => s + c.length, 0)
              if (audioSize < 8000 && dgWords < 3) return
              console.log(`[STT] 🔇 VAD fallback: ${audioSize}B audio, dgWords=${dgWords} — firing`)
              fireFinal('')
            }, 2500)
          }

          if (isFinal) {
            // Commit this final chunk to the utterance
            latestTranscript = latestTranscript
              ? `${latestTranscript} ${transcript}`
              : transcript
            interimText = ''  // committed now, clear interim
            console.log(`[STT] 📝 "${transcript}"`)
            console.log(`[STT] 📋 Full: "${latestTranscript}"`)

            // speech_final = speaker stopped → fire immediately (most reliable)
            if (speechFinal) {
              clearTimeout(endSpeechTimer)
              clearTimeout(interimSafetyTimer)
              const text = latestTranscript
              latestTranscript = ''
              // Dedup: skip if we fired the same utterance moments ago (fallback race)
              if (Date.now() - lastFiredAt < 2500) {
                console.log('[STT] (skipped duplicate speech_final)')
                return
              }
              lastFiredAt = Date.now()
              console.log(`[STT] ✅ speech_final: "${text}"`)
              fireFinal(text)
              return
            }
          } else {
            // Interim result — track it, don't commit yet.
            // Log it so real-time recognition is visible (these arrive within
            // ~100-300ms of speech; the committed final comes after you pause).
            interimText = transcript
            console.log(`[STT] … "${transcript}"`)  // interim (live partial)
          }

          // ── First-turn-only safety net ─────────────────────────────────────
          // Deepgram's endpointing is unreliable on the VERY FIRST utterance.
          // Reset on every interim/final. Fires when 2s of silence follows the
          // last word. Also arms when there is ONLY audio and no Deepgram words
          // (pure non-English speech) — Sarvam will transcribe the audio.
          if (!firstTurnDone) {
            clearTimeout(interimSafetyTimer)
            const hasAudio = currentTurnAudio.reduce((s, c) => s + c.length, 0) >= 3000
            if (interimText.length > 0 || latestTranscript.length > 0 || hasAudio) {
              interimSafetyTimer = setTimeout(() => {  // 3000ms gives Deepgram time to finalize "Kokapet"-style trailing words
                const text = (latestTranscript || interimText).trim()
                const audioSize = currentTurnAudio.reduce((s, c) => s + c.length, 0)
                if (!text && audioSize < 3000) return
                latestTranscript = ''
                interimText = ''
                if (Date.now() - lastFiredAt < 2500) return
                lastFiredAt = Date.now()
                if (text) {
                  console.log(`[STT] ⏱️ FIRST-TURN-SAFETY: "${text}"`)
                } else {
                  console.log(`[STT] ⏱️ FIRST-TURN-SAFETY: no Deepgram text, ${audioSize}B audio — Sarvam will transcribe`)
                }
                fireFinal(text)
              }, 3000)
            }
          }
        }

        // ── UtteranceEnd — Deepgram's clean "caller finished" signal ──────────
        // Fires after ~1s of silence. This is our reliable backstop: it uses
        // the committed final if present, otherwise the last interim (covers
        // the rare case where Deepgram never committed a final). Because it
        // only fires after Deepgram itself detects end-of-speech, it won't cut
        // the caller off mid-sentence.
        if (msg.type === 'UtteranceEnd') {
          if (isAgentSpeaking) return
          const text = (latestTranscript || interimText).trim()
          const audioSize = currentTurnAudio.reduce((s, c) => s + c.length, 0)
          // Fire even with no Deepgram text if there is enough audio —
          // caller may have spoken a non-English language Deepgram couldn't
          // transcribe; Sarvam will handle it in handleUserTurn.
          if (text || audioSize >= 3000) {
            clearTimeout(endSpeechTimer)
            latestTranscript = ''
            interimText = ''
            if (Date.now() - lastFiredAt < 2500) {
              console.log('[STT] (skipped duplicate UtteranceEnd)')
              return
            }
            lastFiredAt = Date.now()
            if (text) {
              console.log(`[STT] ✅ UtteranceEnd: "${text}"`)
            } else {
              console.log(`[STT] UtteranceEnd: no Deepgram text, ${audioSize}B audio — Sarvam will transcribe`)
            }
            fireFinal(text)
          }
        }

        if (msg.type === 'SpeechStarted') {
          if (!isAgentSpeaking) {
            console.log('[STT] 🎤 Speech started')
            lastSpeechStartedAt = Date.now()
            // VAD fallback: if Deepgram produces no transcript within 2.5s
            // (e.g. caller speaks only Telugu/Hindi and Deepgram can't recognise it),
            // fire the turn with whatever audio is in the buffer — Sarvam will
            // transcribe it. Reset on each new SpeechStarted so we don't cut the
            // caller off mid-sentence.
            clearTimeout(vadFallbackTimer)
            vadFallbackTimer = setTimeout(() => {
              vadFallbackTimer = null
              if (isBusy || isAgentSpeaking || finished) return
              if (Date.now() - lastFiredAt < 2000) return  // turn already fired recently
              if (Date.now() - lastSpeechStartedAt < 1000) return  // still speaking
              const dgWords = (latestTranscript || interimText).trim().split(/\s+/).filter(Boolean).length
              if (Date.now() < echoProtectionUntil && dgWords < 3) {
                // Suppress ONLY when Deepgram has no real words — that's echo. If
                // Deepgram captured a clear interim (≥3 words), it's the caller
                // speaking, so let it through instead of dropping the turn.
                console.log('[STT] VAD fallback suppressed — echo window from long response')
                return
              }
              const audioSize = currentTurnAudio.reduce((s, c) => s + c.length, 0)
              if (audioSize < 8000 && dgWords < 3) return  // need ~1s audio OR clear words
              console.log(`[STT] 🔇 VAD fallback: ${audioSize}B audio, dgWords=${dgWords} — firing`)
              fireFinal('')
            }, 2500)
          }
        }

      } catch { /* ignore parse errors */ }
    })

    ws.on('error', (err) => {
      console.error(`[Deepgram STT] Error: ${err.message}`)
      dgWs = null
      dgReady = false
      clearInterval(keepAliveTimer)
      if (!finished) setTimeout(connectDeepgram, 1000)
    })

    ws.on('close', (code) => {
      dgWs = null
      dgReady = false
      clearInterval(keepAliveTimer)
      clearTimeout(endSpeechTimer)
      if (!finished) {
        console.log(`[Deepgram STT] Closed (${code}) — reconnecting`)
        setTimeout(connectDeepgram, 200)
      }
    })
  }

  function disconnectDeepgram() {
    if (dgWs) {
      // Send CloseStream for clean shutdown
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'CloseStream' }))
      }
      dgWs.close()
      dgWs = null
    }
    dgReady = false
    clearInterval(keepAliveTimer)
    clearTimeout(endSpeechTimer)
  }

  // ─── Turn Logic ────────────────────────────────────────────────────────────

  function fireFinal(transcript) {
    // Allow empty transcript through only when there is accumulated audio —
    // handleUserTurn will send it to Sarvam STT for non-English speech.
    const audioSize = currentTurnAudio.reduce((s, c) => s + c.length, 0)
    if (!transcript && audioSize < 3000) return
    clearTimeout(endSpeechTimer)
    clearTimeout(vadFallbackTimer)
    vadFallbackTimer = null
    clearTimeout(interimSafetyTimer)
    firstTurnDone = true  // after the first fire, Deepgram's signals are reliable

    const now = Date.now()
    const cooldownMs = Math.max(0, speakCooldownUntil - now)
    const blocked = isAgentSpeaking || isBusy || cooldownMs > 0

    if (blocked) {
      pendingTranscript = pendingTranscript
        ? `${pendingTranscript} ${transcript}`
        : transcript
      const reason = isAgentSpeaking ? 'speaking' : isBusy ? 'busy' : 'cooldown'
      console.log(`[STT] Buffered (${reason}): "${transcript}"`)
      if (!isAgentSpeaking && !isBusy) {
        setTimeout(() => {
          if (pendingTranscript && !isBusy && !isAgentSpeaking) {
            const next = pendingTranscript
            pendingTranscript = null
            handleUserTurn(next)
          }
        }, cooldownMs + 10)
      }
      return
    }

    handleUserTurn(transcript)
  }

  async function handleUserTurn(deepgramTranscript) {
    if (isBusy || finished || handoffTriggered) return
    isBusy = true
    bargeInRequested = false  // reset for this new turn
    ttsCancelled = false
    const t0 = Date.now()

    // Capture this turn's audio buffer and reset for next turn
    const turnAudioChunks = [...currentTurnAudio]
    currentTurnAudio = []

    // ── Sarvam multilingual STT ───────────────────────────────────────────────
    let transcript = deepgramTranscript
    let callerLang = sessionLang   // start from persisted language, not en-IN
    let transcriptForLLM = transcript

    const audioSize = turnAudioChunks.reduce((s, c) => s + c.length, 0)
    const enoughAudio = turnAudioChunks.length > 0 && audioSize >= 3000

    // Best Deepgram text available RIGHT NOW: the longest of the committed final,
    // the passed transcript, and the LIVE INTERIM. The VAD-fallback path commits
    // no final and passes '', so the caller's words live in `interimText` (e.g.
    // "looking for a 3BHK flat in Kokapet"). Using it here lets us skip the ~1s
    // Sarvam detour and seed RAG immediately, instead of waiting for Sarvam only
    // to discard its garbage ("3").
    const bestDgEarly = [latestTranscript, deepgramTranscript, interimText]
      .map(t => (t || '').trim())
      .sort((a, b) => b.length - a.length)[0] || ''

    // ── Early RAG kick-off (runs in parallel with Sarvam STT) ────────────────
    // Start the knowledge lookup NOW using the best Deepgram text as the seed.
    // Sarvam STT takes 700-1500ms; RAG takes 600-1000ms — running them concurrently
    // saves the longer of the two from the critical path. The cumulative query
    // (last 4 user messages) is robust enough that using the Deepgram wording
    // instead of the final Sarvam-translated wording rarely matters for retrieval.
    let ragPromise = null
    if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false && bestDgEarly) {
      const ragHist = getHistory(callSid)
      const ragRecentMsgs = ragHist.filter(m => m.role === 'user').slice(-4)
      const ragSeed = [...ragRecentMsgs.map(m => m.content), bestDgEarly].filter(Boolean).join(' ')
      ragPromise = retrieveKnowledge(tenantConfig.tenant_id, ragSeed)
    }

    // Skip Sarvam STT entirely when the session is already English AND Deepgram
    // already has a clean result (≥3 words) — as a final OR a live interim.
    // Deepgram nova-3 is more accurate for English; there's no point burning ~1s
    // waiting for Sarvam to confirm it (and Sarvam often returns noise like "3").
    const sessionIsEnglish = sessionLang === 'en-IN' || sessionLang.startsWith('en')
    const dgWordCount = bestDgEarly.split(/\s+/).filter(Boolean).length
    const skipSarvamForEnglish = sessionIsEnglish && dgWordCount >= 3

    const useSarvamSTT = tenantConfig.use_sarvam_stt !== false && enoughAudio && !skipSarvamForEnglish

    if (skipSarvamForEnglish) {
      console.log(`[STT] English session + Deepgram has ${dgWordCount} words — skipping Sarvam`)
      callerLang = 'en-IN'
      transcript = bestDgEarly
    } else if (useSarvamSTT) {
      try {
        const audioBuffer = Buffer.concat(turnAudioChunks)
        const sarvamResult = await transcribeWithSarvam(
          audioBuffer,
          tenantConfig.language_hint || 'unknown',
          sarvamPrompt
        )

        if (sarvamResult.transcript?.trim()) {
          const sarvamLang = sarvamResult.detected_language_code || 'en-IN'
          const sarvamIsNonEnglishIndic = sarvamLang !== 'en-IN' && !sarvamLang.startsWith('en')

          // Guard: if Sarvam detects a non-English Indic language that doesn't match
          // the current session AND Deepgram has built up a good English result,
          // it's likely a misdetection (e.g. English phonemes transliterated to Telugu).
          // Use latestTranscript (updated live by Deepgram even during handleUserTurn)
          // because deepgramTranscript may be '' when VAD fired before Deepgram committed.
          const bestDg = latestTranscript.trim().length > deepgramTranscript.trim().length
            ? latestTranscript.trim() : deepgramTranscript.trim()
          const deepgramHasGoodResult = bestDg.split(/\s+/).length >= 3
          const sarvamMismatchesSession = sarvamIsNonEnglishIndic &&
            sarvamLang !== sessionLang && !sarvamLang.startsWith((sessionLang || '').slice(0, 2))
          if ((sarvamMismatchesSession || !sarvamIsNonEnglishIndic) && deepgramHasGoodResult) {
            // Deepgram read this as solid English. Two cases land here:
            //   (a) Sarvam detected English too, or
            //   (b) Sarvam detected a DIFFERENT Indic language than the session
            //       (likely English phonemes transliterated, e.g. a budget read aloud).
            // Either way Deepgram's nova-3 English text is the most accurate transcript,
            // so use it for understanding. But DO NOT abandon an established Indic session
            // on a single turn — a Telugu caller saying "2.5 crore to 3 crore" produces a
            // digit/loanword-heavy clip Sarvam routinely mis-tags as English. Only flip the
            // session language after TWO consecutive English-detected turns.
            transcript = bestDg
            consecutiveEnglishTurns++

            if (sessionIsEnglish || consecutiveEnglishTurns >= 2) {
              callerLang = 'en-IN'
              sessionLang = 'en-IN'
              console.log(`[STT] Deepgram English "${bestDg}" — session is/now English`)
            } else {
              // Established Indic session + first ambiguous English turn: understand via
              // Deepgram text but keep replying in the caller's language (${sessionLang}).
              callerLang = sessionLang
              console.log(`[STT] Deepgram English "${bestDg}" inside ${sessionLang} session — using text but keeping ${sessionLang} (turn ${consecutiveEnglishTurns}/2)`)
            }
          } else {
            // Trust Sarvam (non-English Indic detected, or no good Deepgram result).
            // Strip any long Latin duplicate it sometimes appends to Indic output.
            const cleanTranscript = sarvamResult.transcript
              .replace(/[A-Za-z][A-Za-z\s,.'!?]{15,}/g, '')
              .trim()

            transcript = cleanTranscript || sarvamResult.transcript
            callerLang = sarvamLang
            sessionLang = sarvamLang
            consecutiveEnglishTurns = 0  // clearly Indic — reset the English streak

            const langName = LANG_NAMES[sarvamLang] || sarvamLang
            console.log(`[STT] 🌐 Sarvam (${langName}): "${transcript}"`)
          }
        }
      } catch (e) {
        console.warn('[STT] Sarvam STT failed, using Deepgram:', e.message)
      }
    } else {
      // Audio clip too short for Sarvam — keep the session language as-is.
      console.log(`[STT] Clip too short for Sarvam (${audioSize}B) — keeping session language: ${sessionLang}`)
    }

    // ── Translate caller's transcript to English for the LLM ─────────────────
    const isEnglish = callerLang === 'en-IN' || callerLang.startsWith('en')

    // ALWAYS sync transcriptForLLM from transcript after Sarvam may have updated it.
    // Without this, when Sarvam returns English and the translation block is skipped,
    // transcriptForLLM stays as the initial deepgramTranscript (which can be empty
    // when the VAD fallback fired with no Deepgram output).
    transcriptForLLM = transcript

    if (!isEnglish && transcript.trim()) {
      try {
        const glossary = tenantConfig.translation_glossary || []
        transcriptForLLM = await translateText(transcript, 'en-IN', callerLang, glossary)
        console.log(`[TRANSLATE] ${callerLang} → EN: "${transcriptForLLM}"`)
      } catch (e) {
        console.warn('[TRANSLATE] Caller→EN failed:', e.message)
        transcriptForLLM = transcript
      }
    }

    // Safety: if result came back too short (< 2 words), pick the longest useful source.
    // interimText holds Deepgram's latest partial — often the best option when VAD fired
    // before Deepgram committed a final (e.g. Sarvam got "3" but Deepgram had the full sentence).
    if (transcriptForLLM.trim().split(/\s+/).length < 2) {
      const candidates = [latestTranscript, deepgramTranscript, interimText]
        .map(t => t.trim())
        .filter(t => t.split(/\s+/).length >= 2)  // only candidates with actual content
      const bestDgFallback = candidates.sort((a, b) => b.length - a.length)[0] || ''
      console.log(`[TRANSLATE] Too short — best fallback: "${bestDgFallback || transcript}"`)
      transcriptForLLM = bestDgFallback || transcript
    }

    // Normalize BHK variants that translation/transliteration mangles.
    // Sarvam transliterates "3BHK" from Telugu as "Triple HK" / "3 HK" etc.
    transcriptForLLM = transcriptForLLM
      .replace(/\b([Tt]riple|[Tt]hree)\s+[Hh][Kk]\b/g, '3BHK')
      .replace(/\b([Dd]ouble|[Tt]wo)\s+[Hh][Kk]\b/g, '2BHK')
      .replace(/\b(\d)\s+[Bb][Hh][Kk]\b/g, '$1BHK')

    // If both Deepgram and Sarvam gave us nothing, drop the turn silently —
    // sending an empty string to the LLM causes hallucinated responses.
    if (!transcript?.trim() && !transcriptForLLM?.trim()) {
      console.log('[STT] No transcript from Deepgram or Sarvam — dropping turn')
      isBusy = false
      currentTurnAudio = []  // clear buffer so next VAD fallback doesn't resend same audio
      return
    }

    // Detect explicit handoff keyword in the caller's speech (Layer 1)
    const keywordHandoff = detectHandoffKeyword(transcript) || detectHandoffKeyword(transcriptForLLM)
    if (keywordHandoff) {
      console.log(`[HANDOFF] 🔑 Keyword detected in: "${transcript}"`)
    }

    try {
      if (onTranscript) onTranscript(transcript)

      // Lock the TTS language for this whole turn based on caller's detected language.
      // Use Sarvam's detected language if available, otherwise script-detect from text.
      const turnLang = isEnglish ? 'en' : (callerLang.split('-')[0] || detectLang(transcript))

      let buffer = ''
      let fullReply = ''
      let firstSpoken = false

      const queue = []
      let producerDone = false
      let totalPlaybackMs = 0

      const consumer = (async () => {
        let i = 0
        while (true) {
          while (queue.length <= i && !producerDone) {
            await new Promise(r => setTimeout(r, 5))
          }
          if (queue.length <= i) break
          if (ttsCancelled) break  // barge-in: stop playing further sentences
          const ms = await queue[i]
          totalPlaybackMs += ms
          i++
        }
      })()

      // ── RAG: retrieve tenant-specific knowledge for this question ─────────
      // A filler phrase plays ONLY if retrieval+thinking is actually slow
      // (>1.1s). Fast turns get no filler — so the agent doesn't say
      // "one moment" on every single turn (which sounds robotic).

      // Don't fire a "let me check that for you" filler when the caller is just
      // closing out (bye/thanks) or giving a one-word acknowledgment. Those
      // replies need no lookup — a lookup-style filler before "Goodbye sir!"
      // sounds absurd. These turns are fast anyway, so silence is fine.
      const lcUser = transcriptForLLM.trim().toLowerCase()
      const isClosing = /\b(bye|good\s?bye|see you|thank you|thanks|thank u|that'?s all|that is all|nothing else|no that'?s it|good night)\b/.test(lcUser)
      const userWordN = lcUser.split(/\s+/).filter(Boolean).length
      const isTinyAck = userWordN <= 2 &&
        /^(ok|okay|yes|yeah|yep|no|nope|sure|fine|hmm|alright|cool|great|perfect|good)\b/.test(lcUser)
      const skipFiller = isClosing || isTinyAck

      let fillerFired = false
      const fillerTimer = setTimeout(() => {
        if (firstSpoken || ttsCancelled || skipFiller) return
        // Always use a short, polite ENGLISH filler in the English voice — even on
        // Telugu/Hindi calls. Native Indic fillers like "సరే" (sare) can sound
        // curt/rude; a warm "One moment sir" is understood fine and stays courteous.
        const fillers = tenantConfig.filler_phrases || [
          'Please wait a moment sir, let me check that for you.',
          'Sure sir, let me find that information for you.',
          'Just a moment please, I am looking that up now.',
          'One moment sir, let me pull up those details.',
          'Let me check that for you sir, just a second.',
        ]
        const filler = fillers[Math.floor(Math.random() * fillers.length)]
        fillerFired = true
        firstSpoken = true
        isAgentSpeaking = true
        console.log(`[FILLER] "${filler}"`)
        // Force 'en' so the filler speaks in the English voice, not the Telugu one.
        queue.push(streamTTSToTwilio(filler, twilioWs, streamSid, ttsClient, 'en'))
      }, 500)  // 500ms: fire sooner so caller hears acknowledgment quickly

      let knowledge = ''
      if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
        if (ragPromise) {
          // RAG was already kicked off in parallel with Sarvam STT — just collect the result.
          knowledge = await ragPromise
        } else {
          // Deepgram had no transcript earlier, so RAG couldn't start early.
          // Query now with the final Sarvam-translated transcript.
          const hist = getHistory(callSid)
          const recentUserMsgs = hist.filter(m => m.role === 'user').slice(-4)
          const ragQuery = [...recentUserMsgs.map(m => m.content), transcriptForLLM]
            .filter(Boolean).join(' ')
          knowledge = await retrieveKnowledge(tenantConfig.tenant_id, ragQuery)
        }
      }

      const cancelCheck = () => ttsCancelled

      const MAX_SENTENCES = tenantConfig.max_sentences || 3  // safety net on spoken length
      let sentenceCount = 0

      // ── LLM generates English reply → translate to caller's language ─────────
      // The LLM always thinks and replies in English for best accuracy with the KB.
      // Before speaking, we translate each sentence back to the caller's language.
      const needsTranslation = !isEnglish && tenantConfig.translate_replies !== false

      for await (const token of streamAIReply(callSid, transcriptForLLM, tenantConfig, undefined, knowledge)) {
        clearTimeout(fillerTimer)  // real reply is here — no filler needed
        if (ttsCancelled) break  // barge-in: stop generating more speech
        if (sentenceCount >= MAX_SENTENCES) break  // spoke enough — stop here
        buffer += token
        fullReply += token

        const mMore = buffer.match(/^([\s\S]{5,}?[.!?])(\s+\S[\s\S]*)$/)
        const mFinal = !mMore && buffer.match(/^([\s\S]{5,}[?!])$/)
        const m = mMore || mFinal

        if (m) {
          // Strip the [HANDOFF] token so it's never spoken aloud
          let sentence = stripHandoffSignal(m[1].trim())
          buffer = (m[2] || '').trim()

          if (!sentence) continue  // skip if sentence was only the token

          // Translate LLM's English reply to caller's detected language
          if (needsTranslation && sentence) {
            try {
              const glossary = tenantConfig.translation_glossary || []
              const translated = await translateText(sentence, callerLang, 'en-IN', glossary)
              console.log(`[TRANSLATE] EN → ${callerLang}: "${translated}"`)
              sentence = spokenNumerals(translated)
            } catch (e) {
              console.warn('[TRANSLATE] Reply translation failed, speaking English:', e.message)
              // fall through — speak the English original
            }
          }

          if (!firstSpoken) {
            console.log(`[TIMER] First sentence at ${Date.now() - t0}ms: "${sentence}"`)
            firstSpoken = true
            isAgentSpeaking = true  // gate mic when audio starts playing
          }

          queue.push(streamTTSToTwilio(sentence, twilioWs, streamSid, ttsClient, turnLang, cancelCheck))
          sentenceCount++
          if (sentenceCount >= MAX_SENTENCES) {
            buffer = ''  // discard anything after the cap — don't speak it
            break
          }
        }
      }

      if (buffer.trim() && !ttsCancelled && sentenceCount < MAX_SENTENCES) {
        let tail = stripHandoffSignal(buffer.trim())
        if (tail) {
          if (needsTranslation) {
            try { const g = tenantConfig.translation_glossary || []; tail = spokenNumerals(await translateText(tail, callerLang, 'en-IN', g)) } catch {}
          }
          if (!firstSpoken) isAgentSpeaking = true
          queue.push(streamTTSToTwilio(tail, twilioWs, streamSid, ttsClient, turnLang, cancelCheck))
        }
      }

      producerDone = true

      const sentAt = Date.now()
      await consumer
      const sendDuration = Date.now() - sentAt

      console.log(`[LLM] Agent: "${fullReply.trim()}"`)
      console.log(`[TIMER] Total turn (sent): ${Date.now() - t0}ms | playback=${totalPlaybackMs}ms`)

      // Record what the agent SPOKE in the transcript (caller turns are recorded
      // at the start of the turn). Strip the [HANDOFF] marker so it's not stored.
      const spokenReply = stripHandoffSignal(fullReply).trim()
      if (onTranscript && spokenReply) onTranscript(spokenReply, 'assistant')

      // Release the mic partway through playback so the caller can respond
      // without waiting the whole audio tail. We wait ~60% of remaining
      // playback (capped at 2.5s) — enough that the agent isn't cut off on
      // short replies, but the mic reopens quickly on long ones.
      const remainingPlaybackMs = totalPlaybackMs - sendDuration
      const cappedWait = Math.min(Math.round(remainingPlaybackMs * 0.6), 2500)
      if (cappedWait > 0) {
        console.log(`[TIMER] Waiting ${cappedWait}ms for playback...`)
        await new Promise(r => setTimeout(r, cappedWait))
      }

      // ── HANDOFF CHECK ────────────────────────────────────────────────────
      // Transfer if: caller used a handoff keyword, OR the LLM emitted [HANDOFF]
      const signalHandoff = detectHandoffSignal(fullReply)
      const shouldHandoff =
        (keywordHandoff || signalHandoff) &&
        tenantConfig.enable_handoff !== false &&
        tenantConfig.handoff_number

      if (shouldHandoff && !handoffTriggered) {
        handoffTriggered = true
        console.log(`[HANDOFF] Triggering transfer (keyword=${keywordHandoff}, signal=${signalHandoff})`)

        // Log handoff event via callback (index.js saves to Supabase)
        if (onTranscript) {
          onTranscript('[SYSTEM] Call handed off to human agent')
        }

        // Stop STT — call is leaving the AI pipeline
        isAgentSpeaking = true  // block any further transcript processing
        clearTimeout(endSpeechTimer)

        // Perform the Twilio warm transfer (redirects the live call to <Dial>)
        await transferToHuman(callSid, tenantConfig.handoff_number, callerNumber)

        // Don't release gates / don't process pending — call is transferring away
        isBusy = false
        console.log(`[HANDOFF] Done — AI pipeline released call ${callSid}`)
        return
      }
      // ─────────────────────────────────────────────────────────────────────

      // Protect against echo: mic releases now but audio may still be playing.
      // Suppress VAD fallbacks for the remaining audio tail + 1.5s — genuine speech
      // goes through Deepgram's own finals/UtteranceEnd which are NOT affected.
      const echoTailMs = Math.max(0, remainingPlaybackMs - cappedWait)
      echoProtectionUntil = Date.now() + echoTailMs + 1500

      isBusy = false
      isAgentSpeaking = false
      speakCooldownUntil = Date.now() + 250
      lastFiredAt = Date.now()  // block late Deepgram finals for this utterance from triggering a duplicate turn
      latestTranscript = ''  // clear any echo captured during playback
      interimText = ''
      clearTimeout(endSpeechTimer)  // clear stale fallback timer
      clearTimeout(interimSafetyTimer)
      currentTurnAudio = []  // clear audio buffer for next turn

      // Tell Deepgram to finalize/flush its internal buffer so the next
      // utterance starts clean — prevents stale buffered speech from playback
      // window leaking into the next turn
      if (dgWs && dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'Finalize' }))
      }

      console.log(`[TIMER] Total turn (done): ${Date.now() - t0}ms`)

      if (pendingTranscript) {
        const next = pendingTranscript
        pendingTranscript = null
        setTimeout(() => handleUserTurn(next), 0)
      }

    } catch (e) {
      console.error('[Turn] Error:', e.message)
      isBusy = false
      isAgentSpeaking = false
      latestTranscript = ''
      interimText = ''
      speakCooldownUntil = Date.now() + 250
      if (pendingTranscript) {
        const next = pendingTranscript
        pendingTranscript = null
        setTimeout(() => handleUserTurn(next), 0)
      }
    }
  }

  // ─── Greeting ───────────────────────────────────────────────────────────────

  setTimeout(async () => {
    const agentName = tenantConfig.agent_name || 'Priya'
    const businessName = tenantConfig.business_name || 'My Home Projects'
    const greeting = tenantConfig.greeting_message ||
      `Hello! ${agentName} here from ${businessName}. How can I help you sir?`
    console.log(`[GREETING] "${greeting}"`)

    isAgentSpeaking = true

    // Connect Deepgram NOW (during greeting) so it's fully ready by the time
    // the greeting finishes. The isAgentSpeaking guard ignores the greeting's
    // echo. This eliminates the dead window where early speech was lost.
    if (!finished) connectDeepgram()

    try {
      const playbackMs = await streamTTSToTwilio(greeting, twilioWs, streamSid, ttsClient)
      console.log(`[GREETING] Sent (${playbackMs}ms audio)`)

      const { getHistory } = await import('./llm.js')
      getHistory(callSid).push({ role: 'assistant', content: greeting })

      // Record the greeting as the agent's first transcript line.
      if (onTranscript) onTranscript(greeting, 'assistant')

      if (playbackMs > 0) await new Promise(r => setTimeout(r, playbackMs - 100))
    } catch (e) {
      console.error('[GREETING] Error:', e.message)
    } finally {
      isAgentSpeaking = false
      speakCooldownUntil = Date.now() + 250
      latestTranscript = ''
      // Flush greeting echo from Deepgram so first user turn starts clean
      if (dgWs && dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'Finalize' }))
      }
    }

    console.log('[GREETING] Done — STT listening')

    if (pendingTranscript) {
      const next = pendingTranscript
      pendingTranscript = null
      await handleUserTurn(next)
    }
  }, 200)

  // ─── Audio Pipe ─────────────────────────────────────────────────────────────
  // Deepgram takes raw mulaw 8kHz — send Twilio's payload directly, no conversion

  const send = (audioChunk) => {
    if (!dgWs || dgWs.readyState !== WebSocket.OPEN) return
    // audioChunk is already mulaw 8kHz from Twilio — send to Deepgram as-is
    dgWs.send(audioChunk)
    // Also accumulate for Sarvam STT (used when non-English is detected)
    if (!isAgentSpeaking) {
      currentTurnAudio.push(audioChunk)
      // Cap at ~30s worth of audio to avoid memory issues (30s * 8000 = 240000 bytes)
      if (currentTurnAudio.reduce((s, c) => s + c.length, 0) > 240000) {
        currentTurnAudio.shift()  // drop oldest chunk
      }
    }
  }

  const finish = () => {
    finished = true
    clearTimeout(endSpeechTimer)
    clearTimeout(vadFallbackTimer)
    clearInterval(keepAliveTimer)
    ttsClient.close()
    disconnectDeepgram()
    console.log('[Deepgram STT] Connection closed')
  }

  return { send, finish }
}
