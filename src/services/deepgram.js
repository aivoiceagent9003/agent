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
      this.currentResolve = resolve
      this.currentReject = reject
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

  const playbackMs = await ttsClient.speak(text, onChunk, forceLang)

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
  let keepAliveTimer = null

  // ── Barge-in state ──────────────────────────────────────────────────────────
  let bargeInRequested = false  // set true when caller interrupts agent speech
  let ttsCancelled = false      // tells the TTS queue/consumer to stop streaming

  const VALID_V3_VOICES = ['priya', 'ritu', 'neha', 'kavya', 'shreya', 'simran',
    'pooja', 'roopa', 'ishita', 'aditya', 'rohan', 'kabir', 'dev', 'rahul']
  const chosenVoice = VALID_V3_VOICES.includes(tenantConfig.voice)
    ? tenantConfig.voice
    : 'priya'
  const ttsClient = new SarvamTTSClient(process.env.SARVAM_API_KEY, chosenVoice)

  // Warm up the embedding model in the background so the first RAG query
  // isn't a ~3s cold start. Fire-and-forget; no await.
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
    warmupRAG()
  }
  // Warm up the LLM too — first completion is otherwise a ~1.7s cold start.
  warmupLLM()

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
    const keyterms = [
      'Kokapet', 'Tellapur', 'Kollur', 'Gachibowli', 'Hyderabad',
      'BHK', 'crore', 'lakh', 'RERA', 'clubhouse',
      'My Home Apas', 'My Home Akara', 'My Home Tarkshya',
      'My Home 99', 'My Home Vihanga', 'My Home Bhooja',
    ]
    const keytermParams = keyterms.map(k => `&keyterm=${encodeURIComponent(k)}`).join('')

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
          // Deepgram's endpointing (speech_final / UtteranceEnd) is unreliable
          // on the VERY FIRST utterance after connection — it sometimes streams
          // only interims and never fires an end signal, hanging the turn.
          // For the first turn ONLY, we add a silence timer that resets on each
          // interim and fires after a generous 2000ms of no new words. After the
          // first turn succeeds, Deepgram's own signals are reliable and we drop
          // this entirely (it's cleared and never re-armed).
          if (!firstTurnDone) {
            clearTimeout(interimSafetyTimer)
            if (interimText.length > 0 || latestTranscript.length > 0) {
              interimSafetyTimer = setTimeout(() => {
                const text = (latestTranscript || interimText).trim()
                if (!text) return
                latestTranscript = ''
                interimText = ''
                if (Date.now() - lastFiredAt < 2500) return
                lastFiredAt = Date.now()
                console.log(`[STT] ⏱️ FIRST-TURN-SAFETY: "${text}"`)
                fireFinal(text)
              }, 2000)
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
          if (text) {
            clearTimeout(endSpeechTimer)
            latestTranscript = ''
            interimText = ''
            if (Date.now() - lastFiredAt < 2500) {
              console.log('[STT] (skipped duplicate UtteranceEnd)')
              return
            }
            lastFiredAt = Date.now()
            console.log(`[STT] ✅ UtteranceEnd: "${text}"`)
            fireFinal(text)
          }
        }

        if (msg.type === 'SpeechStarted') {
          if (!isAgentSpeaking) {
            console.log('[STT] 🎤 Speech started')
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
    if (!transcript) return
    clearTimeout(endSpeechTimer)
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

  async function handleUserTurn(transcript) {
    if (isBusy || finished || handoffTriggered) return
    isBusy = true
    bargeInRequested = false  // reset for this new turn
    ttsCancelled = false
    const t0 = Date.now()

    // Detect explicit handoff keyword in the caller's speech (Layer 1)
    const keywordHandoff = detectHandoffKeyword(transcript)
    if (keywordHandoff) {
      console.log(`[HANDOFF] 🔑 Keyword detected in: "${transcript}"`)
    }

    try {
      if (onTranscript) onTranscript(transcript)

      // Lock the TTS language for this whole turn based on the CALLER's language.
      // This prevents the TTS WebSocket from tearing down + reconnecting between
      // sentences when a reply mixes scripts (e.g. "Thank you, मधु. What issue?").
      const turnLang = detectLang(transcript)

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
      let fillerFired = false
      const fillerTimer = setTimeout(() => {
        if (firstSpoken || ttsCancelled) return
        const fillers = tenantConfig.filler_phrases || [
          'Let me check that for you.',
          'One moment, please.',
          'Sure, let me find that.',
        ]
        const filler = fillers[Math.floor(Math.random() * fillers.length)]
        fillerFired = true
        firstSpoken = true
        isAgentSpeaking = true
        console.log(`[FILLER] "${filler}"`)
        queue.push(streamTTSToTwilio(filler, twilioWs, streamSid, ttsClient, turnLang))
      }, 700)  // fires if no real reply within 700ms — masks the RAG+LLM gap

      let knowledge = ''
      if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
        // Build a context-aware search query. Vague follow-ups like "what are
        // my options?" don't embed well alone — they rely on what was discussed.
        // Prepend the caller's previous message so the search has context.
        const hist = getHistory(callSid)
        const prevUser = [...hist].reverse().find(m => m.role === 'user')
        const ragQuery = prevUser
          ? `${prevUser.content} ${transcript}`
          : transcript
        knowledge = await retrieveKnowledge(tenantConfig.tenant_id, ragQuery)
      }

      const cancelCheck = () => ttsCancelled

      const MAX_SENTENCES = tenantConfig.max_sentences || 2  // safety net on spoken length
      let sentenceCount = 0

      for await (const token of streamAIReply(callSid, transcript, tenantConfig, undefined, knowledge)) {
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
          const sentence = stripHandoffSignal(m[1].trim())
          buffer = (m[2] || '').trim()

          if (!sentence) continue  // skip if sentence was only the token

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
        const tail = stripHandoffSignal(buffer.trim())
        if (tail) {
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

      isBusy = false
      isAgentSpeaking = false
      speakCooldownUntil = Date.now() + 250
      latestTranscript = ''  // clear any echo captured during playback
      interimText = ''
      clearTimeout(endSpeechTimer)  // clear stale fallback timer
      clearTimeout(interimSafetyTimer)

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

  if (onReady) onReady()

  setTimeout(async () => {
    const greeting = 'Hi, how can I help you?'
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
    // audioChunk is already mulaw 8kHz from Twilio — send as-is
    dgWs.send(audioChunk)
  }

  const finish = () => {
    finished = true
    clearTimeout(endSpeechTimer)
    clearInterval(keepAliveTimer)
    ttsClient.close()
    disconnectDeepgram()
    console.log('[Deepgram STT] Connection closed')
  }

  return { send, finish }
}