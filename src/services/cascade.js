// cascade.js — the voice engine: Sarvam STT → Gemini → Telnyx TTS.
//
// THE engine. Every call the platform makes runs through here: phone calls, the
// marketing demo, the builder's test call, and outbound campaigns.
//
//   caller audio ──► Sarvam STT (streaming; a turn ends after SARVAM_STT_SILENCE_MS of
//                        │         silence — see sarvam-stt.js)
//                        ▼
//                    Gemini (native API, streaming, tools, explicit prompt cache)
//                        │  tokens → sentences as they complete
//                        ▼
//                    normalizeForTts → Telnyx Ultra (one request per sentence, fetched
//                        in parallel, played strictly in order) ──► caller
//
// Why these three, each measured on real GSK calls and replays:
//   Sarvam  ended every turn 1.1-1.4s after the last word; Soniox's semantic endpointing
//           took 0.5-7.8s and once never ended a turn at all.
//   Gemini  3.5-flash-lite searched the knowledge base when it should and answered from
//           it; ~1s to first token, most of it a fixed cost per request.
//   Telnyx  Ultra (Cartesia Sonic-3) generates ~6x faster than real time: 0 mid-reply
//           stalls in 12 replayed replies, against 59s of silence from Soniox.
//
// What it measures, per turn, is the point: how long after the caller stopped speaking
// they heard the reply, and where that time went. And, per call, what it cost.
//
// Contract:
//   create(callSid, tenantConfig, sink, streamSid, onTranscript, onReady, callerNumber)
//     sink.send(JSON)   {event:'media', media:{payload}} | {event:'clear'}
//     sink.endCall()    optional — hang up once the queued audio has played
//     sink.msRemaining  optional — ms of agent audio the caller has not heard yet
//   → { send(audioBuffer), finish() }

import 'dotenv/config'
import { buildSystemPrompt } from './llm.js'
import { runLookup } from './lookups.js'
import { retrieveKnowledge, warmupRAG, knowledgeVocabulary, whenKnowledgeLoaded } from './rag.js'
import { resolveGreeting } from './greeting.js'
import { addToDnd } from './dnd.js'
import { whatsappReady } from './whatsapp.js'
import { buildAgentTools, handleSendWhatsapp, noKnowledgeInstruction, NO_KNOWLEDGE } from './agent-tools.js'
import { detectHandoffSignal, stripHandoffSignal, transferToHuman } from './handoff.js'
import { isFarewell, callerWantsToStay } from './farewell.js'
import { normalizeForTts, createSentenceChunker, scriptLanguage, dominantScript } from './tts-text.js'
import { streamTelnyxSpeech } from './telnyx-tts.js'
import { resolveVoice } from './telnyx-voices.js'
import { openSarvamStt } from './sarvam-stt.js'
import { voiceTurnMessages, compactHistory } from './voice-turn-context.js'
import { acknowledgementFor, allAcknowledgements, familyFor, siblingAcknowledgements } from './acknowledgements.js'
import { streamGemini } from './gemini-native.js'
import { cachedContentFor, forgetCache } from './gemini-cache.js'
import { createCascadeMeter, ratesFor, billableChars } from './cascade-cost.js'
import telemetry from './telemetry.js'

const SARVAM_KEY = process.env.SARVAM_API_KEY
const TELNYX_KEY = String(process.env.TELNYX_API_KEY || '').trim()
const GOOGLE_KEY = process.env.GOOGLE_AI_API_KEY

// ── Listening (Sarvam) ──────────────────────────────────────────────────────
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL || 'saaras:v3-realtime'
// Silence that ends a caller's turn. Replayed against real lines: 500ms ended turns in
// ~1.2s but split one at an ordinary gap between two sentences; 800ms kept them whole
// at ~1.55s. A split is survivable — the caller keeps talking, which interrupts the
// half-turn and both halves reach the model — but it wastes a model round.
const SARVAM_SILENCE_MS = Number(process.env.SARVAM_STT_SILENCE_MS || 600)
// codemix writes English words inside Telugu/Hindi in English letters.
const SARVAM_STT_MODE = process.env.SARVAM_STT_MODE || 'codemix'
const SARVAM_KEYTERMS = process.env.SARVAM_STT_KEYTERMS || ''

// ── Thinking (Gemini) ───────────────────────────────────────────────────────
const LLM_MODEL = process.env.CASCADE_LLM_MODEL || 'gemini-3.5-flash-lite'
// Hold the system prompt and tool schemas on Google's side (see gemini-cache.js).
// gemini-3.5-flash-lite does no implicit caching; explicit caching cuts input cost ~63%.
const GEMINI_CACHE = process.env.GEMINI_EXPLICIT_CACHE !== 'false'
const MAX_TOOL_ROUNDS = 4

// What runs on a call, for logs and the Operations Center.
export const PIPELINE = Object.freeze({ stt: 'sarvam', llm: 'gemini', tts: 'telnyx', label: 'sarvam → gemini → telnyx' })

// ── Speaking (Telnyx) ───────────────────────────────────────────────────────
// Telnyx has no organisation-wide stream cap, only rate limits. The limiter still
// matters under load: it keeps a caller waiting for the FIRST sentence of their answer
// from queueing behind the fourth sentence of somebody else's.
const TTS_MAX_CONCURRENT = Number(process.env.TELNYX_TTS_MAX_CONCURRENT || 10)
const TTS_RETRIES = 3
let ttsInFlight = 0
const ttsWaiters = []   // { resolve, priority }, highest priority first, FIFO within one

const acquireTts = (priority = 0) => {
  if (ttsInFlight < TTS_MAX_CONCURRENT) {
    ttsInFlight++
    ttsStats.maxConcurrentObserved = Math.max(ttsStats.maxConcurrentObserved, ttsInFlight)
    return Promise.resolve()
  }
  // Queued. How long a sentence waits here is invisible on a single test call and can
  // be the dominant latency under load, so it is recorded rather than inferred.
  const queuedAt = Date.now()
  ttsStats.maxQueueDepth = Math.max(ttsStats.maxQueueDepth, ttsWaiters.length + 1)
  return new Promise(resolve => {
    let i = ttsWaiters.length
    while (i > 0 && ttsWaiters[i - 1].priority < priority) i--
    ttsWaiters.splice(i, 0, {
      priority,
      resolve: () => {
        const waited = Date.now() - queuedAt
        const bucket = priority > 0 ? 'firstSentence' : 'laterSentence'
        ttsStats[`${bucket}WaitMs`] += waited
        ttsStats[`${bucket}Waits`]++
        telemetry.recordLatency(`tts_queue_wait_${bucket}`, waited)
        resolve()
      },
    })
  })
}
const releaseTts = () => { const next = ttsWaiters.shift(); if (next) next.resolve(); else ttsInFlight-- }

const ttsStats = {
  maxConcurrentObserved: 0, maxQueueDepth: 0,
  firstSentenceWaitMs: 0, firstSentenceWaits: 0,
  laterSentenceWaitMs: 0, laterSentenceWaits: 0,
}
/** Process-wide TTS queue health — a single call looks fine while the fleet queues. */
export function ttsQueueStats() {
  const mean = (total, n) => (n ? Math.round(total / n) : 0)
  return {
    activeStreams: ttsInFlight,
    queueDepth: ttsWaiters.length,
    maxConcurrentObserved: ttsStats.maxConcurrentObserved,
    maxQueueDepth: ttsStats.maxQueueDepth,
    limit: TTS_MAX_CONCURRENT,
    firstSentenceQueueWaitMs: mean(ttsStats.firstSentenceWaitMs, ttsStats.firstSentenceWaits),
    laterSentenceQueueWaitMs: mean(ttsStats.laterSentenceWaitMs, ttsStats.laterSentenceWaits),
    queuedTotal: ttsStats.firstSentenceWaits + ttsStats.laterSentenceWaits,
  }
}

/**
 * Speak while a genuinely slow lookup runs, so the caller is not left in silence for
 * work that really is happening. See acknowledgements.js for the rules. Measured: a
 * knowledge turn leaves the caller with ~4.2s of nothing. CASCADE_ACK=false turns it off.
 */
