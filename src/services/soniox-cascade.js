// soniox-cascade.js — a cascaded voice engine: Soniox STT → LLM → Soniox TTS.
//
// THE engine. Every call the platform makes runs through here: phone calls, the
// marketing demo, the builder's test call, and outbound campaigns.
//
// It replaced a speech-to-speech engine that spoke to the caller directly. That one
// re-billed the whole conversation on every turn and could not be tuned — no way to
// cache a prompt, pick a voice, mask a lookup, or measure where a second went. Here
// each piece is billed once for what it did, and each piece can be measured.
//
//   caller audio ──► Soniox STT (streaming, semantic endpointing)
//                        │  "<end>" = the caller finished their turn
//                        ▼
//                    LLM chat — Gemini or OpenAI (streaming, tools, prompt cache)
//                        │  tokens → sentences as they complete
//                        ▼
//                    normalizeForTts → Soniox TTS (one request per sentence,
//                        fetched in parallel, played strictly in order) ──► caller
//
// What it measures, per turn, is the point of building it: how long after the
// caller stopped speaking they heard the reply, and where that time went —
// endpointing, the model, tools, or the voice. And, per call, what it cost.
//
// Contract:
//   create(callSid, tenantConfig, sink, streamSid, onTranscript, onReady, callerNumber)
//     sink.send(JSON)   {event:'media', media:{payload}} | {event:'clear'}
//     sink.endCall()    optional — hang up once the queued audio has played
//     sink.msRemaining  optional — ms of agent audio the caller has not heard yet
//   → { send(mulaw8kBuffer), finish() }

import OpenAI from 'openai'
import WebSocket from 'ws'
import 'dotenv/config'
import { buildSystemPrompt } from './llm.js'
import { runLookup } from './lookups.js'
import { retrieveKnowledge, warmupRAG } from './rag.js'
import { resolveGreeting } from './greeting.js'
import { addToDnd } from './dnd.js'
import { whatsappReady } from './whatsapp.js'
import { buildAgentTools, handleSendWhatsapp, noKnowledgeInstruction, NO_KNOWLEDGE } from './agent-tools.js'
import { detectHandoffSignal, stripHandoffSignal, transferToHuman } from './handoff.js'
import { normalizeForTts, createSentenceChunker, createStreamChunker, scriptLanguage, dominantScript } from './tts-text.js'
import { createTtsSocket } from './soniox-tts-stream.js'
import { voiceTurnMessages } from './voice-turn-context.js'
import { acknowledgementFor, allAcknowledgements, familyFor } from './acknowledgements.js'
import { streamGemini } from './gemini-native.js'
import { cachedContentFor, forgetCache } from './gemini-cache.js'
import { createCascadeMeter, ratesFor } from './cascade-cost.js'
import telemetry from './telemetry.js'

const SONIOX_KEY = process.env.SONIOX_API_KEY
const STT_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const TTS_URL = 'https://tts-rt.soniox.com/tts'
const STT_MODEL = process.env.SONIOX_STT_MODEL || 'stt-rt-v5'
const TTS_MODEL = process.env.SONIOX_TTS_MODEL || 'tts-rt-v2'
const TTS_VOICE = process.env.SONIOX_TTS_VOICE || 'Adrian'

/**
 * The voice for THIS tenant. A business's voice belongs to the business, not to the
 * process — one env var meant every client on the server spoke in the same voice.
 * `voice` is not reused here: that field holds a Gemini Live voice name on tenants
 * created before the engine change, and handing "Kore" to Soniox is a 400 mid-call.
 *
 * A UUID is a voice cloned in the Soniox console; anything else is a built-in name.
 */
