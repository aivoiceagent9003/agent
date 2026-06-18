// services/stt.js — Full Sarvam AI voice pipeline (replaces Deepgram entirely)
//
// STT:  Sarvam saaras:v3 WebSocket, mode=transcribe, language_code=unknown
//       → auto-detects caller language, returns Indic/English transcript
//       → response includes `language_code` (e.g. "te-IN") so we know what
//         language the caller spoke
//
// Translation: per-turn REST call to translate transcript → English for LLM
//              and LLM English reply → caller's language for TTS
//
// TTS:  Sarvam bulbul:v3 WebSocket (unchanged from before)
//
// Audio: Twilio mulaw 8kHz → decode to PCM16 → send to Sarvam STT WebSocket
//
// Export: createDeepgramConnection() — same interface as before, no change in index.js

import WebSocket from 'ws'
import 'dotenv/config'
import { streamAIReply, warmupLLM, getHistory } from './llm.js'
import {
  detectHandoffKeyword,
  detectHandoffSignal,
  stripHandoffSignal,
  transferToHuman,
} from './handoff.js'
import { retrieveKnowledge, warmupRAG } from './rag.js'
import { translateText, LANG_NAMES } from './sarvam.js'

// ─── mulaw → PCM16 decoder ────────────────────────────────────────────────────
const MULAW_TABLE = (() => {
  const t = new Int16Array(256)
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF
    const sign = u & 0x80
    const exp = (u >> 4) & 0x07
    let mant = (u & 0x0F) << 1
    mant += 33
    if (exp > 0) mant += 0x100
    if (exp > 1) mant <<= exp - 1
    t[i] = sign ? 33 - mant : mant - 33
  }
  return t
})()

function mulawToPcm16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2)
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(MULAW_TABLE[mulawBuf[i]], i * 2)
  }
  return pcm
}

// ─── Sarvam STT WebSocket connection ─────────────────────────────────────────
// Auth: Api-Subscription-Key header (exact casing matters)
// Params: language-code (hyphen), input_audio_codec, sample_rate
// Audio:  send as JSON { audio: { data: base64, sample_rate, encoding } }
function sarvamSTTUrl() {
  const params = new URLSearchParams({
    model:               'saaras:v3',
    mode:                'transcribe',
    'language-code':     'unknown',        // hyphen not underscore
    sample_rate:         '8000',           // 8kHz from Twilio
    input_audio_codec:   'pcm_s16le',      // raw PCM16 LE
    high_vad_sensitivity:'true',
    vad_signals:         'true',
  })
  return `wss://api.sarvam.ai/speech-to-text/ws?${params}`
}

// ─── TTS (Sarvam bulbul:v3) ───────────────────────────────────────────────────