const ACK_ENABLED = process.env.CASCADE_ACK !== 'false'
// How long after the process's first call starts to render the acknowledgement lines:
// after the greeting (done by ~1.5s), before the caller's first question comes back.
const ACK_WARM_DELAY_MS = Number(process.env.CASCADE_ACK_WARM_DELAY_MS || 2500)
// Tools that already print a line of their own, with detail a generic one cannot.
const SELF_LOGGING_TOOLS = new Set(['search_knowledge', 'end_call'])

// How much evidence one search returns. Three was too few: on a real call the model
// asked for a plan's premium, got three chunks that did not hold the figure, and spent
// a SECOND round-trip going back for it. Measured against the live catalogue: 3 missed
// it, 6 had it, 9 and 12 added only tokens.
const KB_CHUNKS = Number(process.env.CASCADE_KB_CHUNKS || 6)

// What the model re-reads each turn: full lookup results for the last few caller turns,
// and at most this many turns overall. See compactHistory in voice-turn-context.js.
const HISTORY_TOOL_TURNS = Number(process.env.CASCADE_HISTORY_TOOL_TURNS || 2)
const HISTORY_MAX_TURNS = Number(process.env.CASCADE_HISTORY_MAX_TURNS || 24)

// A caller saying "hmm" or "okay" over the agent is listening, not interrupting.
const BARGE_IN_MIN_WORDS = Number(process.env.CASCADE_BARGE_IN_MIN_WORDS || 2)
const HANGUP_STALL_MS = Number(process.env.HANGUP_STALL_MS || 15000)

/**
 * What the far end speaks. A phone line is 8kHz µ-law; a BROWSER (the marketing demo,
 * the builder's test call) gets 16kHz PCM in and 24kHz PCM out — no reason to push a
 * laptop speaker through a telephony codec. `audio_io: 'pcm'` on the tenant config
 * selects it. Everything that turns bytes into time reads its rate from here.
 *
 * The two directions do NOT share a byte rate. On the telephony profile they happen to
 * be identical, which is why one `bytesPerSecond` survived review and then produced
 * three separate wrong numbers the first time a browser called.
 */
const AUDIO_PROFILES = {
  telephony: {
    sttFormat: 'mulaw', sttRate: 8000,
    ttsFormat: 'pcm_mulaw', ttsRate: 8000,
    sttBytesPerSecond: 8000,       // µ-law: one byte per sample
    ttsBytesPerSecond: 8000,
  },
  pcm: {
    sttFormat: 'pcm_s16le', sttRate: 16000,
    ttsFormat: 'pcm_s16le', ttsRate: 24000,
    sttBytesPerSecond: 32000,      // 16kHz × 2 bytes per sample
    ttsBytesPerSecond: 48000,      // 24kHz × 2 bytes per sample
  },
}
const profileFor = (cfg = {}) => (cfg.audio_io === 'pcm' ? AUDIO_PROFILES.pcm : AUDIO_PROFILES.telephony)

// ── Acknowledgement audio ───────────────────────────────────────────────────
// Rendered once per PROCESS and kept: these lines never change, so the first call of a
// process pays to render them and every call after plays them from memory. Audio that
// has to be synthesised before it can mask a delay is not masking much.
const ackCache = new Map()   // `${voice}|${lang}|${text}|${rate}` → { buf, promise }

async function renderSpeech(text, language, voice, profile) {
  await acquireTts()
  try {
    const chunks = []
    for await (const c of streamTelnyxSpeech({ apiKey: TELNYX_KEY, voice, text, format: profile.ttsFormat, sampleRate: profile.ttsRate, language })) chunks.push(c)
    return chunks.length ? Buffer.concat(chunks) : null
  } catch {
    return null
  } finally {
    releaseTts()
  }
}

const ackKey = (text, lang, voice, profile) => `${voice}|${lang}|${text}|${profile.ttsRate}`

function ackAudio(text, lang, voice, profile) {
  const key = ackKey(text, lang, voice, profile)
  let entry = ackCache.get(key)
  if (!entry) {
    entry = { buf: null }
    entry.promise = renderSpeech(text, lang, voice, profile).then(buf => {
      if (!buf) ackCache.delete(key)   // try again next time rather than cache a failure
      else entry.buf = buf
      return buf
    })
    ackCache.set(key, entry)
  }
  return entry.promise
}

/**
 * Is this line's audio already rendered? Only a settled buffer counts. A line that still
 * has to be synthesised would sit at the head of the playback queue while the answer —
 * maybe already ready — waited behind it: on a real call that pushed an answer back
 * 1470ms to save 663ms of silence. Mask only when masking is free.
 */
function ackAudioReady(text, lang, voice, profile) {
  return ackCache.get(ackKey(text, lang, voice, profile))?.buf ?? null
}

/** Render every acknowledgement line into the cache, in the background, once per process. */
let ackWarmStarted = false
function warmAcknowledgements(voice, profile) {
  if (ackWarmStarted) return
  ackWarmStarted = true
  setTimeout(async () => {
    for (const { text, language } of allAcknowledgements()) {
      await ackAudio(text, language, voice, profile).catch(() => null)
    }
  }, ACK_WARM_DELAY_MS)
}

// The model writes text for a voice to read — a different job from speaking
// directly. A romanized Telugu sentence is read with English phonetics and comes out
// unintelligible, so the script rule is the one that matters most. (No language
// labels here on purpose: a label in the prompt is a label the model can say aloud.)
export const VOICE_OUTPUT_RULES = `
WHAT YOU READ IS A TRANSCRIPT, AND IT SPELLS A WHOLE TURN IN ONE ALPHABET
- ENGLISH WRITTEN IN TELUGU OR DEVANAGARI LETTERS IS STILL ENGLISH. "వాట్ ఇస్ ద నీడ్"
  is a caller speaking English, not Telugu. Judge by the WORDS, never by the letters
  they arrived in, and answer in the language the words are.

YOUR REPLY IS READ ALOUD BY A TEXT-TO-SPEECH VOICE
- Write Telugu in Telugu script and Hindi in Devanagari script. Never spell Telugu or
  Hindi words in English letters — the voice reads English letters with English
  sounds, and the caller hears nonsense.
- WRITE THE WORDS PEOPLE SAY, NOT THE WORDS BOOKS USE. Native script does not mean
  formal language. Keep everyday local grammar and use familiar English terms where
  they fit. Do not replace words mechanically or shorten sentences into fragments.
- Tinglish/Hinglish describes the spoken mix, not romanized spelling. Keep Telugu
  endings in Telugu and Hindi endings in Devanagari, even next to an English term:
  "policy గురించి", "payment చేశారా?", "payment हो गया?".
- Style examples only — never copy their facts or ask their questions unless relevant:
  Telugu clarification: "ఏ plan గురించి అడుగుతున్నారు?"
  Telugu explanation: "ఈ plan లో రెండు options ఉన్నాయి. మీకు ఏది కావాలి?"
  Telugu payment check: "Payment చేశారా?"
  Hindi clarification: "आप कौन से plan की बात कर रहे हैं?"
  Hindi explanation: "इस plan में दो options हैं. आपको कौन सा चाहिए?"
  Hindi payment check: "Payment हो गया?"
  These illustrate sentence structure, not a required reply template. Most answers
  need no follow-up question. Use the same everyday register in other languages.
- Business and product words stay in English letters inside the sentence: policy,
  premium, cover, claim, plan, sum assured, rider, term insurance, and every product
  and company name — exactly as a bilingual colleague would write them.
- Keep a product's exact identity and variant name consistent across replies. Never
  translate a brand's meaning or substitute a similar-sounding policy. Local-language
  names may use their established native spelling; ordinary English brands stay English.
- Write honorifics in the surrounding language: "అండి", "గారు", "जी". Never glue
  Latin "andi" onto a Telugu word, and do not add an honorific to every sentence.
- Call search_knowledge silently, without an introductory sentence. Answer directly
  from earlier tool results when they already contain the requested fact. An explanation
  of a term already defined there does not need a fresh search. Search for missing
  conditions or benefits before claiming them. Do not announce a search in any language.
- WRITE EXACT FIGURES AS PLAIN DIGITS, in this format: 25, 3.5 crore, 1998. Those numbers
  show the format only — they are not facts about this business and are never to be
  repeated as one. Never spell an amount or identifier out in words. Asked for words,
  models reach for the wrong alphabet and produce nonsense the voice cannot read — on
  a real call "twenty five" came out in Malayalam letters mid-Telugu sentence. Digits
  are turned into spoken English for you before the voice ever sees them. Everyday
  counting and expressions such as "రెండు options", "ఒకసారి", "दो options" and
  "एक मिनट" stay natural.
- Plain spoken sentences only. No lists, bullet points, markdown, emojis or symbols.
- Use one short sentence for a simple fact, and usually two to four for advice or an
  explanation. Complete the useful thought; do not make the caller drag it out of you.

BEFORE EACH REPLY, DECIDE WHAT THIS TURN NEEDS
- Track the caller's goal and the unresolved decision. A sales enquiry needs a helpful
  guide, not a catalogue reader. Product names without a meaningful difference do not
  help them choose. Do not ask them to recommend a product to themselves.
- If asked to pick, explain a grounded starting choice and the relevant trade-off,
  then ask the one missing question needed to tailor it. Do not claim a universal best.
- If asked to explain, explain on the call. If asked for a quote, use THEIR amount and
  age, not a convenient example row. Distinguish optional riders from included cover.
- Keep price conditions: an indicative annual premium before tax is not a confirmed
  quote or a monthly amount. Say that it is indicative and before tax in natural words.
  Preserve the event covered too: death cover does not mean anything that happens.
- In an active buying conversation, after a quote help with the next unresolved
  choice, such as whether the annual amount fits their budget. Do not leave the
  caller to drive every step. Ask only if that choice is still open and relevant.
- If corrected, discard the mistaken interpretation. During a quote discussion, an
  unclear phrase may be a misheard amount: confirm the amount, do not turn it into a
  rider or a new product. Never repeat a denial after they correct your understanding.
- Talk in everyday local grammar. In Telugu, prefer natural phrases like "ఉన్నాయి",
  "వస్తుంది", "చేయొచ్చు", "మీకు ఎంత cover కావాలి?" over brochure-style phrasing.
  Use ordinary connectors like "ఇంకా", "కానీ", "అంటే" rather than repeated "మరియు".
- These are decisions to make silently, not headings or a script to read aloud.`