const voiceFor = (cfg = {}) => String(cfg.tts_voice || TTS_VOICE).trim()
// Callers are not pinned to a language (a Hyderabad number takes Telugu, Hindi and
// English), so every call hints all three and lets the audio decide.
const LANGUAGE_HINTS = (process.env.SONIOX_LANGUAGE_HINTS || 'te,hi,en').split(',').map(s => s.trim()).filter(Boolean)
// The brain speaks the OpenAI chat API. Gemini exposes the same API, so switching is
// configuration, not code: CASCADE_LLM_PROVIDER=gemini + a Gemini model id.
const LLM_PROVIDER = String(process.env.CASCADE_LLM_PROVIDER || 'openai').toLowerCase()
const LLM_MODEL = process.env.CASCADE_LLM_MODEL || (LLM_PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini')
const MAX_TOOL_ROUNDS = 4

// Soniox caps concurrent TTS requests per ORGANISATION. On a real call, six sentences
// fetched at once got four 429s and the caller heard half an answer. So requests are
// limited here — across every call in this process, not per call — and a 429 that
// still gets through is retried rather than dropped.
//
// Probed directly against the account: 3 streams succeed, the 4th gets
// "429: Concurrent requests limit for text-to-speech has been exceeded". We ran at 2
// and left a third of the budget unused. Note what this ceiling means at scale — it
// is the whole ORGANISATION, so three simultaneous speaking agents is the platform
// limit until Soniox raises it, whatever the call volume is.
const TTS_MAX_CONCURRENT = Number(process.env.SONIOX_TTS_MAX_CONCURRENT || 3)
const TTS_RETRIES = 3
let ttsInFlight = 0
const ttsWaiters = []   // { resolve, priority }, highest priority first, FIFO within one

/**
 * Take one of the organisation's TTS slots.
 *
 * Priority matters because the queue is shared across every call in the process. A
 * caller waiting in silence for the FIRST sentence of their answer should not sit
 * behind the fourth sentence of somebody else's, which is already playing out to a
 * caller who is listening. Plain FIFO made a second concurrent call's opening line
 * wait for a first call's whole reply.
 */
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

/**
 * Process-wide TTS queue health. Exported because the organisation's cap is shared by
 * every call this process handles: a single call looks fine while the fleet is
 * queueing, and the only way to see that is from here rather than from one call's log.
 */
const ttsStats = {
  maxConcurrentObserved: 0, maxQueueDepth: 0,
  firstSentenceWaitMs: 0, firstSentenceWaits: 0,
  laterSentenceWaitMs: 0, laterSentenceWaits: 0,
}
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

// Gemini thinks before answering unless told not to — dead air on a phone call.
// Models disagree on the lowest setting they accept (gemini-2.5-flash takes 'none',
// gemini-3.5-flash-lite only 'minimal'), so the lowest is tried first and whatever
// worked is remembered. CASCADE_LLM_REASONING_EFFORT pins it.
const REASONING_CHAIN = process.env.CASCADE_LLM_REASONING_EFFORT
  ? [process.env.CASCADE_LLM_REASONING_EFFORT]
  : LLM_PROVIDER === 'gemini' ? ['none', 'minimal', 'low'] : [null]
let reasoningIdx = 0

/**
 * Speak while a genuinely slow lookup runs, so the caller is not left in silence for
 * work that really is happening. See acknowledgements.js for the rules.
 *
 * On by default, because the alternative is measured: a knowledge turn leaves the
 * caller with ~4.2s of nothing. Set CASCADE_ACK=false to go back to silence.
 *
 * This REPLACES the old CASCADE_LOOKUP_FILLER, which spoke one fixed phrase and
 * deliberately excluded search_knowledge — which is to say, it excluded the one case
 * that actually costs the caller anything.
 */
const ACK_ENABLED = process.env.CASCADE_ACK
  ? process.env.CASCADE_ACK === 'true'
  : process.env.CASCADE_LOOKUP_FILLER !== 'false'
// How long after the process's first call starts to render the acknowledgement lines.
// Long enough that the greeting has the TTS slots to itself (it is done by ~1.5s),
// short enough to be ready before the caller's first question comes back. At 8s it was
// not: a real call reached its first knowledge turn first, found nothing cached, and
// the turn went unmasked.
const ACK_WARM_DELAY_MS = Number(process.env.CASCADE_ACK_WARM_DELAY_MS || 2500)
// Tools that already print a line of their own, with detail a generic one cannot.
const SELF_LOGGING_TOOLS = new Set(['search_knowledge', 'end_call'])

// How much evidence one search returns. Three was too few: on a real call the model
// asked for a plan's premium, got three chunks that did not hold the figure, and spent
// a SECOND round-trip going back for it — 1.4s of model time plus a full re-send of
// the conversation, for a number six chunks already contained. Measured against the
// live catalogue: 3 missed it, 6 had it, 9 and 12 added only tokens. Over-fetching a
// few thousand characters is far cheaper than another round-trip.
const KB_CHUNKS = Number(process.env.CASCADE_KB_CHUNKS || 6)

// Real-time TTS over a websocket, so audio starts before the sentence is finished.
// Set to 'false' to fall back to the REST endpoint — same voice, same audio, just
// one request per completed sentence.
const TTS_STREAMING = process.env.SONIOX_TTS_STREAMING !== 'false'

// How much of the opening clause to collect before handing it to the voice. Only the
// FIRST clause of a reply uses this; the caller is waiting in silence for that one and
// for nothing after it. Soniox's time-to-first-audio is flat in input length
// (scripts/ttfa-bench.mjs: 382ms for 12 characters, 428ms for a full sentence), so
// every extra character here is pure waiting. Too small is not free either — a
// two-word fragment gives the voice no prosodic context — so this is a floor, not zero.
const FIRST_CLAUSE_CHARS = Number(process.env.CASCADE_FIRST_CLAUSE_CHARS || 25)

/**
 * Reach Gemini through its own endpoint rather than the OpenAI-compatible one.
 *
 * Required for explicit prompt caching (the compat endpoint 400s on `cached_content`)
 * and slightly faster besides — measured ~1007ms to first token against ~1160ms, same
 * prompt, both streaming. Off for any other provider, which has no native path here.
 */
const NATIVE_GEMINI = LLM_PROVIDER === 'gemini' && process.env.CASCADE_GEMINI_NATIVE !== 'false'
// Hold the system prompt and tool schemas on Google's side. Only does anything on the
// native path; see gemini-cache.js for why it is explicit rather than implicit.
const GEMINI_CACHE = NATIVE_GEMINI && process.env.GEMINI_EXPLICIT_CACHE !== 'false'

/**
 * What the far end speaks.
 *
 * A phone line is 8kHz µ-law and always will be. A BROWSER is not, and there is no
 * reason to push a marketing demo or a builder test call through a telephony codec
 * just because production calls go that way — the caller is listening on a laptop
 * speaker. Soniox handles both ends of this natively (verified: its TTS emits
 * pcm_s16le at 16k, 24k and 48k as readily as µ-law at 8k), so the only thing that
 * changes is what we ask for.
 *
 * `audio_io: 'pcm'` on the tenant config selects the browser profile. Everything
 * downstream — byte accounting, playout timing, the cost meter — reads its rates from
 * here rather than assuming 8000 bytes a second.
 */
// The two directions do NOT share a byte rate. On the telephony profile they happen to
// be identical, which is why one `bytesPerSecond` survived review and then produced
// three separate wrong numbers the first time a browser called: the caller's 16kHz
// PCM16 is 32000 bytes a second while the agent's 24kHz reply is 48000. Anything that
// turns bytes into time has to say WHICH direction it is measuring.
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

// Acknowledgement audio, keyed by voice and text, for the life of the PROCESS. These
// lines never change, so the first call of a process pays to render them and every
// call after it plays them from memory — which is the point: audio that has to be
// synthesised before it can mask a delay is not masking much.
const ackCache = new Map()   // `${model}|${voice}|${lang}|${text}` → Promise<Buffer|null>

async function renderSpeech(text, language, voice = TTS_VOICE, profile = AUDIO_PROFILES.telephony) {
  await acquireTts()
  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SONIOX_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice, language, text, audio_format: profile.ttsFormat, sample_rate: profile.ttsRate }),
    })
    if (!res.ok) return null
    const chunks = []
    for await (const c of res.body) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  } catch {
    return null
  } finally {
    releaseTts()
  }
}