const TTS_WS_URL = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`

const SARVAM_TTS_LANGS = new Set([
  'en-IN','hi-IN','te-IN','ta-IN','kn-IN','ml-IN',
  'mr-IN','bn-IN','gu-IN','pa-IN','od-IN',
])

class SarvamTTSClient {
  constructor(apiKey, speaker = 'priya') {
    this.apiKey   = apiKey
    this.speaker  = speaker
    this.ws       = null
    this.currentLang = null
    this.currentResolve = null
    this.currentReject  = null
    this.totalBytes     = 0
    this.firstChunkTime = null
    this.startTime      = null
    this._onChunk  = null
    this._chain    = Promise.resolve()
  }

  async connect(lang = 'en-IN') {
    const target = SARVAM_TTS_LANGS.has(lang) ? lang : 'en-IN'
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentLang === target) return
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close() }
    this.currentLang = target
    const ws = new WebSocket(
      `${TTS_WS_URL}&target_language_code=${target}`,
      { headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY } }
    )
    this.ws = ws
    await new Promise((res, rej) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        rej(new Error('TTS WS timeout'))
      }, 10000)

      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        fn(value)
      }

      ws.once('open', () => {
        ws.send(JSON.stringify({
          target_language_code: target,
          speaker:              this.speaker,
          speech_sample_rate:   8000,
          output_audio_codec:   'mulaw',
          pace:                 1.15,
          temperature:          0.7,
        }))
        console.log(`[TTS WS] Connected (${target}) ✅`)
        settle(res)
      })
      ws.once('error', (e) => settle(rej, e))
      ws.once('close', (code, reason) => {
        settle(rej, new Error(`TTS WS closed before ready (${code}${reason ? `: ${reason}` : ''})`))
      })
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.audios?.[0]) {
        const chunk = Buffer.from(msg.audios[0], 'base64')
        if (!this.firstChunkTime) {
          this.firstChunkTime = Date.now()
          console.log(`[TTS] 🔊 First chunk in ${this.firstChunkTime - this.startTime}ms`)
        }
        this.totalBytes += chunk.length
        if (this._onChunk) this._onChunk(chunk)
      }
      if (msg.type === 'complete' || msg.is_last_response === true) {
        if (this.currentResolve) {
          const ms = Math.round(this.totalBytes / 8)
          console.log(`[TTS] ✅ Done | ${this.totalBytes}B | ${ms}ms audio`)
          this.currentResolve(ms)
          this.currentResolve = null
          this.currentReject  = null
        }
      }
    })
    ws.on('error', (e) => {
      console.error('[TTS WS] Error:', e.message)
      if (this.currentReject) { this.currentReject(e); this.currentReject = null }
    })
    ws.on('close', () => {
      console.log('[TTS WS] Closed')
      if (this.currentReject) {
        if (this.totalBytes > 0 && this.currentResolve) {
          const ms = Math.round(this.totalBytes / 8)
          this.currentResolve(ms)
          this.currentResolve = null
        } else {
          this.currentReject(new Error('TTS WS closed'))
        }
        this.currentReject = null
      }
    })
  }

  speak(text, lang, onChunk) {
    this._chain = this._chain
      .catch(() => {})
      .then(() => this._speakNow(text, lang, onChunk))
    return this._chain
  }

  async _speakNow(text, lang, onChunk) {
    await this.connect(lang)
    this.totalBytes     = 0
    this.firstChunkTime = null
    this.startTime      = Date.now()
    this._onChunk       = onChunk
    return new Promise((res, rej) => {
      this.currentResolve = res
      this.currentReject  = rej
      this.ws.send(JSON.stringify({ text }))
    })
  }

  close() {
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null }
  }
}

// ─── Stream TTS audio to Twilio ───────────────────────────────────────────────
async function streamTTSToTwilio(text, twilioWs, streamSid, ttsClient, lang, cancelCheck) {
  const ttsLang = SARVAM_TTS_LANGS.has(lang) ? lang
    : (SARVAM_TTS_LANGS.has(`${lang}-IN`) ? `${lang}-IN` : 'en-IN')

  return ttsClient.speak(text, ttsLang, (chunk) => {
    if (cancelCheck && cancelCheck()) return
    if (twilioWs.readyState !== 1) return
    const SZ = 640
    for (let o = 0; o < chunk.length; o += SZ) {
      twilioWs.send(JSON.stringify({
        event: 'media', streamSid,
        media: { payload: chunk.slice(o, o + SZ).toString('base64') },
      }))
    }
  })
}

// ─── Main export (same interface as old createDeepgramConnection) ─────────────

export function createDeepgramConnection(callSid, tenantConfig, twilioWs, streamSid, onTranscript, onReady) {

  // ── State ──────────────────────────────────────────────────────────────────
  let isBusy           = false
  let handoffTriggered = false
  let isAgentSpeaking  = false
  let speakCooldownUntil = 0
  let pendingTranscript  = null
  let finished           = false
  let sarvamWs           = null
  let sttReconnectTimer  = null
  let sttKeepAliveTimer  = null

  // Persists the DETECTED caller language across the whole call.
  // Updated the first time Sarvam confidently detects a non-unknown language.
  // 'en-IN' is the safe default (no translation needed).
  let sessionLang = 'en-IN'

  const VALID_VOICES = ['priya','ritu','neha','kavya','shreya','simran',
    'pooja','roopa','ishita','aditya','rohan','kabir','dev','rahul']
  const chosenVoice = VALID_VOICES.includes(tenantConfig.voice)
    ? tenantConfig.voice : 'priya'
  const ttsClient = new SarvamTTSClient(process.env.SARVAM_API_KEY, chosenVoice)

  // ── Warmup ─────────────────────────────────────────────────────────────────
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) warmupRAG()
  warmupLLM()

  // ── Connect Sarvam STT WebSocket ──────────────────────────────────────────
  function connectSTT() {
    if (finished) return
    if (sttReconnectTimer) {
      clearTimeout(sttReconnectTimer)
      sttReconnectTimer = null
    }

    // Auth: api-subscription-key must be in the HTTP upgrade header
    const ws = new WebSocket(
      sarvamSTTUrl(),
      [`api-subscription-key.${process.env.SARVAM_API_KEY}`],
      {
        headers: {
          'Api-Subscription-Key': process.env.SARVAM_API_KEY,
        },
      }
    )
    sarvamWs = ws

    ws.on('open', () => {
      console.log('[Sarvam STT] Connected ✅ (persistent, auto-detect language)')
      if (sttKeepAliveTimer) clearInterval(sttKeepAliveTimer)
      sttKeepAliveTimer = setInterval(() => {
        if (finished || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'ping' }))
      }, 25000)
      if (onReady) onReady()
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // ── VAD events ────────────────────────────────────────────────────────
      if (msg.type === 'events') {
        const sig = msg.data?.signal_type
        if (sig === 'START_SPEECH' && !isAgentSpeaking) {
          console.log('[STT] 🎤 Speech started')
        }
        return
      }

      // ── Transcript ────────────────────────────────────────────────────────
      const text = (msg.transcript || msg.data?.transcript || '').trim()
      if (!text) return
      if (isAgentSpeaking) return  // echo guard

      // Sarvam returns the detected language in the response
      const detectedLang = msg.language_code || msg.data?.language_code || null

      const isFinal     = msg.is_final !== false
      const speechFinal = msg.speech_final === true

      if (!isFinal) {
        // Interim — show live transcription, don't fire turn
        console.log(`[STT] … "${text}"`)
        return
      }

      // Final transcript received
      console.log(`[STT] 📝 "${text}"`)

      // Update session language from Sarvam's detection (first confident detection wins)
      if (detectedLang && detectedLang !== 'unknown' && detectedLang !== sessionLang) {
        const name = LANG_NAMES[detectedLang] || detectedLang
        console.log(`[STT] 🌐 Detected language: ${name} (${detectedLang})`)
        sessionLang = detectedLang
      }

      if (speechFinal) {
        console.log(`[STT] ✅ speech_final: "${text}"`)
        fireFinal(text, detectedLang)
      } else {
        fireFinal(text, detectedLang)
      }
    })

    ws.on('error', (e) => console.error('[Sarvam STT] Error:', e.message))

    ws.on('close', (code, reason) => {
      const why = reason?.toString() || ''
      console.log(`[Sarvam STT] Closed (${code}${why ? ' — ' + why : ''})`)
      if (sttKeepAliveTimer) {
        clearInterval(sttKeepAliveTimer)
        sttKeepAliveTimer = null
      }
      if (!finished) {
        const delay = code === 1000 ? 3000 : 500
        console.log(`[Sarvam STT] Reconnecting in ${delay}ms...`)
        sttReconnectTimer = setTimeout(connectSTT, delay)
      }
    })
  }

  connectSTT()

  // ── Greeting ───────────────────────────────────────────────────────────────
  const greeting = tenantConfig.greeting || 'Hi, how can I help you?'
  console.log(`[GREETING] "${greeting}"`)

  ;(async () => {
    try {
      isAgentSpeaking = true
      const ms = await ttsClient.speak(greeting, 'en-IN', (chunk) => {
        if (twilioWs.readyState !== 1) return
        const SZ = 640
        for (let o = 0; o < chunk.length; o += SZ) {
          twilioWs.send(JSON.stringify({
            event: 'media', streamSid,
            media: { payload: chunk.slice(o, o + SZ).toString('base64') },
          }))
        }
      })
      console.log(`[GREETING] Sent (${ms}ms audio)`)
      const { getHistory } = await import('./llm.js')
      getHistory(callSid).push({ role: 'assistant', content: greeting })
      isAgentSpeaking  = false
      speakCooldownUntil = Date.now() + 250
      console.log('[GREETING] Done — STT listening')
    } catch (e) {
      console.error('[GREETING] Error:', e.message)
      isAgentSpeaking = false
    }
  })()

  // ── Turn firing ─────────────────────────────────────────────────────────────
  function fireFinal(transcript, detectedLang) {
    if (!transcript) return
    const now = Date.now()
    const cooldown = Math.max(0, speakCooldownUntil - now)
    const blocked  = isAgentSpeaking || isBusy || cooldown > 0

    if (blocked) {
      pendingTranscript = pendingTranscript
        ? `${pendingTranscript} ${transcript}` : transcript
      const reason = isAgentSpeaking ? 'speaking' : isBusy ? 'busy' : 'cooldown'
      console.log(`[STT] Buffered (${reason}): "${transcript}"`)
      if (!isAgentSpeaking && !isBusy) {
        setTimeout(() => {
          if (pendingTranscript && !isBusy && !isAgentSpeaking) {
            const next = pendingTranscript
            pendingTranscript = null
            handleUserTurn(next, detectedLang)
          }
        }, cooldown + 50)
      }
      return
    }
    handleUserTurn(transcript, detectedLang)
  }

  // ── Main turn handler ───────────────────────────────────────────────────────
  async function handleUserTurn(transcript, turnDetectedLang) {
    if (isBusy || finished || handoffTriggered) return
    isBusy = true
    const t0 = Date.now()

    // Determine this turn's caller language:
    //   1. What Sarvam just detected for THIS turn (most current)
    //   2. sessionLang (detected in a previous turn — persists)
    //   3. 'en-IN' fallback
    const callerLang = (turnDetectedLang && turnDetectedLang !== 'unknown')
      ? turnDetectedLang
      : sessionLang

    const isEnglish = callerLang === 'en-IN' || callerLang.startsWith('en')

    // Translate transcript → English for LLM + RAG
    // (Sarvam transcribe mode gives us the caller's language.
    //  We translate here for accurate LLM comprehension + RAG matching.)
    let transcriptForLLM = transcript
    if (!isEnglish) {
      try {
        const glossary = tenantConfig.translation_glossary || []
        transcriptForLLM = await translateText(transcript, 'en-IN', callerLang, glossary)
        console.log(`[TRANSLATE] ${callerLang} → EN: "${transcriptForLLM}"`)
      } catch (e) {
        console.warn('[TRANSLATE] Caller→EN failed:', e.message)
      }
    }

    // Safety — if translation gave something unusable, fall back
    if (!transcriptForLLM || transcriptForLLM.trim().split(/\s+/).length < 1) {
      transcriptForLLM = transcript
    }

    const keywordHandoff = detectHandoffKeyword(transcriptForLLM) || detectHandoffKeyword(transcript)
    if (keywordHandoff) console.log(`[HANDOFF] 🔑 Keyword detected: "${transcript}"`)

    try {
      if (onTranscript) onTranscript(transcript)

      // TTS speaks in the caller's detected language
      const ttsLang = callerLang
      const needsTranslation = !isEnglish && tenantConfig.translate_replies !== false

      let buffer    = ''
      let fullReply = ''
      let firstSpoken  = false
      const queue      = []
      let producerDone = false
      let totalPlaybackMs = 0

      const consumer = (async () => {
        let i = 0
        while (true) {
          while (queue.length <= i && !producerDone) await new Promise(r => setTimeout(r, 5))
          if (queue.length <= i) break
          const item = queue[i++]
          if (item === null) break
          totalPlaybackMs += await item
        }
      })()

      // Filler phrase
      const fillerTimer = setTimeout(() => {
        if (firstSpoken) return
        const fillers = tenantConfig.filler_phrases || [
          'Let me check that for you.',
          'One moment, please.',
          'Sure, let me find that.',
        ]
        const filler = fillers[Math.floor(Math.random() * fillers.length)]
        firstSpoken    = true
        isAgentSpeaking = true
        console.log(`[FILLER] "${filler}"`)
        queue.push(streamTTSToTwilio(filler, twilioWs, streamSid, ttsClient, ttsLang))
      }, 700)

      // RAG
      let knowledge = ''
      if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
        const hist    = getHistory(callSid)
        const prevUser = [...hist].reverse().find(m => m.role === 'user')
        const ragQuery = prevUser ? `${prevUser.content} ${transcriptForLLM}` : transcriptForLLM
        knowledge = await retrieveKnowledge(tenantConfig.tenant_id, ragQuery)
      }

      const MAX_SENTENCES = tenantConfig.max_sentences || 2
      let   sentenceCount  = 0

      for await (const token of streamAIReply(callSid, transcriptForLLM, tenantConfig, undefined, knowledge)) {
        clearTimeout(fillerTimer)
        if (sentenceCount >= MAX_SENTENCES) break
        buffer    += token
        fullReply += token

        const mMore = buffer.match(/^([\s\S]{5,}?[.!?])(\s+\S[\s\S]*)$/)
        const mFinal = !mMore && buffer.match(/^([\s\S]{5,}[?!])$/)
        const m = mMore || mFinal

        if (m) {
          let sentence = stripHandoffSignal(m[1].trim())
          buffer = (m[2] || '').trim()
          if (!sentence) continue

          // Translate LLM English reply → caller's language
          if (needsTranslation) {
            try {
              const glossary = tenantConfig.translation_glossary || []
              const translated = await translateText(sentence, ttsLang, 'en-IN', glossary)
              console.log(`[TRANSLATE] EN → ${ttsLang}: "${translated}"`)
              sentence = translated
            } catch (e) {
              console.warn('[TRANSLATE] Reply translation failed:', e.message)
            }
          }

          if (!firstSpoken) {
            console.log(`[TIMER] First sentence at ${Date.now() - t0}ms: "${sentence}"`)
            firstSpoken    = true
            isAgentSpeaking = true
          }
          queue.push(streamTTSToTwilio(sentence, twilioWs, streamSid, ttsClient, ttsLang))
          sentenceCount++
          if (sentenceCount >= MAX_SENTENCES) { buffer = ''; break }
        }
      }

      // Tail
      if (buffer.trim() && sentenceCount < MAX_SENTENCES) {
        let tail = stripHandoffSignal(buffer.trim())
        if (tail) {
          if (needsTranslation) {
            try {
              const g = tenantConfig.translation_glossary || []
              tail = await translateText(tail, ttsLang, 'en-IN', g)
            } catch {}
          }
          if (!firstSpoken) isAgentSpeaking = true
          queue.push(streamTTSToTwilio(tail, twilioWs, streamSid, ttsClient, ttsLang))
        }
      }

      producerDone = true
      const sentAt  = Date.now()
      await consumer
      const elapsed = Date.now() - sentAt

      console.log(`[LLM] Agent: "${fullReply.trim()}"`)
      console.log(`[TIMER] Total turn (sent): ${Date.now() - t0}ms | playback=${totalPlaybackMs}ms`)

      // Mic release
      const micRelease = Math.min(Math.max(0, totalPlaybackMs - elapsed) * 0.6, 2500)
      await new Promise(r => setTimeout(r, micRelease))

      // Handoff
      if ((keywordHandoff || detectHandoffSignal(fullReply)) && !handoffTriggered) {
        handoffTriggered = true
        const remaining = Math.max(0, totalPlaybackMs - elapsed - micRelease)
        await new Promise(r => setTimeout(r, remaining))
        await transferToHuman(callSid, tenantConfig)
      }

      const rest = Math.max(0, totalPlaybackMs - elapsed - micRelease)
      await new Promise(r => setTimeout(r, rest))

      isBusy          = false
      isAgentSpeaking  = false
      speakCooldownUntil = Date.now() + 250
      console.log(`[TIMER] Total turn (done): ${Date.now() - t0}ms`)

      if (pendingTranscript) {
        const next = pendingTranscript; pendingTranscript = null
        setTimeout(() => handleUserTurn(next, null), 0)
      }

    } catch (e) {
      console.error('[Turn] Error:', e.message)
      isBusy = false; isAgentSpeaking = false
    }
  }

  // ── Audio pipe ─────────────────────────────────────────────────────────────
  // Twilio mulaw 8kHz -> raw PCM16. The connection declares
  // input_audio_codec=pcm_s16le, so audio frames are sent as binary PCM.
  const send = (mulawChunk) => {
    if (!sarvamWs || sarvamWs.readyState !== WebSocket.OPEN) return
    const pcm = mulawToPcm16(mulawChunk)
    sarvamWs.send(pcm)
  }

  const finish = () => {
    finished = true
    if (sttReconnectTimer) clearTimeout(sttReconnectTimer)
    if (sttKeepAliveTimer) clearInterval(sttKeepAliveTimer)
    ttsClient.close()
    if (sarvamWs) { sarvamWs.removeAllListeners(); sarvamWs.close() }
    console.log('[Sarvam STT] Connection closed')
  }

  return { send, finish }
}