/**
 * One streamed model reply, as OpenAI-shaped chunks (see gemini-native.js).
 *
 * With a cache, the system prompt and tools are held on Google's side and only the
 * conversation is sent. A cache Google no longer recognises (expired between our check
 * and the request) is forgotten and the request retried with the prompt inline — but
 * only before anything was said, or the caller would hear the start of a reply twice.
 * The earlier version of this retry could never run: it wrapped the CALL in try/catch,
 * and a generator does nothing until it is read, so the refusal surfaced later.
 */
async function* brainStream({ system, messages, tools, cache, signal, timing = {}, maxTokens = 400 }) {
  const base = { apiKey: GOOGLE_KEY, model: LLM_MODEL, tools, temperature: 0.3, maxTokens, signal, timing }
  if (cache) {
    let started = false
    try {
      for await (const chunk of streamGemini({ ...base, messages, cachedContent: cache })) { started = true; yield chunk }
      return
    } catch (e) {
      if (started || signal?.aborted) throw e
      console.warn(`[CASCADE] cached request refused (${String(e.message).slice(0, 120)}) — retrying without the cache`)
      forgetCache(cache)
      telemetry.incr('gemini_cache_rejected')
      timing.cache = 'refused → inline'
    }
  }
  yield* streamGemini({ ...base, messages: [{ role: 'system', content: system }, ...messages] })
}