const ackKey = (text, lang, voice) => `${TTS_MODEL}|${voice}|${lang}|${text}`

/**
 * Render a line once per process and keep the buffer. Entries hold the settled audio
 * as well as the in-flight promise, because the caller needs to know whether it is
 * ready NOW — see ackAudioReady.
 */
function ackAudio(text, lang, voice = TTS_VOICE, profile = AUDIO_PROFILES.telephony) {
  const key = `${ackKey(text, lang, voice)}|${profile.ttsRate}`
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
 * Is this line's audio already rendered and sitting in memory?
 *
 * The whole promise of an acknowledgement is that it costs the answer nothing. A line
 * that still has to be synthesised breaks that promise: on a real call the first
 * knowledge turn arrived before the background warm-up had run, the line took ~1.7s to
 * render, and the answer — which was ready — queued behind it for 1470ms. The caller
 * heard "one moment" and then waited LONGER than if we had said nothing.
 *
 * So the rule is: mask only when masking is free. If the audio is not ready, stay
 * silent and start rendering it for next time.
 */
function ackAudioReady(text, lang, voice = TTS_VOICE, profile = AUDIO_PROFILES.telephony) {
  // A render that is still in flight is not ready either — only a settled buffer counts.
  return ackCache.get(`${ackKey(text, lang, voice)}|${profile.ttsRate}`)?.buf ?? null
}

/**
 * Render every acknowledgement line into the cache, in the background.
 *
 * Deliberately NOT done at call start: there are nine lines per language and the
 * organisation only has three TTS slots, so warming them all up front would push the
 * greeting to the back of the queue and make the start of the call worse to make the
 * middle of it better. Instead this runs once per process, after the first call has
 * had time to greet, one line at a time at the lowest priority.
 */
let ackWarmStarted = false
function warmAcknowledgements(voice, profile = AUDIO_PROFILES.telephony) {
  if (ackWarmStarted) return
  ackWarmStarted = true
  setTimeout(async () => {
    for (const { text, language } of allAcknowledgements()) {
      await ackAudio(text, language, voice, profile).catch(() => null)
    }
  }, ACK_WARM_DELAY_MS)
}

// A caller saying "hmm" or "okay" over the agent is listening, not interrupting.
const BARGE_IN_MIN_WORDS = Number(process.env.CASCADE_BARGE_IN_MIN_WORDS || 2)
const HANGUP_STALL_MS = Number(process.env.HANGUP_STALL_MS || 15000)

/**
 * Soniox's endpoint tuning is only sent when configured. An unrecognised field can
 * get the whole session rejected, and the defaults are a working starting point.
 *
 * MEASURE BEFORE YOU TOUCH THESE. The names read as though a higher
 * endpoint_latency_adjustment_level means a lower latency. It is the other way round:
 * scripts/endpoint-bench.mjs puts level 0 (Soniox's default) at ~830ms from the end
 * of the caller's last word to "<end>", level 2 at ~1200ms, and level 3 at ~1465ms —
 * and level 3 also cut "Yes, I am interested" down to "Yes.", firing mid-sentence and
 * splitting one turn into two. We shipped level 2 for months believing it was the
 * fast setting; it was costing every single turn 350ms.
 */
function endpointTuning() {
  const out = {}
  const n = (k) => process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : undefined
  const level = n('SONIOX_ENDPOINT_LATENCY_LEVEL')
  const sens = n('SONIOX_ENDPOINT_SENSITIVITY')
  const maxDelay = n('SONIOX_MAX_ENDPOINT_DELAY_MS')
  if (level !== undefined) out.endpoint_latency_adjustment_level = level
  if (sens !== undefined) out.endpoint_sensitivity = sens
  if (maxDelay !== undefined) out.max_endpoint_delay_ms = maxDelay
  return out
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
- WRITE EXACT FIGURES AS PLAIN DIGITS: 25, 8400, 3.5 crore, 98.4 percent, 1998. Never
  spell an amount or identifier out in words. Asked for words, models reach for the
  wrong alphabet and produce nonsense the voice cannot read — on a real call "twenty
  five" came out in Malayalam letters mid-Telugu sentence. Digits are turned into
  spoken English for you before the voice ever sees them. Everyday counting and
  expressions such as "రెండు options", "ఒకసారి", "दो options" and "एक मिनट" stay natural.
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

export function createBrainClient(provider = LLM_PROVIDER) {
  return provider === 'gemini'
    ? new OpenAI({ apiKey: process.env.GOOGLE_AI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' })
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}
const openai = createBrainClient()

/**
 * Open a streamed completion, whichever way this tenant's brain is reached.
 *
 * Gemini goes through its NATIVE endpoint when explicit prompt caching is on, because
 * Google's OpenAI-compatible endpoint rejects `cached_content` with a 400 — and explicit
 * caching is the only caching gemini-3.5-flash-lite does. Everything else, including
 * OpenAI itself, keeps the compatibility path. Both yield OpenAI-shaped chunks, so the
 * turn loop below never learns which one it got.
 *
 * A cache Google no longer recognises (expired between our check and the request) is
 * forgotten and the turn retried inline rather than failed — the caller is mid-sentence.
 */
async function openBrainStream(params, signal, cache) {
  if (cache?.name) {
    try {
      return streamGemini({
        apiKey: process.env.GOOGLE_AI_API_KEY,
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        cachedContent: cache.name,
        temperature: params.temperature,
        maxTokens: params.max_tokens,
        signal,
      })
    } catch (e) {
      if (signal?.aborted) throw e
      console.warn(`${'[SONIOX]'} cached request refused (${e.message.slice(0, 120)}) — retrying without the cache`)
      forgetCache(cache.name)
      telemetry.incr('gemini_cache_rejected')
    }
  }
  if (NATIVE_GEMINI) {
    return streamGemini({
      apiKey: process.env.GOOGLE_AI_API_KEY,
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      temperature: params.temperature,
      maxTokens: params.max_tokens,
      signal,
    })
  }
  for (let i = reasoningIdx; i < REASONING_CHAIN.length; i++) {
    const effort = REASONING_CHAIN[i]
    try {
      const stream = await openai.chat.completions.create(effort ? { ...params, reasoning_effort: effort } : params, { signal })
      reasoningIdx = i
      return stream
    } catch (e) {
      if (!signal?.aborted && effort && e?.status === 400 && i < REASONING_CHAIN.length - 1) continue
      throw e
    }
  }
}

export function createSonioxCascadeConnection(callSid, tenantConfig, sink, streamSid, onTranscript, onReady, callerNumber) {
  const trace = telemetry.getTrace(callSid)
  // 8kHz mu-law for a phone, 16k in / 24k PCM out for a browser. Everything that counts
  // bytes or converts them to milliseconds reads its rate from here — including the
  // cost meter, which is why the profile is resolved before anything else.
  const audio = profileFor(tenantConfig)
  const meter = createCascadeMeter(ratesFor(LLM_MODEL), audio)
  const tag = '[SONIOX]'

  if (!SONIOX_KEY) {
    console.error(`${tag} ⛔ SONIOX_API_KEY is not set — this call has no voice engine`)
    telemetry.recordServiceEvent({ component: 'soniox', severity: 'critical', kind: 'missing_key', detail: { callSid } })
    return { send() {}, finish() {} }
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
  const canHandoff = tenantConfig.enable_handoff !== false && !!tenantConfig.handoff_number
  const ttsVoice = voiceFor(tenantConfig)

  // One socket for the whole call. Opened now so its handshake is paid before the
  // greeting rather than in front of the caller's first answer.
  const ttsSocket = TTS_STREAMING ? createTtsSocket({
    apiKey: SONIOX_KEY, model: TTS_MODEL, voice: ttsVoice,
    audioFormat: audio.ttsFormat, sampleRate: audio.ttsRate,
    // The same organisation-wide cap the REST path respects. Without it a
    // five-sentence reply opened five streams at once, Soniox 429'd most of them,
    // and the caller heard a reply with holes in it.
    acquire: acquireTts, release: releaseTts, retries: TTS_RETRIES,
    onError: (msg) => {
      console.error(`${tag} TTS stream: ${msg}`)
      telemetry.recordServiceEvent({ component: 'soniox', severity: 'error', kind: 'tts_failure', detail: { callSid, error: msg } })
    },
  }) : null
  ttsSocket?.warm()

  const systemPrompt = buildSystemPrompt(tenantConfig, {
    // NOT 'speech': the model writes, Soniox reads. 'speech' told it to spell numbers
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

  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) warmupRAG(tenantConfig.tenant_id)

  // Warm the brain with the REAL system prompt while the greeting plays. On a real
  // call the first reply's model latency was 2378ms against ~1100–1600ms after; this
  // pays that cold start before the caller has asked anything, and puts the system
  // prompt in the provider's prompt cache so turn one is served from it.
  // Also settles which thinking setting this model accepts, so the first real turn
  // does not spend a round-trip finding out.
  ;(async () => {
    const base = { model: LLM_MODEL, max_tokens: 1, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'hi' }] }
    for (let i = reasoningIdx; i < REASONING_CHAIN.length; i++) {
      const effort = REASONING_CHAIN[i]
      try {
        const r = await openai.chat.completions.create(effort ? { ...base, reasoning_effort: effort } : base)
        reasoningIdx = i
        meter.addLlmUsage(r?.usage)
        return
      } catch (e) {
        if (effort && e?.status === 400 && i < REASONING_CHAIN.length - 1) continue
        return   // best-effort: a failed warmup must never break the call
      }
    }
  })()

  // ── Playback: TTS fetched in parallel, played strictly in order ─────────────
  const queue = []          // items: { text, turn, chunks[], done, cancelled, notify, controller }
  let pumping = false
  const drainWaiters = []

  function newItem(text, turn) {
    // The opening sentence of a turn outranks the rest of it when slots are scarce:
    // it is the one a caller is waiting on in silence. "Has any audio arrived yet"
    // is the wrong test — under contention NONE of a turn's sentences have audio yet,
    // so every one of them would claim priority and the ordering would do nothing.
    const first = !!turn && !turn.firstSentenceAt
    const item = {
      text, turn, chunks: [], done: false, cancelled: false, notify: null,
      controller: new AbortController(), requestedAt: Date.now(), firstByteAt: 0,
      priority: first ? 1 : 0,
    }
    if (first) turn.firstSentenceAt = item.requestedAt
    meter.addTtsChars(text.length)
    queue.push(item)
    return item
  }

  function speak(text, turn) {
    // [HANDOFF] is an instruction to this code, not a word. It arrives glued to the
    // last sentence of the reply, so it has to come off here — the one place every
    // path to the voice goes through. Missing it once had the agent say "HANDOFF"
    // aloud to a caller and then stay on the line.
    for (const sentence of normalizeForTts(stripHandoffSignal(text), { pronunciations: tenantConfig.tts_pronunciations })) {
      const item = newItem(sentence, turn)
      if (ttsSocket) {
        ttsSocket.begin(item, scriptLanguage(sentence), item.priority)
        ttsSocket.push(item, sentence)
        ttsSocket.end(item)
      } else {
        fetchSpeech(item)
      }
    }
    pump()
  }

  /**
   * Hands the voice a reply as the model writes it. A sentence is ONE stream, so its
   * prosody is continuous, but its opening clause is sent the moment it exists rather
   * than when the sentence is finished. Falls back to whole sentences via speak()
   * when streaming is off.
   */
  function createLiveSpeaker(turn) {
    const chunker = createStreamChunker({ firstClauseMinChars: FIRST_CLAUSE_CHARS })
    let open = null    // the item whose TTS stream is still accepting text

    function send({ text, final }) {
      const spoken = normalizeForTts(stripHandoffSignal(text), { pronunciations: tenantConfig.tts_pronunciations }).join(' ')
      if (spoken) {
        if (!open) {
          open = newItem(spoken, turn)
          // The opening clause of a reply is the one the caller is waiting on in
          // silence; everything after it is queued behind speech they can hear.
          ttsSocket.begin(open, scriptLanguage(spoken), open.priority)
          ttsSocket.push(open, spoken)
        } else {
          open.text += ' ' + spoken
          meter.addTtsChars(spoken.length + 1)
          ttsSocket.push(open, ' ' + spoken)
        }
      }
      if (final && open) { ttsSocket.end(open); open = null }
      pump()
    }

    return {
      push(token) { for (const p of chunker.push(token)) send(p) },
      flush() { for (const p of chunker.flush()) send(p) },
    }
  }

  async function fetchSpeech(item) {
    await acquireTts(item.priority || 0)
    try {
      for (let attempt = 0; ; attempt++) {
        if (item.cancelled) return
        const res = await fetch(TTS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SONIOX_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: TTS_MODEL, voice: ttsVoice, language: scriptLanguage(item.text),
            text: item.text, audio_format: audio.ttsFormat, sample_rate: audio.ttsRate,
          }),
          signal: item.controller.signal,
        })
        if (res.status === 429 && attempt < TTS_RETRIES) {
          await res.text().catch(() => {})
          telemetry.incr('soniox_tts_429')
          await new Promise(r => setTimeout(r, 150 * 2 ** attempt))
          continue
        }
        if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
        for await (const chunk of res.body) {
          if (item.cancelled) break
          if (!item.firstByteAt) item.firstByteAt = Date.now()
          item.chunks.push(Buffer.from(chunk))
          item.notify?.()
        }
        return
      }
    } catch (e) {
      if (!item.cancelled) {
        console.error(`${tag} TTS failed for "${item.text.slice(0, 60)}": ${e.message}`)
        telemetry.recordServiceEvent({ component: 'soniox', severity: 'error', kind: 'tts_failure', detail: { callSid, error: e.message } })
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
    // Last gate before the caller's ear. What actually stops stale audio today is
    // cancellation: interrupt() marks every queued item cancelled and pump() checks
    // that before it gets here, and respond() abandons the turn on the next stream
    // chunk. This is the backstop for the window between those two — an item created
    // for a turn that was abandoned a moment ago is not in the queue to be cancelled.
    // It is cheap, and the failure it prevents is the caller hearing the answer to a
    // question they have already moved on from.
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
      // queue, and that difference is the whole cost of this feature.
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
    // Soniox has no per-stream cancel, and a stream still generating is audio we pay
    // for and nobody hears. The socket reopens on the next sentence, while the caller
    // is still talking.
    ttsSocket?.reset()
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
   * Say something true while a slow lookup runs.
   *
   * Queued, not played over: the playback queue is strictly ordered, so the real
   * answer lands directly behind this line with no overlap and no gap. That ordering
   * is also why the lines are one clause long — whatever is still playing when the
   * answer is ready is time the answer has to wait, so an acknowledgement that
   * rambles turns into a delay instead of a mask.
   */
  function playAcknowledgement(turn, tool) {
    const ack = acknowledgementFor({ tool, language: turn.language, turn: turn.id, seed: callSid })
    if (!ack) return

    // Only mask when masking is free. A line that still has to be synthesised would
    // sit at the head of the playback queue with nothing in it, and the answer — which
    // may already be ready — waits behind it. Measured on a real call: the first
    // knowledge turn beat the background warm-up, the line took ~1.7s to render, and it
    // pushed the answer back 1470ms while saving only 663ms of silence. Worse than
    // silence, which is the one thing this feature must never be.
    const buf = ackAudioReady(ack.text, ack.language, ttsVoice, audio)
    if (!buf) {
      ackAudio(ack.text, ack.language, ttsVoice, audio).catch(() => null)   // ready for next time
      telemetry.incr('cascade_ack_skipped_cold')
      return
    }

    const item = {
      text: ack.text, turn, chunks: [buf], done: true, cancelled: false, notify: null,
      controller: new AbortController(), requestedAt: Date.now(), firstByteAt: Date.now(),
      filler: true, priority: 1,
    }
    turn.ackAt = Date.now()
    turn.ackText = ack.text
    // How long this line takes to play, so the turn log can say whether the answer ever
    // had to queue behind it. Agent audio, so it is the TTS rate, not the caller's.
    turn.ackAudioMs = Math.round(buf.length / (audio.ttsBytesPerSecond / 1000))
    queue.push(item)
    pump()
    console.log(`${tag} 💬 "${ack.text}" while ${tool} runs (${ack.family}/${ack.language})`)
  }

  // ── One conversational turn ─────────────────────────────────────────────────
  async function respond(userText, timing) {
    if (handedOff) return   // the transfer is already in flight; this leg is a person's now
    // The call is over. Closing the STT socket is not instant, so a final <end> can
    // still arrive after finish() has aborted everything and printed the cost line —
    // and a turn started here would generate and synthesise a reply to nobody, after
    // the meter that would have billed it has already reported. Observed on a demo
    // call: a "." transcript produced a full LLM round and a TTS render post-hangup.
    if (finished) return
    const turn = {
      id: ++turnSeq, controller: new AbortController(), done: false, ...timing,
      toolMs: 0, ragMs: 0, rounds: 0, toolNames: [],
    }
    current = turn
    messages.push({ role: 'user', content: userText })
    // Build each tool exchange privately until complete. An interrupted lookup
    // must not leave a dangling tool call in the next turn or append stale results
    // after the caller's correction.
    const turnMessages = [...messages]
    // Streaming hands the voice each clause as the model writes it; the fallback
    // waits for whole sentences. Same interface either way.
    const voice = ttsSocket
      ? createLiveSpeaker(turn)
      : (() => {
          const c = createSentenceChunker()
          return {
            push: (t) => { for (const s of c.push(t)) speak(s, turn) },
            flush: () => { for (const s of c.flush()) speak(s, turn) },
          }
        })()
    let spoken = ''

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const roundStartedAt = Date.now()
        turn.rounds = round + 1
        turn.llmRequestAt ||= roundStartedAt
        let roundFirstDeltaAt = null
        const wantTools = tools.length && round < MAX_TOOL_ROUNDS - 1
        // With a cache, the system prompt is held provider-side and the per-turn
        // guidance travels at the end of the conversation instead of inside it.
        const built = voiceTurnMessages(turnMessages, { separateGuidance: GEMINI_CACHE })
        const params = {
          model: LLM_MODEL,
          messages: GEMINI_CACHE ? built.messages : built,
          temperature: 0.3, max_tokens: 400, stream: true, stream_options: { include_usage: true },
        }
        if (wantTools) { params.tools = tools; params.tool_choice = 'auto' }
        // Only cache when the tools in this request match the tools in the cache — the
        // last tool round drops them, and a cache holding tool schemas would put them
        // back and undo the point of dropping them.
        const cache = GEMINI_CACHE && wantTools
          ? { name: cachedContentFor({ apiKey: process.env.GOOGLE_AI_API_KEY, model: LLM_MODEL, system: built.system, tools: toolDeclarations }) }
          : null
        if (!cache?.name && GEMINI_CACHE) params.messages = [{ role: 'system', content: built.system }, ...built.messages]
        const stream = await openBrainStream(params, turn.controller.signal, cache)
        if (turn.controller.signal.aborted) return

        const calls = []
        let finish = null
        let roundText = ''
        // OpenAI sends usage once at the end; Gemini repeats the running totals on
        // every chunk. Summing those counted one turn many times over and inflated
        // the cost line, so only the last report of a stream is counted.
        let usage = null
        for await (const chunk of stream) {
          if (turn.controller.signal.aborted) return
          if (chunk.usage) usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (!roundFirstDeltaAt && (choice.delta?.content || choice.delta?.tool_calls?.length)) {
            roundFirstDeltaAt = Date.now()
            turn.llmFirstDeltaAt ||= roundFirstDeltaAt
          }
          if (choice.finish_reason) finish = choice.finish_reason
          for (const tc of choice.delta?.tool_calls || []) {
            const k = tc.index ?? 0
            calls[k] ||= { id: '', type: 'function', function: { name: '', arguments: '' } }
            if (tc.id) calls[k].id = tc.id
            if (tc.function?.name) calls[k].function.name += tc.function.name
            if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments
            // Gemini 3 signs each tool call and rejects the next request (400) unless
            // the signature comes back with it. Carried through untouched; OpenAI
            // never sends one.
            if (tc.extra_content) calls[k].extra_content = tc.extra_content
            // The model is going to look something up and has said nothing yet. Fire
            // the moment the tool NAME arrives, not once the arguments have finished
            // streaming — the name is the first thing Soniox-bound work needs and
            // waiting for the rest of the call would hand back the time this saves.
            //
            // Every guard here matters. `!roundText.trim()` is the one that keeps this
            // honest: if the model wrote its own lead-in, saying ours on top of it is
            // the agent talking to itself.
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

        meter.addLlmUsage(usage)
        console.log(`${tag} ⏱️ LLM round ${round + 1}: first delta ${roundFirstDeltaAt ? roundFirstDeltaAt - roundStartedAt : '?'}ms · total ${Date.now() - roundStartedAt}ms`)

        const toolCalls = calls.filter(Boolean)
        // Tool calls are what matter, not finish_reason: OpenAI ends a tool round with
        // 'tool_calls', Gemini with 'stop'. Checking the reason alone meant a Gemini
        // lookup was treated as an empty answer — the caller heard "one moment" and
        // then nothing.
        if (toolCalls.length) {
          // Say whatever came before the tool call ("let me check") while it runs.
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
            // search_knowledge and end_call print their own, more useful, line. Every
            // other tool used to run silently: a call where the agent offered a
            // brochure and then said it had none showed only "tools 437ms".
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
          continue
        }

        voice.flush()
        spoken += roundText
        break
      }
    } catch (e) {
      if (turn.controller.signal.aborted) return
      console.error(`${tag} LLM failed: ${e.message}`)
      telemetry.recordServiceEvent({ component: 'soniox', severity: 'error', kind: 'llm_failure', detail: { callSid, error: e.message } })
      speak('Sorry, could you say that again?', turn)
    }

    if (turn.controller.signal.aborted) return
    // The marker is stripped from the history too. Left in, the model saw its own
    // [HANDOFF] in the last turn and emitted it again on every turn after — three
    // in a row on one call, each one a transfer that never happened.
    const handingOff = detectHandoffSignal(spoken)
    const text = stripHandoffSignal(spoken)
    if (text) {
      messages.push({ role: 'assistant', content: text })
      onTranscript?.(text, 'assistant')
      console.log(`${tag} Agent: "${text}"`)
      // What the voice is actually given, which is not always what the model wrote.
      // Without this line a scrambled number can only be diagnosed by ear.
      const spoken = normalizeForTts(text).join(' ')
      if (spoken !== text) console.log(`${tag} 🔊 voice: "${spoken}"`)
      // Letters from an alphabet this call is not being held in: the model reaching
      // for a neighbouring script, which the voice reads as gibberish.
      const strayScript = spoken.match(/[ഀ-ൿ஀-௿ಀ-೿]/g)
      if (strayScript && !['ml', 'ta', 'kn'].includes(scriptLanguage(text))) {
        console.warn(`${tag} ⚠️ reply contains ${strayScript.length} character(s) of another Indic script — the voice will mangle them: "${strayScript.join('')}"`)
        telemetry.incr('cascade_stray_script')
      }
      trace?.set('lastAgentReply', text.slice(0, 300))
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
   * Where the caller's wait actually went, leg by leg.
   *
   * The number that matters is PERCEIVED: first audio out, minus the moment the caller
   * stopped speaking. Everything else exists to say which leg to go and fix. speechEnd
   * is not invented — it is Soniox's own end_ms for the last word of the turn, mapped
   * back to the wall-clock time at which that byte range was sent (see audioMsToWall),
   * so it survives the burst of buffered audio at the start of a call.
   *
   * Measured baselines for this stack, so an outlier is recognisable as one:
   *   endpointing ~830ms · LLM first token ~1150ms · chunker ~110ms · TTS ~420ms
   * A tool round adds roughly another 1500ms, which is why rounds are printed.
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
      SONIOX_TTS: t.ttsFirstByteMs ?? null,
    }
    const perceived = since(t.speechEndAt, t.firstAudioAt)
    const answerMs = since(t.speechEndAt, t.answerAudioAt)

    // The largest leg, which is the only part of this a human should have to read.
    const ranked = Object.entries(legs).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])
    const primary = ranked[0]
    const fmt = ([k, v]) => `${k} ${v}ms`

    console.log(
      `${tag} ⏱️ [VOICE_LATENCY] turn ${t.id}` +
      `${t.rounds > 1 ? ` · ${t.rounds} model rounds${t.toolNames.length ? ` [${t.toolNames.join(',')}]` : ''}` : ''}\n` +
      `${tag}    ${ranked.map(fmt).join(' · ')}\n` +
      `${tag}    PERCEIVED ${perceived ?? '?'}ms` +
      `${primary ? ` · bottleneck ${primary[0]}` : ''}`
    )

    // On a masked turn the caller's SILENCE and the answer's arrival are two different
    // numbers, and reporting only one of them tells the wrong story either way.
    // "delayed the answer by" is the number that decides whether this feature is
    // helping: if the acknowledgement is still playing when the answer is ready, the
    // mask has turned into a queue.
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
      // P95 is the number that decides whether a call felt slow, and an average hides
      // it. Kept per call so the dashboard can show the tail, not just the mean.
      const seen = trace?.state.replyLatencies || []
      trace?.set('replyLatencies', [...seen, perceived].slice(-200))
      if (primary) trace?.bump(`bottleneck:${primary[0]}`)
    }
    if (legs.ENDPOINTING != null) telemetry.recordLatency('stt_endpoint', legs.ENDPOINTING, { tenantId })
    if (legs.LLM_TTFT != null) telemetry.recordLatency('llm_ttft', legs.LLM_TTFT, { tenantId })
    if (legs.TEXT_CHUNKING != null) telemetry.recordLatency('chunker', legs.TEXT_CHUNKING, { tenantId })
    if (legs.RAG != null) telemetry.recordLatency('rag', legs.RAG, { tenantId })
    if (legs.TOOL_CALL != null) telemetry.recordLatency('tool_call', legs.TOOL_CALL, { tenantId })
    if (t.ttsFirstByteMs != null) telemetry.recordLatency('tts_ttfb', t.ttsFirstByteMs, { tenantId })
  }

  // ── STT ──────────────────────────────────────────────────────────────────────
  let utterance = ''            // finalized text of the caller's current turn
  let heardLangs = new Map()    // language → characters, over the current turn
  // The same tally, but for the WHOLE call, and it is not just a statistic: the lead
  // extractor is told which language the call was in, and without that it has to infer
  // one from the text — which filed Telugu calls as Hindi often enough to be a known
  // problem. The old speech-to-speech engine fed this from a LanguageManager; when it
  // went, nothing wrote it and the extractor silently went back to guessing.
  // Soniox's per-token identification is a better source than either: it is what the
  // recogniser actually heard, not what the script it chose implies.
  const callLangs = new Map()
  let lastFinalEndMs = 0        // audio time at which the last finalized word ended
  let wordsWhileSpeaking = 0    // for barge-in: new caller words since the agent began

  // Soniox reports word timings in AUDIO time (ms since the stream began). To say
  // how long the caller waited, that has to become WALL time. Audio buffered while
  // the socket connected is flushed in one burst, so a fixed offset would run fast;
  // instead remember when each byte range was actually sent, and look it up.
  let streamedBytes = 0
  const sentAt = []             // [cumulativeBytes, wallMs] per chunk
  function audioMsToWall(ms) {
    // Bytes per millisecond of CALLER audio — 8 on a phone line, 32 from a browser.
    // Hardcoding 8 here does not fail loudly: the lookup just lands on a chunk from
    // early in the call, so every turn reports an endpointing delay roughly equal to
    // the call's own length and the bottleneck always reads ENDPOINTING.
    const target = ms * (audio.sttBytesPerSecond / 1000)
    for (let i = sentAt.length - 1; i >= 0; i--) {
      if (sentAt[i][0] < target) return (sentAt[i + 1] || sentAt[i])[1]
    }
    return sentAt[0]?.[1] ?? null
  }

  function connectStt() {
    if (finished) return
    sttAttempts++
    sttStats.connections++
    const ws = new WebSocket(STT_URL)
    stt = ws
    ws.on('open', () => {
      ws.send(JSON.stringify({
        api_key: SONIOX_KEY, model: STT_MODEL,
        audio_format: audio.sttFormat, sample_rate: audio.sttRate, num_channels: 1,
        language_hints: LANGUAGE_HINTS,
        // Soniox writes one script per utterance, so a Telugu speaker who switches to
        // English can come back spelled in Telugu letters — and the reply follows the
        // letters into the wrong language. This tags every token with the language it
        // actually heard, which is the only place that truth exists.
        enable_language_identification: true,
        enable_endpoint_detection: true,
        ...endpointTuning(),
      }))
      // A new session starts a new audio clock.
      streamedBytes = 0
      sentAt.length = 0
      lastFinalEndMs = 0
      utterance = ''
      heardLangs = new Map()
      console.log(`${tag} Connected ✅ (stt: ${STT_MODEL}, tts: ${TTS_MODEL}/${ttsVoice}, llm: ${LLM_PROVIDER}/${LLM_MODEL}${REASONING_CHAIN[reasoningIdx] ? ` (thinking: ${REASONING_CHAIN[reasoningIdx]})` : ''}, hints: ${LANGUAGE_HINTS.join('/')})`)
      if (onReady) onReady()
    })

    ws.on('message', (raw) => {
      if (finished) return   // draining a socket that is on its way out; see respond()
      let m
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.error_code || m.error_message) {
        console.error(`${tag} ⛔ STT error ${m.error_code}: ${m.error_message}`)
        telemetry.recordServiceEvent({ component: 'soniox', severity: 'critical', kind: 'stt_error', detail: { callSid, code: m.error_code, error: m.error_message } })
        return
      }
      let partial = ''
      let endpoint = false
      for (const tok of m.tokens || []) {
        if (tok.text === '<end>') { endpoint = true; continue }
        if (tok.is_final) {
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
      // The language Soniox HEARD, which is not always the alphabet it wrote it in.
      const heard = [...heardLangs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      heardLangs = new Map()
      // The call's language so far, for the post-call lead extractor. Recomputed each
      // turn rather than at hangup, because a call can end in ways that never reach a
      // clean teardown and a lead with no language is the thing being avoided.
      const dominant = [...callLangs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      if (dominant) trace?.set('dominantLanguage', dominant)
      if (!text) return
      const endpointAt = Date.now()
      const speechEndAt = lastFinalEndMs ? audioMsToWall(lastFinalEndMs) : null
      // A caller who switched to English and came back in Telugu letters gets answered
      // in Telugu, because the only thing the brain sees is the letters. Printing both
      // makes that visible in the log instead of only on the caller's ear.
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
      // What language to acknowledge in. Soniox's own per-token language identification
      // is the better signal than the script it wrote: a caller who switched to English
      // can come back spelled in Telugu letters, and answering "let me check" in Telugu
      // at an English speaker is worse than saying nothing. The script is the fallback
      // for when identification is off or unsure.
      const language = heard || written || 'en'
      respond(text, { endpointAt, speechEndAt, language })
        .catch(e => console.error(`${tag} turn failed: ${e.message}`))
    })

    ws.on('error', (e) => {
      console.error(`${tag} STT socket error: ${e.message}`)
      sttStats.errors++
      telemetry.incr('soniox_stt_errors')
    })
    ws.on('close', (code) => {
      if (finished) return
      sttStats.reconnects++
      console.warn(`${tag} STT closed (code=${code})${sttAttempts < 3 ? ' — reconnecting' : ''}`)
      telemetry.recordServiceEvent({ component: 'soniox', severity: 'warning', kind: 'stt_reconnect', detail: { callSid, code, attempt: sttAttempts } })
      telemetry.incr('soniox_stt_reconnects')
      if (sttAttempts < 3) setTimeout(connectStt, 300)
    })
  }

  // The greeting does not need the caller's audio, so it starts now rather than once
  // STT has connected. Measured: Soniox's first TTS request of a session takes ~1.2s
  // to its first byte (warm requests ~400–550ms), so every millisecond of head start
  // lands directly on how long the caller waits for "Namaste".
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
  // Render the acknowledgement lines once per process, well after the greeting has
  // taken the TTS slots it needs. See warmAcknowledgements.
  if (ACK_ENABLED) warmAcknowledgements(ttsVoice, audio)
  connectStt()

  return {
    send(chunk) {
      if (!stt || stt.readyState !== WebSocket.OPEN) return
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
      ttsSocket?.close()
      try { stt?.send(''); stt?.close() } catch { /* already gone */ }

      try {
        const mins = trace ? (Date.now() - trace.startedAt) / 60000 : meter.summary().sttSeconds / 60
        const u = meter.summary(mins)
        const perMin = mins > 0.1 ? ` · ₹${(u.allInInr / mins).toFixed(2)}/min` : ''
        console.log(
          `${tag} 💰 call cost ≈ ₹${u.allInInr}${perMin} — ` +
          `STT ${u.sttSeconds}s ₹${u.byPartInr.stt} · LLM ${u.promptTokens} in (${u.cachedTokens} cached) / ${u.completionTokens} out ₹${u.byPartInr.llm} · ` +
          // Characters as well as seconds: Soniox bills the audio, Sarvam and
          // ElevenLabs bill the text, and without both numbers a vendor comparison
          // has to be reconstructed by counting transcripts by hand.
          `TTS ${u.ttsSeconds}s / ${u.ttsChars} chars ₹${u.byPartInr.tts} · ` +
          (u.telephonyInr
            ? `telephony ${mins.toFixed(1)}min ₹${u.telephonyInr}`
            : 'telephony NOT included (set TELEPHONY_INR_PER_MIN)')
        )
        trace?.set('usage', { engine: 'soniox', ...u })
      } catch { /* never let accounting break a hangup */ }
      console.log(`${tag} Connection closed`)
    },
  }
}