export function createCascadeConnection(callSid, tenantConfig, sink, streamSid, onTranscript, onReady, callerNumber) {
  const trace = telemetry.getTrace(callSid)
  // 8kHz mu-law for a phone, 16k in / 24k PCM out for a browser. Everything that counts
  // bytes or converts them to milliseconds reads its rate from here — including the
  // cost meter, which is why the profile is resolved before anything else.
  const audio = profileFor(tenantConfig)
  const meter = createCascadeMeter(ratesFor(LLM_MODEL), audio)
  const tag = '[CASCADE]'

  // Without a way to hear the caller there is no call to run.
  if (!SARVAM_KEY) {
    console.error(`${tag} ⛔ SARVAM_API_KEY is not set — this call cannot hear the caller`)
    telemetry.recordServiceEvent({ component: 'sarvam_stt', severity: 'critical', kind: 'missing_key', detail: { callSid } })
    return { send() {}, finish() {} }
  }
  if (!TELNYX_KEY) {
    console.error(`${tag} ⛔ TELNYX_API_KEY is not set — the agent cannot speak`)
    telemetry.recordServiceEvent({ component: 'telnyx_tts', severity: 'critical', kind: 'missing_key', detail: { callSid } })
  }
  if (!GOOGLE_KEY) {
    console.error(`${tag} ⛔ GOOGLE_AI_API_KEY is not set — the agent cannot think`)
    telemetry.recordServiceEvent({ component: 'gemini', severity: 'critical', kind: 'missing_key', detail: { callSid } })
  }

  let finished = false
  let stt = null
  let sttAttempts = 0
  let greeted = false

  // Every turn of this call gets an id, and every piece of audio carries the id of the
  // turn that produced it. Nothing reaches the caller without matching the turn that
  // is currently live — see sendAudio. Without this, audio synthesised for turn N can
  // still be in flight when turn N+1 starts and the caller hears the answer to a
  // question they already moved on from.
  let turnSeq = 0
  const sttStats = { connections: 0, reconnects: 0, errors: 0 }

  // Per-call tool state.
  const lookupState = { identityChallengeSent: false, identityVerified: false, spokenDigits: new Set(), rows: new Map() }
  const sentWhatsapp = new Set()
  let endCallRequested = false
  let hangupSafetyTimer = null
  let handedOff = false
  let ttsRefusedLogged = false
  const canHandoff = tenantConfig.enable_handoff !== false && !!tenantConfig.handoff_number
  const ttsVoice = resolveVoice(tenantConfig)

  const systemPrompt = buildSystemPrompt(tenantConfig, {
    // NOT 'speech': the model writes, the voice reads. 'speech' told it to spell numbers
    // out as words at the same time as VOICE_OUTPUT_RULES told it to write digits.
    channel: 'voice',
    whatsapp: whatsappReady(tenantConfig),
    language: { modelLed: true },
  }) + '\n\n' + VOICE_OUTPUT_RULES
  const messages = [{ role: 'system', content: systemPrompt }]

  // Kept in Gemini's own shape as well: the prompt cache stores tool declarations
  // alongside the system prompt, and they are ~1000 static tokens of every request.
  const toolDeclarations = buildAgentTools(tenantConfig)[0]?.functionDeclarations || []
  const tools = toolDeclarations.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } },
  }))
  const cacheFor = (system) => (GEMINI_CACHE ? cachedContentFor({ apiKey: GOOGLE_KEY, model: LLM_MODEL, system, tools: toolDeclarations }) : null)

  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) warmupRAG(tenantConfig.tenant_id)

  // The network's share of every model request: a Google API call that runs no model.
  // Twice, keeping the faster, because the first also pays for the TLS handshake that
  // later requests reuse — which also leaves a warm connection for the first turn.
  let googleRttMs = null
  if (GOOGLE_KEY) {
    ;(async () => {
      for (let i = 0; i < 2; i++) {
        const t0 = Date.now()
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}?key=${GOOGLE_KEY}`)
          await res.text()
          if (!res.ok) return
        } catch { return }
        const ms = Date.now() - t0
        googleRttMs = googleRttMs == null ? ms : Math.min(googleRttMs, ms)
      }
      console.log(`${tag} 🌐 Google API round trip ${googleRttMs}ms — the network floor under every model request`)
    })()
    // Start building this tenant's prompt cache now, while the greeting plays, so the
    // first turn is served from it rather than sending ~12,000 tokens inline.
    cacheFor(voiceTurnMessages(messages, { separateGuidance: true }).system)
  }

  // ── Playback: TTS fetched in parallel, played strictly in order ─────────────
  const queue = []          // items: { text, turn, chunks[], done, cancelled, notify, controller }
  let pumping = false
  const drainWaiters = []

  function newItem(text, turn) {
    // The opening sentence of a turn outranks the rest of it when slots are scarce:
    // it is the one a caller is waiting on in silence.
    const first = !!turn && !turn.firstSentenceAt
    const item = {
      text, turn, chunks: [], done: false, cancelled: false, notify: null,
      controller: new AbortController(), requestedAt: Date.now(), firstByteAt: 0,
      priority: first ? 1 : 0,
    }
    if (first) turn.firstSentenceAt = item.requestedAt
    meter.addTtsChars(billableChars(text))
    queue.push(item)
    return item
  }

  function speak(text, turn) {
    // [HANDOFF] is an instruction to this code, not a word. It arrives glued to the
    // last sentence of the reply, so it has to come off here — the one place every
    // path to the voice goes through. Missing it once had the agent say "HANDOFF"
    // aloud to a caller and then stay on the line.
    for (const sentence of normalizeForTts(stripHandoffSignal(text), { pronunciations: tenantConfig.tts_pronunciations })) {
      fetchSpeech(newItem(sentence, turn))
    }
    pump()
  }

  /**
   * One sentence from Telnyx, streamed into the item as it arrives: chunks[] in order,
   * done when nothing more is coming, cancelled drops the rest. A 429 is retried rather
   * than leaving a hole in the reply — but only before any audio arrived, or the retry
   * would say the start twice.
   */
  async function fetchSpeech(item) {
    await acquireTts(item.priority || 0)
    try {
      for (let attempt = 0; ; attempt++) {
        if (item.cancelled) return
        try {
          for await (const chunk of streamTelnyxSpeech({
            apiKey: TELNYX_KEY, voice: ttsVoice, text: item.text, format: audio.ttsFormat,
            sampleRate: audio.ttsRate, language: scriptLanguage(item.text), signal: item.controller.signal,
          })) {
            if (item.cancelled) break
            if (!item.firstByteAt) item.firstByteAt = Date.now()
            item.chunks.push(chunk)
            item.notify?.()
          }
          return
        } catch (e) {
          if (e?.status === 429 && attempt < TTS_RETRIES && !item.chunks.length && !item.cancelled) {
            telemetry.incr('telnyx_tts_429')
            await new Promise(r => setTimeout(r, 150 * 2 ** attempt))
            continue
          }
          throw e
        }
      }
    } catch (e) {
      if (!item.cancelled) {
        // There is no second voice to fall back on, so a refusal is silence for the
        // caller. A 402 means the Telnyx balance ran out — every sentence of every call
        // will fail the same way, which is an alert, not a log line.
        const balance = e?.status === 402 || /insufficient|balance/i.test(e?.message || '')
        console.error(`${tag} Telnyx TTS failed for "${item.text.slice(0, 60)}": ${e.message}`)
        if (!ttsRefusedLogged || !balance) {
          telemetry.recordServiceEvent({ component: 'telnyx_tts', severity: balance ? 'critical' : 'error', kind: balance ? 'tts_balance' : 'tts_failure', detail: { callSid, error: String(e.message).slice(0, 300) } })
        }
        if (balance) ttsRefusedLogged = true
      }
    } finally {
      releaseTts()
      item.done = true
      item.notify?.()
    }
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length) {
        const item = queue[0]
        let i = 0
        for (;;) {
          if (item.cancelled || finished) break
          if (i < item.chunks.length) { sendAudio(item.chunks[i++], item); continue }
          if (item.done) break
          await new Promise(r => {
            if (i < item.chunks.length || item.done || item.cancelled) r()
            else item.notify = r
          })
          item.notify = null
        }
        if (queue[0] === item) queue.shift()
      }
    } finally {
      pumping = false
      while (drainWaiters.length) drainWaiters.shift()()
    }
  }

  const playbackDrained = () => (queue.length || pumping) ? new Promise(r => drainWaiters.push(r)) : Promise.resolve()

  function sendAudio(buf, item) {
    const turn = item.turn
    // Last gate before the caller's ear: an item created for a turn that was abandoned
    // a moment ago is not in the queue to be cancelled, and its audio must not play.
    if (item.cancelled || finished) return
    if (turn && current && turn !== current && turn.id !== current.id) {
      telemetry.incr('cascade_stale_audio_dropped')
      return
    }
    if (turn && !turn.firstAudioAt) turn.firstAudioAt = Date.now()
    if (turn && !item.filler && !turn.answerAudioAt) {
      turn.answerAudioAt = Date.now()
      turn.ttsFirstByteMs = item.firstByteAt ? item.firstByteAt - item.requestedAt : null
      // When the answer's audio was READY, as opposed to when it got played. On a
      // masked turn those differ by however much acknowledgement was still in the
      // queue, and that difference is the whole cost of that feature.
      turn.answerReadyAt = item.firstByteAt || turn.answerAudioAt
    }
    // A cached filler is played many times but was synthesised (and billed) once.
    if (!item.filler) meter.addTtsAudio(buf.length)
    if (sink.readyState === 1) sink.send(JSON.stringify({ event: 'media', streamSid, media: { payload: buf.toString('base64') } }))
  }

  const agentSpeaking = () => queue.length > 0 || (typeof sink.msRemaining === 'function' && sink.msRemaining() > 0)

  // ── Barge-in ─────────────────────────────────────────────────────────────────
  let current = null   // the turn being generated / played
  // Busy = audible OR still being generated. Checking only audio would let a caller
  // who speaks during a slow lookup start a second turn alongside the first.
  const busy = () => agentSpeaking() || (current !== null && !current.done)
  function interrupt(why) {
    if (current && !current.done) { current.controller.abort(); current.done = true }
    for (const item of queue) { item.cancelled = true; item.controller.abort(); item.notify?.() }
    queue.length = 0
    if (sink.readyState === 1) sink.send(JSON.stringify({ event: 'clear', streamSid }))
    console.log(`${tag} ✋ barge-in — ${why}`)
    trace?.bump('interruptions'); trace?.event('barge_in')
    telemetry.incr('interruptions_total')
  }

  // ── Tools (declared in agent-tools.js) ──────────────────────────────────────
  async function runTool(name, args) {
    if (name === 'search_knowledge') {
      const output = await retrieveKnowledge(tenantConfig.tenant_id, args?.query || '', KB_CHUNKS, { mode: args?.mode }) || noKnowledgeInstruction(tenantConfig)
      const miss = output.startsWith(NO_KNOWLEDGE)
      console.log(`${tag} 🔎 search_knowledge("${args?.query}") → ${miss ? 'MISS' : output.length + ' chars'}`)
      trace?.bump('knowledgeAsks')
      if (!miss) trace?.bump('knowledgeHits')
      else if (trace) {
        const q = String(args?.query || '').trim().slice(0, 300)
        const seen = trace.state.knowledgeMisses || []
        if (q && !seen.includes(q)) trace.set('knowledgeMisses', [...seen, q].slice(0, 20))
      }
      return output
    }
    if (name === 'add_to_dnd') {
      const res = await addToDnd({ tenantId: tenantConfig.tenant_id, phone: callerNumber, source: 'caller_request', reason: args?.reason || null })
      trace?.set('optedOut', res.ok)
      return res.ok
        ? 'Done — they have been removed and will not be contacted again. Confirm this warmly, then say goodbye and end the call.'
        : 'Could not record that automatically. Apologise, assure them it will be handled, and end the call politely.'
    }
    if (name === 'end_call') {
      if (typeof sink.endCall !== 'function') return 'You cannot end this call yourself. Say your closing line and then stop talking.'
      endCallRequested = true
      console.log(`${tag} 👋 end_call requested${args?.reason ? ` — ${String(args.reason).slice(0, 120)}` : ''}`)
      trace?.event('agent_ended_call', { reason: args?.reason || null })
      telemetry.incr('calls_ended_by_agent')
      clearTimeout(hangupSafetyTimer)
      hangupSafetyTimer = setTimeout(() => { if (!finished) sink.endCall('end_call stalled') }, HANGUP_STALL_MS)
      return 'The call will end as soon as you finish speaking. If you have not said goodbye yet, say it now, warmly and in the language of this conversation. Then stop — do not ask another question.'
    }
    if (name === 'send_whatsapp') return handleSendWhatsapp(tenantConfig, callerNumber, args || {}, sentWhatsapp)

    const hasArg = Object.values(args || {}).some(v => v !== null && v !== undefined && String(v).trim() !== '')
    if (!hasArg) {
      return `You called ${name} without any of the details it needs, so nothing could be looked up. ` +
        `Ask the caller for ONE identifying detail first — their customer ID or registered phone number — then call it again.`
    }
    return runLookup(tenantConfig, name, args, { callerNumber, state: lookupState })
  }

  /**
   * Say something true while a slow lookup runs. Queued, not played over: the real
   * answer lands directly behind this line with no overlap and no gap, which is also why
   * the lines are one clause long — whatever is still playing when the answer is ready
   * is time the answer has to wait.
   */
  function playAcknowledgement(turn, tool) {
    const ack = acknowledgementFor({ tool, language: turn.language, turn: turn.id, seed: callSid })
    if (!ack) return

    // The deterministic pick is one of three interchangeable lines. If that one is not
    // rendered yet, a sibling from the same family and language says the same thing and
    // the caller cannot tell which of the three they got.
    let spoken = ack
    let buf = ackAudioReady(ack.text, ack.language, ttsVoice, audio)
    if (!buf) {
      for (const alt of siblingAcknowledgements(ack)) {
        const altBuf = ackAudioReady(alt.text, alt.language, ttsVoice, audio)
        if (altBuf) { spoken = alt; buf = altBuf; break }
      }
    }
    if (!buf) {
      ackAudio(ack.text, ack.language, ttsVoice, audio).catch(() => null)   // ready for next time
      telemetry.incr('cascade_ack_skipped_cold')
      console.log(`${tag} 🔇 no "${ack.text}" for ${tool} — not rendered yet (${ack.family}/${ack.language}); this turn goes unmasked`)
      return
    }

    const item = {
      text: spoken.text, turn, chunks: [buf], done: true, cancelled: false, notify: null,
      controller: new AbortController(), requestedAt: Date.now(), firstByteAt: Date.now(),
      filler: true, priority: 1,
    }
    turn.ackAt = Date.now()
    turn.ackText = spoken.text
    // How long this line takes to play, so the turn log can say whether the answer ever
    // had to queue behind it. Agent audio, so it is the TTS rate, not the caller's.
    turn.ackAudioMs = Math.round(buf.length / (audio.ttsBytesPerSecond / 1000))
    queue.push(item)
    pump()
    console.log(`${tag} 💬 "${spoken.text}" while ${tool} runs (${spoken.family}/${spoken.language})`)
  }

  // ── One conversational turn ─────────────────────────────────────────────────
  async function respond(userText, timing) {
    if (handedOff) return   // the transfer is already in flight; this leg is a person's now
    // The call is over. A final transcript can still arrive after finish() has aborted
    // everything and printed the cost line — and a turn started here would generate and
    // synthesise a reply to nobody.
    if (finished) return
    const turn = {
      id: ++turnSeq, controller: new AbortController(), done: false, ...timing,
      toolMs: 0, ragMs: 0, rounds: 0, toolNames: [],
    }
    current = turn
    // Old lookup results out, before this turn is sent. See compactHistory.
    compactHistory(messages, { keepToolTurns: HISTORY_TOOL_TURNS, maxTurns: HISTORY_MAX_TURNS })
    messages.push({ role: 'user', content: userText })
    // Build each tool exchange privately until complete. An interrupted lookup
    // must not leave a dangling tool call in the next turn or append stale results
    // after the caller's correction.
    const turnMessages = [...messages]
    // Telnyx takes one finished sentence per request, so the reply is cut into
    // sentences as the model writes them.
    const chunker = createSentenceChunker()
    const voice = {
      push: (t) => { for (const s of chunker.push(t)) speak(s, turn) },
      flush: () => { for (const s of chunker.flush()) speak(s, turn) },
    }
    let spoken = ''

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const roundStartedAt = Date.now()
        turn.rounds = round + 1
        turn.llmRequestAt ||= roundStartedAt
        let roundFirstDeltaAt = null
        const wantTools = tools.length && round < MAX_TOOL_ROUNDS - 1
        // The system prompt is held in the cache (or sent inline); the per-turn guidance
        // travels at the end of the conversation either way.
        const built = voiceTurnMessages(turnMessages, { separateGuidance: true })
        // Only cache when the tools in this request match the tools in the cache — the
        // last tool round drops them, and a cache holding tool schemas would put them
        // back and undo the point of dropping them.
        const cache = wantTools ? cacheFor(built.system) : null
        // Where this round's time goes, phase by phase — see logRound.
        const timing = { round: round + 1, startedAt: roundStartedAt, cache: cache ? 'hit' : 'inline' }
        ;(turn.llmRounds ||= []).push(timing)
        const stream = brainStream({
          system: built.system, messages: built.messages, tools: wantTools ? tools : undefined,
          cache, signal: turn.controller.signal, timing,
        })

        const calls = []
        let roundText = ''
        // Gemini repeats the running usage totals on every chunk; only the last report
        // of a stream is counted, or one turn is billed many times over.
        let usage = null
        for await (const chunk of stream) {
          if (turn.controller.signal.aborted) return
          if (chunk.usage) usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (!roundFirstDeltaAt && (choice.delta?.content || choice.delta?.tool_calls?.length)) {
            roundFirstDeltaAt = Date.now()
            timing.firstDeltaAt = roundFirstDeltaAt
            timing.firstIsTool = !choice.delta?.content
            turn.llmFirstDeltaAt ||= roundFirstDeltaAt
          }
          for (const tc of choice.delta?.tool_calls || []) {
            const k = tc.index ?? 0
            calls[k] ||= { id: '', type: 'function', function: { name: '', arguments: '' } }
            if (tc.id) calls[k].id = tc.id
            if (tc.function?.name) calls[k].function.name += tc.function.name
            if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments
            // Gemini 3 signs each tool call and rejects the next request (400) unless
            // the signature comes back with it. Carried through untouched.
            if (tc.extra_content) calls[k].extra_content = tc.extra_content
            // The model is going to look something up and has said nothing yet. Fire
            // the moment the tool NAME arrives. `!roundText.trim()` keeps this honest:
            // if the model wrote its own lead-in, saying ours on top of it is the agent
            // talking to itself.
            if (tc.function?.name && ACK_ENABLED && !turn.ackAt && !turn.firstSentenceAt &&
                !roundText.trim() && familyFor(calls[k].function.name)) {
              playAcknowledgement(turn, calls[k].function.name)
            }
          }
          const token = choice.delta?.content
          if (!token) continue
          if (!turn.llmFirstTokenAt) turn.llmFirstTokenAt = Date.now()
          roundText += token
          voice.push(token)
        }
        if (turn.controller.signal.aborted) return

        meter.addLlmUsage(usage)
        timing.doneAt = Date.now()
        timing.tokens = {
          input: usage?.prompt_tokens ?? null,
          cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
          output: usage?.completion_tokens ?? null,
          thinking: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        }
        logRound(timing)

        const toolCalls = calls.filter(Boolean)
        // Tool calls are what matter, not finish_reason: Gemini ends a tool round with
        // 'stop', and checking the reason alone meant a lookup was treated as an empty
        // answer — the caller heard "one moment" and then nothing.
        if (toolCalls.length) {
          // Say whatever came before the tool call while it runs.
          voice.flush()
          spoken += roundText
          turnMessages.push({ role: 'assistant', content: roundText || null, tool_calls: toolCalls })
          const t0 = Date.now()
          // Independent KB reads in one model round can overlap. Never parallelize
          // account lookups or side effects; those can depend on earlier tool state.
          const kbResults = toolCalls.length > 1 && toolCalls.every(tc => tc.function.name === 'search_knowledge')
            ? await Promise.allSettled(toolCalls.map(tc => {
              let args = {}
              try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed */ }
              return runTool(tc.function.name, args)
            })) : null
          for (const tc of toolCalls) {
            if (turn.controller.signal.aborted) return
            let args = {}
            try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed */ }
            const span = trace?.span('tool_call', { tool: tc.function.name, args })
            turn.toolNames.push(tc.function.name)
            const toolStartedAt = Date.now()
            let result
            try {
              const prefetched = kbResults?.[toolCalls.indexOf(tc)]
              if (prefetched?.status === 'rejected') throw prefetched.reason
              result = String(prefetched ? prefetched.value : await runTool(tc.function.name, args))
              telemetry.incr(`tool:${tc.function.name}:ok`)
              span?.end({ payloadBytes: Buffer.byteLength(result) })
            } catch (e) {
              result = 'That information could not be retrieved right now.'
              console.error(`${tag} tool ${tc.function.name} failed: ${e.message}`)
              telemetry.incr(`tool:${tc.function.name}:error`)
              span?.end({ error: e })
            }
            if (!SELF_LOGGING_TOOLS.has(tc.function.name)) {
              console.log(`${tag} 🔧 ${tc.function.name}(${JSON.stringify(args).slice(0, 120)}) → ${String(result).slice(0, 160)}`)
            }
            // Knowledge lookups are timed apart from other tools: a slow KB search and
            // a slow CRM lookup need different fixes, and averaging them hides both.
            if (tc.function.name === 'search_knowledge') turn.ragMs += Date.now() - toolStartedAt
            turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: result })
          }
          if (turn.controller.signal.aborted || current !== turn) return
          messages.splice(0, messages.length, ...turnMessages)
          turn.toolMs += Date.now() - t0
          timing.toolStartAt = t0
          timing.toolEndAt = Date.now()
          timing.toolNames = toolCalls.map(tc => tc.function.name)
          continue
        }

        voice.flush()
        spoken += roundText
        break
      }
    } catch (e) {
      if (turn.controller.signal.aborted) return
      console.error(`${tag} LLM failed: ${e.message}`)
      telemetry.recordServiceEvent({ component: 'gemini', severity: 'error', kind: 'llm_failure', detail: { callSid, error: e.message } })
      speak('Sorry, could you say that again?', turn)
    }

    if (turn.controller.signal.aborted) return
    // The marker is stripped from the history too. Left in, the model saw its own
    // [HANDOFF] in the last turn and emitted it again on every turn after.
    const handingOff = detectHandoffSignal(spoken)
    const text = stripHandoffSignal(spoken)
    if (text) {
      messages.push({ role: 'assistant', content: text })
      onTranscript?.(text, 'assistant')
      console.log(`${tag} Agent: "${text}"`)
      // What the voice is actually given, which is not always what the model wrote.
      // Without this line a scrambled number can only be diagnosed by ear.
      const spokenForm = normalizeForTts(text).join(' ')
      if (spokenForm !== text) console.log(`${tag} 🔊 voice: "${spokenForm}"`)
      // Letters from an alphabet this call is not being held in: the model reaching
      // for a neighbouring script, which the voice reads as gibberish.
      const strayScript = spokenForm.match(/[ഀ-ൿ஀-௿ಀ-೿]/g)
      if (strayScript && !['ml', 'ta', 'kn'].includes(scriptLanguage(text))) {
        console.warn(`${tag} ⚠️ reply contains ${strayScript.length} character(s) of another Indic script — the voice will mangle them: "${strayScript.join('')}"`)
        telemetry.incr('cascade_stray_script')
      }
      trace?.set('lastAgentReply', text.slice(0, 300))

      // The model said goodbye in prose instead of calling end_call — which is what it
      // does every time (replayed: end_call fired 0/15 on five goodbyes).
      // The tool stays the primary path; this reads the same decision off the words.
      // See farewell.js for why matching the AGENT here is safe where the caller is not.
      if (!endCallRequested && turn.id > 1 && typeof sink.endCall === 'function' &&
          isFarewell(text) && !callerWantsToStay(userText)) {
        endCallRequested = true
        console.log(`${tag} 👋 agent said goodbye without calling end_call — closing the line`)
        trace?.event('agent_ended_call', { reason: 'farewell in reply' })
        telemetry.incr('calls_ended_by_farewell')
      }
    }

    await playbackDrained()
    turn.done = true
    logTurn(turn)

    // Transfer only once the caller has actually heard the sentence that explains it
    // — the transfer ends this media stream, so anything still queued is lost.
    if (handingOff && !handedOff) {
      handedOff = true
      if (!canHandoff) {
        console.warn(`${tag} ⚠️ model asked for a handoff but this tenant has no handoff_number — nowhere to transfer`)
        telemetry.incr('handoff_unavailable')
      } else {
        console.log(`${tag} 🔀 handing off to a person`)
        trace?.event('human_handoff', { reason: 'model signal' })
        trace?.set('intent', 'human_handoff')
        telemetry.incr('handoffs_total')
        onTranscript?.('[SYSTEM] Call handed off to human agent')
        transferToHuman(callSid, tenantConfig.handoff_number, callerNumber, tenantConfig)
          .catch(e => console.error(`${tag} handoff failed: ${e.message}`))
      }
    }

    if (endCallRequested && typeof sink.endCall === 'function' && !finished) {
      clearTimeout(hangupSafetyTimer)
      sink.endCall('agent said goodbye')
    }
  }

  /**
   * One model round's first token, split into what can actually be told apart.
   *
   * Google sends its HTTP headers only once the first token exists, so everything Google
   * does (queueing, reading the input, writing the first token) lands in one wait. What
   * CAN be separated is the network: googleRttMs is a request that does no model work,
   * timed at call start. Measured against the real GSK prompt, the Google share is mostly
   * a fixed cost per request — input size moves it by 100-300ms, not seconds.
   */
  function logRound(r) {
    const d = (a, b) => (a && b ? b - a : null)
    const v = (x) => (x == null ? '?' : x)
    const k = r.tokens || {}
    const fresh = k.input != null ? k.input - (k.cached || 0) : null
    const wait = d(r.sentAt, r.headersAt)                  // request out → headers back
    r.networkMs = googleRttMs
    const google = wait != null && googleRttMs != null ? Math.max(0, wait - googleRttMs) : null
    const parts = [
      `build ${v(d(r.startedAt, r.sentAt))}`,
      google != null ? `network ~${googleRttMs} · Google ~${google}` : `request→headers ${v(wait)}`,
    ]
    console.log(
      `${tag} ⏱️ LLM round ${r.round}: first ${r.firstIsTool ? 'tool call' : 'token'} ${v(d(r.startedAt, r.firstDeltaAt))}ms = ${parts.join(' · ')}` +
      ` | then ${v(d(r.firstDeltaAt, r.doneAt))}ms for ${v(k.output)} tok out` +
      ` | in ${v(k.input)} tok (${k.cached || 0} cached, ${v(fresh)} new, cache ${r.cache})` +
      `${k.thinking ? ` · ⚠️ thinking ${k.thinking} tok` : ' · thinking 0'}` +
      `${r.requestBytes ? ` · request ${Math.round(r.requestBytes / 1024)}KB` : ''}`
    )
  }

  /**
   * Where the caller's wait actually went, leg by leg. The number that matters is
   * PERCEIVED: first audio out, minus the moment the caller stopped speaking (Sarvam's
   * end of the last word, mapped back to wall-clock time — see audioMsToWall).
   */
  function logTurn(t) {
    if (!t.firstAudioAt) return
    const since = (a, b) => (a && b ? b - a : null)
    const legs = {
      ENDPOINTING: since(t.speechEndAt, t.endpointAt),
      LLM_TTFT: since(t.llmRequestAt, t.llmFirstDeltaAt),
      RAG: t.ragMs || null,
      TOOL_CALL: (t.toolMs || 0) - (t.ragMs || 0) || null,
      TEXT_CHUNKING: since(t.llmFirstTokenAt, t.firstSentenceAt),
      TTS: t.ttsFirstByteMs ?? null,
    }
    const perceived = since(t.speechEndAt, t.firstAudioAt)
    const answerMs = since(t.speechEndAt, t.answerAudioAt)
    // Wall-clock endpointing against the AUDIO the STT actually consumed to reach the
    // same decision. They should agree; where they do not, the audio clock has drifted
    // and ENDPOINTING is measuring our own bookkeeping rather than the caller's wait.
    const audioTail = t.audioMsAfterLastWord ?? null
    const drift = legs.ENDPOINTING != null && audioTail != null ? legs.ENDPOINTING - audioTail : null

    // The largest leg, which is the only part of this a human should have to read.
    const ranked = Object.entries(legs).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])
    const primary = ranked[0]
    const fmt = ([k, v]) => `${k} ${v}ms`

    console.log(
      `${tag} ⏱️ [VOICE_LATENCY] turn ${t.id}` +
      `${t.rounds > 1 ? ` · ${t.rounds} model rounds${t.toolNames.length ? ` [${t.toolNames.join(',')}]` : ''}` : ''}\n` +
      `${tag}    ${ranked.map(fmt).join(' · ')}\n` +
      `${tag}    PERCEIVED ${perceived ?? '?'}ms` +
      `${primary ? ` · bottleneck ${primary[0]}` : ''}` +
      `${audioTail != null ? ` · Sarvam chewed ${audioTail}ms of audio past the last word` : ''}` +
      `${drift != null && Math.abs(drift) > 400 ? ` · ⚠️ ${drift > 0 ? 'clock ran ahead' : 'clock lagged'} by ${Math.abs(drift)}ms` : ''}`
    )

    // Every milestone in ms after the caller stopped speaking, in the order they
    // happened — the whole wait laid out, so nobody has to add the legs up by hand.
    if (t.speechEndAt) {
      const at = (ts) => (ts ? `+${ts - t.speechEndAt}` : '?')
      const marks = [`endpoint ${at(t.endpointAt)}`]
      for (const r of t.llmRounds || []) {
        marks.push(`model asked ${at(r.sentAt || r.startedAt)}`, `first ${r.firstIsTool ? 'tool call' : 'token'} ${at(r.firstDeltaAt)}`)
        if (r.toolStartAt) marks.push(`${r.toolNames.join(',')} ${at(r.toolStartAt)}→${at(r.toolEndAt)}`)
      }
      if (t.ackAt) marks.push(`"let me check" plays ${at(t.firstAudioAt)}`)
      marks.push(`sentence to voice ${at(t.firstSentenceAt)}`, `voice first byte ${at(t.answerReadyAt)}`, `caller hears answer ${at(t.answerAudioAt)}`)
      console.log(`${tag}    TIMELINE ${marks.join(' → ')}`)
    }

    // On a masked turn the caller's SILENCE and the answer's arrival are two different
    // numbers. "delayed the answer by" decides whether masking is helping: if the
    // acknowledgement is still playing when the answer is ready, it has become a queue.
    if (t.ackAt && answerMs) {
      const ackEndsAt = (t.firstAudioAt || t.ackAt) + (t.ackAudioMs || 0)
      const heldAnswerBy = t.answerReadyAt ? Math.max(0, ackEndsAt - t.answerReadyAt) : null
      console.log(
        `${tag}    MASKED: silence ${perceived ?? '?'}ms ("${t.ackText}") · answer at ${answerMs}ms` +
        ` · saved ${answerMs - (perceived ?? answerMs)}ms of silence` +
        `${heldAnswerBy !== null ? ` · delayed the answer by ${heldAnswerBy}ms` : ''}`
      )
      const tid = trace?.tenantId
      telemetry.recordLatency('ack_first_audio', perceived, { tenantId: tid })
      telemetry.recordLatency('masked_silence_saved', answerMs - (perceived ?? answerMs), { tenantId: tid })
      if (heldAnswerBy) telemetry.recordLatency('ack_delayed_answer', heldAnswerBy, { tenantId: tid })
      telemetry.incr('cascade_ack_spoken')
    }

    const tenantId = trace?.tenantId
    if (perceived !== null) {
      telemetry.recordLatency('first_audio', perceived, { tenantId })
      trace?.set('lastLatencyMs', perceived)
      trace?.bump('replyCount'); trace?.bump('replyMsTotal', perceived)
      // P95 decides whether a call felt slow, and an average hides it.
      const seen = trace?.state.replyLatencies || []
      trace?.set('replyLatencies', [...seen, perceived].slice(-200))
      if (primary) trace?.bump(`bottleneck:${primary[0]}`)
      // Kept on the trace so it reaches call_traces with the rest of the call, instead
      // of living only in a console nobody kept. overAgent: the caller was talking while
      // the agent was audible — the one condition under which echo can reach the STT.
      const seenLegs = trace?.state.turnLegs || []
      trace?.set('turnLegs', [...seenLegs, {
        turn: t.id, perceived, ...legs, audioTail, rounds: t.rounds,
        tools: t.toolNames.length ? t.toolNames : undefined,
        masked: t.ackAt ? true : undefined, overAgent: t.overAgent || undefined, lang: t.language,
        // Each model round's first token, in parts — see logRound.
        llm: (t.llmRounds || []).map(r => ({
          build: since(r.startedAt, r.sentAt), wait: since(r.sentAt, r.headersAt), net: r.networkMs ?? undefined,
          after: since(r.headersAt, r.firstDeltaAt),
          in: r.tokens?.input, cached: r.tokens?.cached, think: r.tokens?.thinking || undefined, cache: r.cache || undefined,
        })),
      }].slice(-60))
    }
    if (legs.ENDPOINTING != null) telemetry.recordLatency('stt_endpoint', legs.ENDPOINTING, { tenantId })
    if (audioTail != null) telemetry.recordLatency('stt_endpoint_audio_tail', audioTail, { tenantId })
    if (drift != null) telemetry.recordLatency('audio_clock_drift', drift, { tenantId })
    if (legs.LLM_TTFT != null) telemetry.recordLatency('llm_ttft', legs.LLM_TTFT, { tenantId })
    if (legs.TEXT_CHUNKING != null) telemetry.recordLatency('chunker', legs.TEXT_CHUNKING, { tenantId })
    if (legs.RAG != null) telemetry.recordLatency('rag', legs.RAG, { tenantId })
    if (legs.TOOL_CALL != null) telemetry.recordLatency('tool_call', legs.TOOL_CALL, { tenantId })
    if (t.ttsFirstByteMs != null) telemetry.recordLatency('tts_ttfb', t.ttsFirstByteMs, { tenantId })
  }

  // ── Listening ────────────────────────────────────────────────────────────────
  // sarvam-stt.js turns Sarvam's events into this engine's STT messages: tokens marked
  // final or not, and an "<end>" token when the caller's turn is over.
  let utterance = ''            // finalized text of the caller's current turn
  let heardLangs = new Map()    // language → characters, over the current turn
  // The same tally for the WHOLE call. The lead extractor is told which language the
  // call was in; without it, it infers one from the text and filed Telugu calls as
  // Hindi often enough to be a known problem.
  const callLangs = new Map()
  let lastFinalEndMs = 0        // audio time at which the last finalized word ended
  let lastFinalTokenAt = null   // the same moment in WALL time
  let wordsWhileSpeaking = 0    // for barge-in: new caller words since the agent began
  let overAgent = false         // caller spoke while agent audio was playing, this turn

  // Word timings arrive in AUDIO time (ms since the stream began). To say how long the
  // caller waited, that has to become WALL time. Audio buffered while the socket
  // connected is flushed in one burst, so a fixed offset would run fast; instead
  // remember when each byte range was actually sent, and look it up.
  let streamedBytes = 0
  const sentAt = []             // [cumulativeBytes, wallMs] per chunk
  function audioMsToWall(ms) {
    // Bytes per millisecond of CALLER audio — 8 on a phone line, 32 from a browser.
    const target = ms * (audio.sttBytesPerSecond / 1000)
    for (let i = sentAt.length - 1; i >= 0; i--) {
      if (sentAt[i][0] < target) return (sentAt[i + 1] || sentAt[i])[1]
    }
    return sentAt[0]?.[1] ?? null
  }

  // The tenant's product names, as a hint for Sarvam — see knowledgeVocabulary.
  function sttVocabularyPrompt() {
    const words = tenantConfig.tenant_id ? knowledgeVocabulary(tenantConfig.tenant_id) : null
    return words?.length ? `Phone call to ${tenantConfig.business_name || 'a business'}. Product names you may hear: ${words.join(', ')}.` : ''
  }

  function connectStt() {
    if (finished) return
    sttAttempts++
    sttStats.connections++
    const vocabularyPrompt = sttVocabularyPrompt()
    const ws = openSarvamStt({
      apiKey: SARVAM_KEY, format: audio.sttFormat, sampleRate: audio.sttRate,
      silenceMs: SARVAM_SILENCE_MS, model: SARVAM_STT_MODEL, mode: SARVAM_STT_MODE,
      keyterms: SARVAM_KEYTERMS, prompt: vocabularyPrompt,
    })
    stt = ws
    // The first call after a restart connects before the knowledge has loaded; the
    // vocabulary is sent the moment it has, rather than waiting for the next call.
    if (!vocabularyPrompt && tenantConfig.tenant_id) {
      whenKnowledgeLoaded(tenantConfig.tenant_id).then(() => {
        const late = sttVocabularyPrompt()
        if (late && stt === ws) { ws.configure({ prompt: late }); console.log(`${tag} 🗣️ STT now listening for this tenant's product names (sent mid-call)`) }
      }).catch(() => {})
    }
    ws.on('open', () => {
      // A new session starts a new audio clock.
      streamedBytes = 0
      sentAt.length = 0
      lastFinalEndMs = 0
      lastFinalTokenAt = null
      utterance = ''
      heardLangs = new Map()
      console.log(`${tag} Connected ✅ (listens: sarvam/${SARVAM_STT_MODEL} ${SARVAM_STT_MODE}, turn ends after ${SARVAM_SILENCE_MS}ms silence · thinks: gemini/${LLM_MODEL} · speaks: telnyx/${ttsVoice})`)
      if (onReady) onReady()
    })

    ws.on('message', (raw) => {
      if (finished) return   // draining a socket that is on its way out; see respond()
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.error_code || m.error_message) {
        console.error(`${tag} ⛔ STT error ${m.error_code}: ${m.error_message}`)
        telemetry.recordServiceEvent({ component: 'sarvam_stt', severity: 'critical', kind: 'stt_error', detail: { callSid, code: m.error_code, error: m.error_message } })
        return
      }
      let partial = ''
      let endpoint = false
      for (const tok of m.tokens || []) {
        if (tok.text === '<end>') { endpoint = true; continue }
        if (!overAgent && tok.text.trim() && agentSpeaking()) overAgent = true
        if (tok.is_final) {
          if (tok.text.trim()) lastFinalTokenAt = Date.now()
          utterance += tok.text
          if (tok.language) {
            heardLangs.set(tok.language, (heardLangs.get(tok.language) || 0) + tok.text.length)
            callLangs.set(tok.language, (callLangs.get(tok.language) || 0) + tok.text.length)
          }
          if (tok.end_ms) lastFinalEndMs = tok.end_ms
          if (busy()) wordsWhileSpeaking += (tok.text.match(/[\p{L}\p{N}]+/gu) || []).length
        } else {
          partial += tok.text
        }
      }

      // The caller is talking over the agent with real words, not a backchannel.
      if (busy()) {
        const partialWords = (partial.match(/[\p{L}\p{N}]+/gu) || []).length
        if (wordsWhileSpeaking + partialWords >= BARGE_IN_MIN_WORDS) {
          interrupt(`caller said "${(utterance + partial).trim().slice(0, 60)}"`)
          wordsWhileSpeaking = 0
        }
      } else {
        wordsWhileSpeaking = 0
      }

      if (!endpoint) return
      const text = utterance.trim()
      utterance = ''
      const spokeOverAgent = overAgent
      overAgent = false
      // The language the STT HEARD, which is not always the alphabet it wrote it in.
      const heard = [...heardLangs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      heardLangs = new Map()
      // The call's language so far, for the post-call lead extractor. Recomputed each
      // turn rather than at hangup, because a call can end without a clean teardown.
      const dominant = [...callLangs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      if (dominant) trace?.set('dominantLanguage', dominant)
      if (!text) return
      const endpointAt = Date.now()
      const speechEndAt = lastFinalEndMs ? audioMsToWall(lastFinalEndMs) : null
      const lastWordAt = lastFinalTokenAt
      lastFinalTokenAt = null
      // How much AUDIO the STT had been given past the caller's last word when it ended
      // the turn — the check on ENDPOINTING (see logTurn).
      const audioMsSent = streamedBytes / (audio.sttBytesPerSecond / 1000)
      const audioMsAfterLastWord = lastFinalEndMs ? Math.round(audioMsSent - lastFinalEndMs) : null
      // A caller who switched language can come back spelled in the other alphabet, and
      // the only thing the brain sees is the letters. Printing both makes that visible.
      const written = dominantScript(text)
      const mismatch = heard && heard !== written
      console.log(`${tag} Caller${heard ? ` (${heard}${mismatch ? ` — written in ${written} script` : ''})` : ''}: "${text}"`)
      if (mismatch) telemetry.incr('cascade_script_mismatch')
      onTranscript?.(text, 'user')
      trace?.set('lastTranscript', text.slice(0, 300))

      // A lone "okay" while the agent is still talking is the caller listening.
      const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length
      if (busy()) {
        if (words < BARGE_IN_MIN_WORDS) return
        interrupt('caller finished a turn over the agent')
      }
      wordsWhileSpeaking = 0
      // What language to acknowledge in: what the STT heard beats the script it wrote —
      // answering "let me check" in Telugu at an English speaker is worse than silence.
      const language = heard || written || 'en'
      respond(text, { endpointAt, speechEndAt, lastWordAt, audioMsAfterLastWord, language, overAgent: spokeOverAgent })
        .catch(e => console.error(`${tag} turn failed: ${e.message}`))
    })

    ws.on('error', (e) => {
      console.error(`${tag} STT socket error: ${e.message}`)
      sttStats.errors++
      telemetry.incr('sarvam_stt_errors')
    })
    ws.on('close', (code) => {
      if (finished) return
      sttStats.reconnects++
      console.warn(`${tag} STT closed (code=${code})${sttAttempts < 3 ? ' — reconnecting' : ''}`)
      telemetry.recordServiceEvent({ component: 'sarvam_stt', severity: 'warning', kind: 'stt_reconnect', detail: { callSid, code, attempt: sttAttempts } })
      telemetry.incr('sarvam_stt_reconnects')
      if (sttAttempts < 3) setTimeout(connectStt, 300)
    })
  }

  // The greeting does not need the caller's audio, so it starts now rather than once
  // the STT has connected — every millisecond of head start lands directly on how long
  // the caller waits for "Namaste".
  function greet() {
    if (greeted) return
    greeted = true
    const greeting = resolveGreeting(tenantConfig)
    messages.push({ role: 'assistant', content: greeting })
    const greetTurn = { id: ++turnSeq, controller: new AbortController(), done: false, endpointAt: Date.now() }
    current = greetTurn
    speak(greeting, greetTurn)
    playbackDrained().then(() => {
      greetTurn.done = true
      if (greetTurn.firstAudioAt) console.log(`${tag} ⏱️ greeting first audio ${greetTurn.firstAudioAt - greetTurn.endpointAt}ms after the call connected`)
    })
    console.log(`${tag} Agent: "${greeting}"`)
  }

  greet()
  // Render the acknowledgement lines once per process, after the greeting. See
  // warmAcknowledgements.
  if (ACK_ENABLED) warmAcknowledgements(ttsVoice, audio)
  connectStt()

  return {
    send(chunk) {
      if (!stt || stt.readyState !== 1) return
      meter.addSttAudio(chunk.length)
      streamedBytes += chunk.length
      sentAt.push([streamedBytes, Date.now()])
      if (sentAt.length > 6000) sentAt.splice(0, 3000)   // ~60s of 20ms frames is plenty
      try { stt.send(chunk) } catch { /* closing */ }
    },
    finish() {
      if (finished) return
      finished = true
      clearTimeout(hangupSafetyTimer)
      if (current && !current.done) current.controller.abort()
      for (const item of queue) { item.cancelled = true; item.controller.abort() }
      queue.length = 0
      try { stt?.close() } catch { /* already gone */ }

      try {
        const mins = trace ? (Date.now() - trace.startedAt) / 60000 : meter.summary().sttSeconds / 60
        const u = meter.summary(mins)
        const perMin = mins > 0.1 ? ` · ₹${(u.allInInr / mins).toFixed(2)}/min` : ''
        console.log(
          `${tag} 💰 call cost ≈ ₹${u.allInInr}${perMin} — ` +
          `STT ${u.sttSeconds}s ₹${u.byPartInr.stt} · LLM ${u.promptTokens} in (${u.cachedTokens} cached) / ${u.completionTokens} out ₹${u.byPartInr.llm} · ` +
          `TTS ${u.ttsSeconds}s / ${u.ttsChars} chars ₹${u.byPartInr.tts} · ` +
          (u.telephonyInr
            ? `telephony ${mins.toFixed(1)}min ₹${u.telephonyInr}`
            : 'telephony NOT included (set TELEPHONY_INR_PER_BLOCK)')
        )
        trace?.set('usage', { engine: PIPELINE.label, ...u })
      } catch { /* never let accounting break a hangup */ }
      console.log(`${tag} Connection closed`)
    },
  }
}
