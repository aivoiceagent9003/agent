// services/language-manager.js — the authoritative conversation-language state machine.
//
// ─── ROOT CAUSE THIS FILE EXISTS TO FIX ──────────────────────────────────────
// The model decides its own reply language from the caller's transcript. On
// code-mixed Indian speech that is unstable: "Sir, naa EMI payment pending undi"
// is Telugu grammar carrying five English nouns, and the model would answer it in
// English — then in Hindi the next turn. The application, not the model, has to
// own the language.
//
// A second, subtler cause was found on real calls (2026-08-31): the previous
// version treated an Indic SCRIPT run in the caller transcript as unambiguous
// truth and committed at 0.97 confidence with no verification. But Gemini's
// inputAudioTranscription is a noisy side-channel — on this tenant's own calls it
// emitted Korean, Portuguese, and DEVANAGARI FOR TELUGU SPEECH. Two garbled
// Devanagari lines at the end of an 11-turn Telugu call were enough to flip the
// conversation to Hindi. Script is now strong EVIDENCE, never an instant verdict,
// and Devanagari is explicitly ambiguous (Hindi and Marathi share it).
//
// ─── THE RULE ────────────────────────────────────────────────────────────────
// A false switch is far worse for the caller than staying put one extra turn.
// Every ambiguous path in this file resolves to KEEP CURRENT LANGUAGE.
//
// ─── DESIGN ──────────────────────────────────────────────────────────────────
//   1. MEANING, not just language. Greetings ("Hello sir"), acknowledgements
//      ("okay", "haan", "ji") and filler NEVER decide the language.
//   2. PRIMARY (matrix) language, not word origin. Borrowed English business
//      nouns — EMI, loan, payment, account — are code-mixing, not a switch.
//   3. HYSTERESIS + CONFIRMATION + COOLDOWN. It is deliberately easier to stay
//      than to move: a switch needs high confidence, N consecutive meaningful
//      signals, and no recent switch.
//   4. EXPLICIT REQUESTS WIN, immediately, bypassing streak and cooldown.
//
// Latency: the obvious cases resolve synchronously with no network call. Only
// ambiguous Latin-script (romanised Telugu vs Hindi vs English) and ambiguous
// script reach the classifier.
//
// This module only DECIDES. Transport — when to inject a steer into the live
// session — stays in the engine, which must respect the model's turn state.

import { GoogleGenAI } from '@google/genai'

// ─── Canonical representation ────────────────────────────────────────────────
// ISO 639-1 codes internally, everywhere. Display names exist only for text we
// hand to a model (a prompt saying "reply in te" would be nonsense).
export const SUPPORTED_LANGUAGES = ['en', 'te', 'hi', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or']

export const LANGUAGE_NAMES = {
  en: 'English', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada',
  ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati',
  pa: 'Punjabi', or: 'Odia',
}

// Every spelling we might receive — a model verdict, tenant config, a legacy
// full-name value persisted before codes were canonical — maps to one code.
const ALIASES = {
  english: 'en', en: 'en', eng: 'en', 'en-in': 'en', 'en-us': 'en',
  telugu: 'te', te: 'te', tel: 'te', 'te-in': 'te',
  hindi: 'hi', hi: 'hi', hin: 'hi', 'hi-in': 'hi',
  tamil: 'ta', ta: 'ta', tam: 'ta', 'ta-in': 'ta',
  kannada: 'kn', kn: 'kn', kan: 'kn', 'kn-in': 'kn',
  malayalam: 'ml', ml: 'ml', mal: 'ml', 'ml-in': 'ml',
  marathi: 'mr', mr: 'mr', mar: 'mr', 'mr-in': 'mr',
  bengali: 'bn', bangla: 'bn', bn: 'bn', ben: 'bn', 'bn-in': 'bn',
  gujarati: 'gu', gu: 'gu', guj: 'gu', 'gu-in': 'gu',
  punjabi: 'pa', panjabi: 'pa', pa: 'pa', pan: 'pa', 'pa-in': 'pa',
  odia: 'or', oriya: 'or', or: 'or', ori: 'or', 'or-in': 'or',
}

/** Any spelling/code/name → a canonical code, or null when unrecognised. */
export function toCode(value) {
  if (!value) return null
  const s = String(value).trim().toLowerCase()
  if (!s || s === 'unknown' || s === 'other' || s === 'null') return null
  return ALIASES[s] || null
}

/** Canonical code → the display name used in prompts and steer text. */
export function toName(code) {
  return LANGUAGE_NAMES[code] || null
}

// ─── Tuning ──────────────────────────────────────────────────────────────────
// Env-configurable, matching the existing convention (LANG_GATE_HOLD_MS,
// LANG_MAX_CONCURRENT_CLASSIFY). Defaults are the shipping values.
const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d)

export const LANGUAGE_CONFIG = {
  // A signal for a DIFFERENT language must be at least this sure to count at all.
  switchConfidence: num(process.env.LANGUAGE_SWITCH_CONFIDENCE, 0.80),
  // The first substantive utterance may lock in slightly below the switch bar:
  // there is no established language to protect yet.
  initialConfidence: num(process.env.LANGUAGE_INITIAL_CONFIDENCE, 0.75),
  // …and arrive this many times CONSECUTIVELY before the switch happens.
  confirmationCount: num(process.env.LANGUAGE_CONFIRMATION_COUNT, 2),
  // After a switch, ignore implicit signals for this long (explicit requests
  // still pass). Stops te → hi → te → hi inside a few seconds.
  cooldownMs: num(process.env.LANGUAGE_SWITCH_COOLDOWN_MS, 7000),
  // Recent meaningful utterances given to the classifier as context; one sentence
  // in isolation is often ambiguous where three in a row are not.
  contextWindow: num(process.env.LANGUAGE_CONTEXT_WINDOW, 3),
  // Hysteresis: evidence FOR the current language counts at a much lower bar than
  // evidence against it. It should be easy to stay and hard to move.
  maintainConfidence: num(process.env.LANGUAGE_MAINTAIN_CONFIDENCE, 0.55),
  classifyTimeoutMs: num(process.env.LANGUAGE_CLASSIFY_TIMEOUT_MS, 2500),
  classifyBackoffMs: num(process.env.LANGUAGE_CLASSIFY_BACKOFF_MS, 8000),
}

// Process-wide cap on simultaneous classifier requests. The classifier is shared
// quota across ALL concurrent calls, so without a cap 10 calls fire 10 requests at
// once and trip 503s. Excess turns skip the classifier and keep the current
// language — safe, because classification is off the reply critical path.
const MAX_CONCURRENT_CLASSIFY = num(process.env.LANG_MAX_CONCURRENT_CLASSIFY, 4)
let classifyInFlight = 0

// ─── Script detection ────────────────────────────────────────────────────────
// A run of Indic characters is strong evidence. It is NOT a verdict: several
// languages share a script, and the transcription channel mis-renders script
// outright. Each entry lists every language that plausibly writes in it.
const SCRIPTS = [
  { re: /[ఀ-౿]/g, langs: ['te'] },              // Telugu
  { re: /[஀-௿]/g, langs: ['ta'] },              // Tamil
  { re: /[ಀ-೿]/g, langs: ['kn'] },              // Kannada
  { re: /[ഀ-ൿ]/g, langs: ['ml'] },              // Malayalam
  { re: /[઀-૿]/g, langs: ['gu'] },              // Gujarati
  { re: /[਀-੿]/g, langs: ['pa'] },              // Gurmukhi
  { re: /[଀-୿]/g, langs: ['or'] },              // Odia
  { re: /[ঀ-৿]/g, langs: ['bn'] },              // Bengali
  // Devanagari is deliberately last and deliberately AMBIGUOUS: Hindi and Marathi
  // both use it, so a Devanagari run alone can never name the language.
  { re: /[ऀ-ॿ]/g, langs: ['hi', 'mr'] },
]

const MIN_SCRIPT_CHARS = 2   // a real run, not one stray borrowed glyph

// Greetings / acknowledgements / filler, across English and romanised Indic.
// These never decide the language. A fast local pre-filter; the classifier's
// `meaningful` flag is the backstop for anything not listed.
const FILLER_TOKENS = new Set([
  'hello', 'hi', 'hey', 'yo', 'hii', 'helo', 'hallo',
  'good', 'morning', 'afternoon', 'evening', 'night',
  'ok', 'okay', 'okey', 'k', 'kk', 'yes', 'yeah', 'yep', 'yup', 'no', 'nope',
  'hmm', 'hm', 'umm', 'um', 'uh', 'oh', 'aa', 'ah', 'mm', 'mmm',
  'thanks', 'thank', 'you', 'welcome', 'please', 'bye', 'byee', 'goodbye',
  'sure', 'right', 'fine', 'great', 'cool', 'alright', 'wow', 'sorry',
  // honorifics / address terms that commonly trail a greeting
  'sir', 'madam', 'maam', "ma'am", 'mam', 'bro', 'bhai', 'anna', 'andi',
  'garu', 'ji', 'saar', 'boss',
  // romanised Indic greetings / acknowledgements
  'namaste', 'namaskar', 'namaskaram', 'namaskaaram', 'vanakkam', 'namaskara',
  'haan', 'han', 'haa', 'ha', 'sari', 'sare', 'seri', 'theek', 'thik',
  'achha', 'acha', 'accha', 'sahi', 'chaala', 'chala', 'avunu', 'kaadu',
  'ante', 'anta', 'sarle', 'howdu', 'illa', 'aama', 'aamaam',
])

// Business/technical vocabulary that Indian callers say in English regardless of
// the language they are speaking. Seeing these must NEVER be evidence for English
// — this is the single most common cause of a wrong switch.
const CODE_MIX_TERMS = new Set([
  'emi', 'loan', 'payment', 'account', 'details', 'balance', 'due', 'date',
  'amount', 'interest', 'rate', 'bank', 'branch', 'cheque', 'check', 'card',
  'booking', 'flat', 'villa', 'plot', 'project', 'price', 'budget', 'gst',
  'sq', 'ft', 'bhk', 'site', 'visit', 'brochure', 'whatsapp', 'number',
  'status', 'pending', 'confirm', 'confirmation', 'update', 'customer',
  'service', 'offer', 'discount', 'document', 'documents', 'kyc', 'otp',
])

// An utterance containing these is doing business — it can never be pure filler
// even when it also contains greeting tokens ("hello I need a flat").
const SUBSTANTIVE_HINT = /\d|bhk|flat|villa|plot|price|budget|loan|emi|booking|project|need|want|looking|available|location|area|sq|gst|account|payment|pending|balance|chahiye|kavali|kaavali|cheyyi|choosth|chusth|matladu|dikkavali|jaana|jaanna|batao|bataiye|telusuko/i

// Native-script greetings. A multi-word Indic-script utterance is otherwise
// treated as meaningful, so these must be caught or "నమస్కారం అండీ" would
// wrongly establish the language.
const SCRIPT_FILLER = /^(?:नमस्ते|नमस्कार|नमस्कारम्|नमस्कारम|हैलो|हाय|हाँ|हां|जी|ठीक|अच्छा|धन्यवाद|నమస్తే|నమస్కారం|హలో|హాయ్|జీ|అవును|సరే|అలాగే|ధన్యవాదాలు|வணக்கம்|ஹலோ|ஆம்|ಸರಿ|ನಮಸ್ಕಾರ|ಹಲೋ|നമസ്കാരം|ഹലോ|নমস্কার|হ্যালো)[\sऀ-ൿ!.,?]*$/u

// ─── Explicit switch requests ────────────────────────────────────────────────
// Parsed LOCALLY first — never depend on an LLM to notice "speak in Telugu".
const LANGUAGE_MENTION = [
  ['en', /\benglish\b|\bangrezi\b|इंग्लिश|अंग्रेज़ी|अंग्रेजी|ఇంగ్లీష్|ఇంగ్లిష్|ఆంగ్ల|ஆங்கில|ಇಂಗ್ಲಿಷ್/i],
  ['hi', /\bhindi\b|हिंदी|हिन्दी|హిందీ|இந்தி|ಹಿಂದಿ/i],
  ['te', /\btelugu\b|తెలుగు|तेलुगु|తెలుగులో/i],
  ['ta', /\btamil\b|தமிழ்|तमिल|తమిళ/i],
  ['kn', /\bkannada\b|ಕನ್ನಡ|कन्नड़|కన్నడ/i],
  ['ml', /\bmalayalam\b|മലയാളം|मलयालम/i],
  ['mr', /\bmarathi\b|मराठी/i],
  ['bn', /\bbengali\b|\bbangla\b|বাংলা/i],
  ['gu', /\bgujarati\b|ગુજરાતી/i],
  ['pa', /\bpunjabi\b|ਪੰਜਾਬੀ/i],
  ['or', /\bodia\b|\boriya\b|ଓଡ଼ିଆ/i],
]

// The shapes a request actually takes. Deliberately NOT "the word 'english'
// appears" — "I filled the English form" is not a request to switch.
const SWITCH_FRAME = [
  // "speak in X", "talk to me in X", "can you speak X", "reply in X"
  /\b(speak|talk|say|tell|reply|respond|answer|continue|switch|change)\b[^.?!]{0,30}\b(in|to)\b/i,
  /\b(speak|talk|say|tell|reply|respond|answer)\b[^.?!]{0,20}\b(english|hindi|telugu|tamil|kannada|malayalam|marathi|bengali|bangla|gujarati|punjabi|odia|oriya)\b/i,
  // "X please", "in X please"
  /\b(english|hindi|telugu|tamil|kannada|malayalam|marathi|bengali|bangla|gujarati|punjabi|odia|oriya)\b\s*(only|please|plz)\b/i,
  // romanised postpositions: "hindi mein", "telugu lo", "tamil la", "kannada alli"
  /\b(english|hindi|telugu|tamil|kannada|malayalam|marathi|bengali|bangla|gujarati|punjabi|odia|oriya)\s*(me|mein|mai|main|lo|lon|ku|la|le|alli|il|il-)\b/i,
  // romanised verbs of speaking that follow the language name
  /\b(english|hindi|telugu|tamil|kannada|malayalam|marathi|bengali|bangla|gujarati|punjabi|odia|oriya)\b[^.?!]{0,25}\b(matlad|maatlaad|cheppu|cheppandi|kijiye|kijie|kariye|karo|bolo|boliye|baat|pesu|helu|parayu)/i,
  // native-script request forms
  /(हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी|इंग्लिश|मराठी)[^।.?!]{0,20}(में|बात|बोल|कीजि|करो)/,
  /(తెలుగు|ఇంగ్లీష్|ఇంగ్లిష్|హిందీ)[^.?!]{0,20}(లో|మాట్లాడ|చెప్ప)/,
]

// Any negation makes the TARGET ambiguous with a regex: "Telugu lo matladu, Hindi
// lo kadu" names two languages and rejects one. Guessing here is catastrophic —
// it once read a demand for Telugu as a demand for Hindi and locked it.
const NEGATION = /\b(not|don'?t|do\s?nt|never|nahi+n?|mat|band|chh?od)\b|\bkaa?du\b|\bvodd?u\b|లేదు|కాదు|వద్దు|नहीं|मत|बंद/iu

export class LanguageManager {
  /**
   * @param {object}   deps
   * @param {GoogleGenAI} [deps.ai]    reuse the engine's client (else one is made)
   * @param {string}   [deps.model]    classifier model id
   * @param {object}   [deps.config]   per-instance overrides of LANGUAGE_CONFIG
   * @param {string}   [deps.callSid]  correlates log lines with a call
   */
  constructor({ ai, model, config, callSid } = {}) {
    this.ai = ai || new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY })
    this.model = model || process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.5-flash-lite'
    this.cfg = { ...LANGUAGE_CONFIG, ...(config || {}) }
    this.callSid = callSid || null

    // ── State machine ────────────────────────────────────────────────────────
    this.currentLanguage = null      // committed code; null = UNKNOWN
    this.candidateLanguage = null    // code building a confirmation streak
    this.candidateCount = 0
    this.candidateConfidence = 0
    this.lastSwitchAt = 0            // drives the cooldown window
    this.lastMeaningfulUtteranceAt = 0
    this.initialized = false
    this.languageLocked = false      // caller EXPLICITLY chose the language

    // Rolling window of recent meaningful utterances, for classifier context.
    this.recentUtterances = []

    // How many meaningful utterances were spoken under each committed language.
    // `dominant` — not whatever was current at hangup — describes the call.
    this.languageTurns = new Map()

    // ── Observability ────────────────────────────────────────────────────────
    this.lastDecision = null
    this.lastResult = null
    this.lastConfidence = 0
    this._classifierUsed = false
    this._classifierMs = 0
    this._classifyBackoffUntil = 0
  }

  /** The committed conversation language as a code, or null before lock-in. */
  get current() { return this.currentLanguage }

  /** Display name of the committed language, for prompts and steer text. */
  get currentName() { return toName(this.currentLanguage) }

  /**
   * The language the conversation was actually CONDUCTED in: the one committed
   * for the most meaningful utterances.
   *
   * `current` is live steering state and is the wrong thing to file a call under.
   * The caller transcription regularly emits the wrong script entirely, so a
   * couple of garbled lines at the end of a long call could flip `current` and
   * that value labelled the whole call. Weighing every turn makes a late
   * mis-detection cost one vote instead of rewriting history.
   */
  get dominant() {
    let best = null, bestN = 0
    for (const [lang, n] of this.languageTurns) if (n > bestN) { bestN = n; best = lang }
    return best || this.currentLanguage
  }

  /** UNKNOWN | LOCKED | CANDIDATE | COOLDOWN — the conceptual state machine. */
  get state() {
    if (!this.initialized) return 'UNKNOWN'
    if (this._inCooldown()) return 'COOLDOWN'
    if (this.candidateLanguage) return 'CANDIDATE'
    return 'LOCKED'
  }

  _inCooldown(now = Date.now()) {
    return this.lastSwitchAt > 0 && (now - this.lastSwitchAt) < this.cfg.cooldownMs
  }

  _resetCandidate() {
    this.candidateLanguage = null
    this.candidateCount = 0
    this.candidateConfidence = 0
  }

  _wordCount(text) { return (String(text).trim().match(/\S+/g) || []).length }

  // Retained for compatibility with existing callers/tests.
  _normalize(lang) { return toCode(lang) }

  /**
   * Languages plausibly indicated by the dominant Indic script run, or null when
   * the text is not meaningfully in one. Borrowed Latin nouns inside Indic script
   * ("3BHK", "Kokapet") do not change the verdict.
   */
  _detectScript(text) {
    let best = null, bestN = 0
    for (const { re, langs } of SCRIPTS) {
      const n = (String(text).match(re) || []).length
      if (n > bestN) { bestN = n; best = langs }
    }
    return bestN >= MIN_SCRIPT_CHARS ? best : null
  }

  /**
   * Does this utterance carry enough content to move language state?
   *
   * Conservative on purpose: greetings, acknowledgements, bare honorifics and
   * strings made only of English business vocabulary all return false. The
   * classifier's `meaningful` flag is the backstop for the rest.
   */
  isMeaningfulUtterance(text) {
    const raw = String(text || '').trim()
    if (!raw) return false
    if (SCRIPT_FILLER.test(raw)) return false

    const clean = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()
    if (!clean) return false
    const tokens = clean.split(/\s+/)

    const fillers = tokens.filter(t => FILLER_TOKENS.has(t)).length
    if (fillers === tokens.length) return false

    // An utterance whose only content words are borrowed English business terms
    // says nothing about the PRIMARY language — "EMI payment pending" sounds the
    // same in a Telugu, Hindi or English call. Checked BEFORE the substantive-hint
    // path below, because that hint pattern deliberately contains these very words
    // and would otherwise claim the utterance first.
    const contentful = tokens.filter(t => !FILLER_TOKENS.has(t))
    if (contentful.length && contentful.every(t => CODE_MIX_TERMS.has(t))) return false

    // Real business content, in a sentence long enough to carry grammar.
    if (SUBSTANTIVE_HINT.test(raw) && tokens.length >= 3) return true

    // Long utterances are meaningful unless they are entirely filler.
    if (tokens.length > 4) return true

    // Short and mostly filler: a greeting plus a name ("Hello Sameera") or an
    // acknowledgement plus one word. Not enough to name a language.
    if (fillers >= 1 && tokens.length - fillers <= 1) return false

    return tokens.length >= 2
  }

  /** Back-compat alias for the previous private name. */
  _isFiller(text) { return !this.isMeaningfulUtterance(text) }

  /**
   * Best-effort synchronous check of whether a MODEL REPLY is plausibly in `code`.
   * Returns true / false / null (unsure). Lets the engine keep a reply the model
   * already produced in the right language instead of re-issuing it.
   */
  replyMatchesLanguage(text, code) {
    const t = String(text || '')
    if (!t.trim()) return null
    const guess = this.guessLanguage(t)
    if (guess === null) return null
    // Devanagari cannot distinguish Hindi from Marathi; treat either as a match.
    if (guess === 'hi' && code === 'mr') return true
    if (guess === 'mr' && code === 'hi') return true
    return guess === code
  }

  /**
   * Synchronous language of WRITTEN text we control (a greeting template, a model
   * reply) — NOT caller speech, which must go through ingest() because romanised
   * Indic is ambiguous there.
   *
   * Indic script is decisive; Latin-only means English, which holds for text we
   * authored but would be wrong for a caller. Returns a code, or null if empty.
   */
  guessLanguage(text) {
    const t = String(text || '')
    if (!t.trim()) return null
    const langs = this._detectScript(t)
    return langs ? langs[0] : 'en'
  }

  /** Cheap synchronous hint that the caller is asking to change language. */
  looksLikeSwitchRequest(text) {
    const t = String(text || '')
    if (!LANGUAGE_MENTION.some(([, re]) => re.test(t))) return false
    return SWITCH_FRAME.some(re => re.test(t))
  }

  /**
   * The TARGET of an explicit request, parsed locally with no model call.
   * Returns a code, or null — and null is the SAFE answer: when two languages are
   * named, or any negation is present, a regex cannot tell the wanted language
   * from the rejected one, so we defer to the classifier.
   */
  parseSwitchTarget(text) {
    const t = String(text || '')
    const mentioned = LANGUAGE_MENTION.filter(([, re]) => re.test(t)).map(([code]) => code)
    if (mentioned.length !== 1) return null
    if (NEGATION.test(t)) return null
    return mentioned[0]
  }

  /**
   * Should the engine HOLD the model's reply for this utterance?
   *
   * ONLY when the decision is SYNCHRONOUS — a locally-parsed explicit switch, or
   * an unambiguous script that disagrees with the current language — so the held
   * reply is released within a microtask. Classifier-dependent turns are NOT
   * gated: under load the classifier times out, and holding for it is a second of
   * dead air for nothing. Those flow immediately and a steer corrects the next turn.
   */
  shouldGate(text) {
    const t = String(text || '')
    if (this.looksLikeSwitchRequest(t) && this.parseSwitchTarget(t)) return true
    const langs = this._detectScript(t)
    if (!langs || langs.length !== 1) return false          // ambiguous → classifier → no gate
    if (this._wordCount(t) < 2) return false
    if (!this.isMeaningfulUtterance(t)) return false
    return !this.initialized || !langs.includes(this.currentLanguage)
  }

  // ─── Classifier ────────────────────────────────────────────────────────────

  /**
   * Classify ONE utterance, with recent context. Returns the raw verdict object
   * or null. This is the seam tests stub — it must stay the only network call.
   * @returns {Promise<{language:string,confidence:number,meaningful:boolean,explicitSwitch:boolean,requestedLanguage:string|null,reason:string}|null>}
   */
  async classify(text) {
    const started = Date.now()
    this._classifierUsed = true
    const context = this.recentUtterances.slice(-this.cfg.contextWindow)
    const prompt = [
      CLASSIFIER_PROMPT,
      '',
      `Current conversation language: ${this.currentLanguage || 'none established yet'}`,
      context.length ? `Recent meaningful utterances:\n${context.map(u => `- "${u}"`).join('\n')}` : '',
      '',
      `Current user utterance:\n"""${text}"""`,
    ].filter(Boolean).join('\n')

    const call = this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 256 },
    })
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('classify timeout')), this.cfg.classifyTimeoutMs))
    try {
      const res = await Promise.race([call, timeout])
      const raw = (res?.text ?? res?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
        .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      return JSON.parse(raw)
    } finally {
      this._classifierMs = Date.now() - started
    }
  }

  // ─── The single decision authority ─────────────────────────────────────────

  /**
   * Ingest ONE finalized caller utterance and decide the conversation language.
   *
   * @param {string|{text:string}} input
   * @returns {Promise<{action:'none'|'init'|'switch', currentLanguage:string|null,
   *   previousLanguage:string|null, detectedLanguage:string|null, confidence:number,
   *   reason:string, state:string}>}
   *
   * `action` is 'init' or 'switch' exactly when the engine must steer; 'none'
   * otherwise. Resolves synchronously (no network) for filler, explicit requests
   * and unambiguous script.
   */
  async ingest(input) {
    const text = typeof input === 'string' ? input : String(input?.text || '')
    this._classifierUsed = false
    this._classifierMs = 0

    const result = await this._decide(text.trim())

    // One vote per MEANINGFUL utterance, for the language in force at the time.
    if (this.currentLanguage && result.reason !== 'empty' && result.reason !== 'filler') {
      this.languageTurns.set(this.currentLanguage, (this.languageTurns.get(this.currentLanguage) || 0) + 1)
    }

    this.lastResult = result
    this._log(result)
    return result
  }

  async _decide(clean) {
    if (!clean) return this._result('none', null, 0, 'empty')

    // ── PRIORITY 1: explicit request. Highest authority; bypasses streak,
    //    cooldown and hysteresis. Parsed locally when the target is unambiguous.
    if (this.looksLikeSwitchRequest(clean)) {
      const target = this.parseSwitchTarget(clean)
      if (target) return this._applyExplicit(target)
      // Two languages named, or a negation — only the classifier can disentangle
      // "Telugu lo matladu, Hindi lo kadu".
      return this._classifyAndCommit(clean)
    }

    // ── PRIORITY 2: filler never touches language state. No model call.
    if (!this.isMeaningfulUtterance(clean)) {
      this._resetCandidate()
      return this._result('none', null, 0, 'filler')
    }

    this.lastMeaningfulUtteranceAt = Date.now()
    this._remember(clean)

    // ── PRIORITY 3: script evidence.
    const scriptLangs = this._detectScript(clean)
    if (scriptLangs) {
      // Evidence FOR the current language — the cheapest and most common case.
      if (this.initialized && scriptLangs.includes(this.currentLanguage)) {
        this._resetCandidate()
        return this._result('none', this.currentLanguage, 0.97, 'script_matches_current')
      }
      // Unambiguous script establishes the language immediately when nothing is
      // established yet. Fast path: no classifier, no added latency on turn one.
      if (!this.initialized && scriptLangs.length === 1) {
        return this._establish(scriptLangs[0], 0.97, 'script_init')
      }
      // Ambiguous script (Devanagari = Hindi or Marathi) can never name a
      // language on its own — ask the classifier.
      if (scriptLangs.length > 1) return this._classifyAndCommit(clean)
      // Unambiguous script that DISAGREES with an established language. Strong,
      // but not a verdict: the transcription channel mis-renders script, so this
      // still has to earn a confirmation streak like any other signal.
      return this._considerSwitch(scriptLangs[0], 0.97, 'script')
    }

    // ── PRIORITY 4: Latin script — genuinely ambiguous, so classify.
    if (!this.initialized) return this._classifyAndCommit(clean)

    if (this.currentLanguage === 'en') {
      // English is established and the text is Latin: overwhelmingly still
      // English. No signal, no classifier call. A genuine move away shows up as
      // Indic script (P3) or an explicit request (P1).
      return this._result('none', 'en', 0, 'latin_on_english_call')
    }

    // An Indic language is established but this utterance is fully Latin. That is
    // ambiguous — romanised Telugu looks exactly like this, and so does English.
    return this._classifyAndCommit(clean)
  }

  _remember(text) {
    this.recentUtterances.push(text.slice(0, 200))
    const keep = Math.max(1, this.cfg.contextWindow)
    if (this.recentUtterances.length > keep) this.recentUtterances = this.recentUtterances.slice(-keep)
  }

  // Run the classifier and apply its verdict. Centralises the "keep the current
  // language on any failure — never destabilise" policy.
  async _classifyAndCommit(text) {
    // Under load the classifier 503s or times out. Two protections: a per-instance
    // BACKOFF after a failure, and a process-wide CONCURRENCY cap. If either
    // trips we skip the call and keep the current language.
    if (Date.now() < this._classifyBackoffUntil) {
      return this._result('none', null, 0, 'classifier_backoff')
    }
    if (classifyInFlight >= MAX_CONCURRENT_CLASSIFY) {
      return this._result('none', null, 0, 'classifier_saturated')
    }

    let verdict
    classifyInFlight++
    try {
      verdict = await this.classify(text)
      this._classifyBackoffUntil = 0
    } catch (e) {
      console.error('[LANG] classify failed:', e.message)
      this._classifyBackoffUntil = Date.now() + this.cfg.classifyBackoffMs
      return this._result('none', null, 0, 'classifier_failed')
    } finally {
      classifyInFlight--
    }

    if (!verdict || typeof verdict !== 'object') {
      return this._result('none', null, 0, 'classifier_malformed')
    }

    // Accept both the current field names and the previous snake_case schema, so
    // a verdict shape change can never silently destabilise a live call.
    const detected = toCode(verdict.language)
    const requested = toCode(verdict.requestedLanguage ?? verdict.requested_language)
    const explicit = verdict.explicitSwitch ?? verdict.explicit_switch ?? false
    const meaningful = verdict.meaningful ?? verdict.is_substantive ?? true
    const confidence = Number(verdict.confidence) || 0
    this.lastConfidence = confidence

    if (explicit && requested) return this._applyExplicit(requested, confidence)
    if (!meaningful) {
      this._resetCandidate()
      return this._result('none', detected, confidence, 'not_meaningful')
    }
    if (!detected) return this._result('none', null, confidence, 'unknown_language')

    if (!this.initialized) {
      if (confidence < this.cfg.initialConfidence) {
        return this._result('none', detected, confidence, 'init_confidence_too_low')
      }
      return this._establish(detected, confidence, 'classifier_init')
    }

    if (detected === this.currentLanguage) {
      // Hysteresis: evidence for the current language clears any half-built
      // streak even at a low bar. Staying is cheap; moving is expensive.
      if (confidence >= this.cfg.maintainConfidence) this._resetCandidate()
      return this._result('none', detected, confidence, 'matches_current')
    }

    return this._considerSwitch(detected, confidence, 'classifier')
  }

  // First meaningful utterance: the source of truth. No streak, no cooldown.
  _establish(code, confidence, reason) {
    this.initialized = true
    this.currentLanguage = code
    this.lastConfidence = confidence
    this._resetCandidate()
    return this._result('init', code, confidence, reason)
  }

  // An explicit caller request. Immediate, and it also LOCKS: the caller has told
  // us what they want, so later ambiguity must not undo it.
  _applyExplicit(code, confidence = 0.99) {
    this._resetCandidate()
    this.languageLocked = true
    this.lastConfidence = confidence
    if (!this.initialized) {
      this.initialized = true
      this.currentLanguage = code
      this.lastSwitchAt = Date.now()
      return this._result('init', code, confidence, 'explicit_request')
    }
    if (code === this.currentLanguage) {
      return this._result('none', code, confidence, 'explicit_request_same_language')
    }
    const previous = this.currentLanguage
    this.currentLanguage = code
    this.lastSwitchAt = Date.now()
    return this._result('switch', code, confidence, 'explicit_request', previous)
  }

  /**
   * Evidence for a language OTHER than the current one. This is the only path to
   * an implicit switch, and it is deliberately hard to walk:
   *   confidence bar → cooldown → consecutive confirmations.
   */
  _considerSwitch(code, confidence, source) {
    this.lastConfidence = confidence

    // Below the switch bar the signal does not even build a streak. A run of
    // weak English readings must never accumulate into a switch.
    if (confidence < this.cfg.switchConfidence) {
      this._resetCandidate()
      return this._result('none', code, confidence, 'below_switch_confidence')
    }

    // Cooldown: an implicit switch cannot follow another one immediately. This is
    // what makes te → hi → te → hi impossible. Explicit requests skip this.
    if (this._inCooldown()) {
      return this._result('none', code, confidence, 'cooldown')
    }

    if (this.candidateLanguage === code) {
      this.candidateCount += 1
      this.candidateConfidence = Math.max(this.candidateConfidence, confidence)
    } else {
      this.candidateLanguage = code
      this.candidateCount = 1
      this.candidateConfidence = confidence
    }

    if (this.candidateCount < this.cfg.confirmationCount) {
      return this._result('none', code, confidence, `candidate_${this.candidateCount}_of_${this.cfg.confirmationCount}`)
    }

    const previous = this.currentLanguage
    this.currentLanguage = code
    this.lastSwitchAt = Date.now()
    this._resetCandidate()
    return this._result('switch', code, confidence, `confirmed_by_${source}`, previous)
  }

  _result(action, detectedLanguage, confidence, reason, previousLanguage = null) {
    const result = {
      action,
      currentLanguage: this.currentLanguage,
      previousLanguage,
      detectedLanguage: detectedLanguage ?? null,
      confidence,
      reason,
      state: this.state,
      classifierUsed: this._classifierUsed,
      classifierLatencyMs: this._classifierMs,
    }
    // Kept for existing telemetry call sites.
    this.lastDecision = {
      detected: result.detectedLanguage,
      language: action === 'none' ? null : this.currentLanguage,
      source: reason,
      reason: action === 'none' ? null : action,
      confidence,
      classifierUsed: this._classifierUsed,
      classifierLatencyMs: this._classifierMs,
    }
    return result
  }

  // Metadata only — never the utterance itself. A language decision must not
  // become a place caller speech gets written to logs.
  _log(r) {
    console.log(
      '[LANGUAGE_MANAGER] ' +
      [
        this.callSid ? `call=${this.callSid}` : null,
        `state=${r.state}`,
        `current=${r.currentLanguage ?? 'none'}`,
        `detected=${r.detectedLanguage ?? 'none'}`,
        `confidence=${r.confidence.toFixed(2)}`,
        `candidate=${this.candidateLanguage ?? 'none'}`,
        `candidateCount=${this.candidateCount}`,
        `action=${r.action.toUpperCase()}`,
        `reason=${r.reason}`,
        r.classifierUsed ? `classifierMs=${r.classifierLatencyMs}` : null,
      ].filter(Boolean).join(' ')
    )
  }
}

const CLASSIFIER_PROMPT = `You classify ONE utterance from a multilingual Indian phone call. You do NOT reply to the caller and you do NOT generate conversation — you only classify.

Callers naturally CODE-MIX: they speak Telugu, Hindi, Tamil or Kannada while borrowing English business words ("EMI", "loan", "payment", "account", "details", "booking", "flat", "3BHK", "price", "GST") and proper nouns ("Kokapet", "Hyderabad", "My Home"). Report the PRIMARY (matrix) language — the grammatical base of the sentence — NEVER the language of the borrowed words.

Worked examples:
- "Nenu actually loan payment gurinchi call chesanu"  -> te (Telugu grammar; the English words are borrowed)
- "Sir, naa EMI payment pending undi"                 -> te ("naa", "undi" are Telugu)
- "Mujhe loan ke regarding ek clarification chahiye"  -> hi (Hindi grammar)
- "Mujhe mere loan ka payment status jaana hai"       -> hi
- "I want to know about my loan payment"              -> en
- Romanised Indian languages are that language, NEVER English.

MEANINGFUL:
Greetings, acknowledgements and filler are NOT meaningful; set "meaningful": false. They must never decide the language. Examples: "Hello", "Hi sir", "Good morning", "Namaskaram", "Ji", "Haan", "Okay", "Achha okay", "Yes", "No", "Thanks", "Sorry", "Sir".
An utterance made ONLY of English business terms ("EMI payment pending", "account details") is also NOT meaningful evidence of English — it is code-mixed vocabulary. Set "meaningful": false for those.
An utterance IS meaningful when it carries a request, question or business detail in identifiable grammar.

GIBBERISH:
Speech-to-text on this channel is unreliable and sometimes emits nonsense or the wrong script entirely. If the text is incoherent, or reads as a mistranscription rather than a real sentence, return "unknown" with low confidence. Never force a language onto garbled input.

EXPLICIT SWITCH:
Set "explicitSwitch": true ONLY when the caller asks to change the conversation language ("speak in English", "Hindi mein baat kijiye", "Telugu lo matladandi", "English please"). Merely using a foreign word is not a request.
When the caller COMPLAINS about the language or CONTRASTS two languages, "requestedLanguage" is the one they WANT, never the one they reject:
- "Telugu lo matladutunna, Hindi lo kadu"                -> explicitSwitch=true, requestedLanguage="te"
- "Why are you replying in Hindi when I speak Telugu?"   -> explicitSwitch=true, requestedLanguage="te"
- "Hindi nahi, English mein bolo"                        -> explicitSwitch=true, requestedLanguage="en"

CONFIDENCE:
Be conservative. Short or ambiguous utterances get <= 0.5. Only give >= 0.8 when the grammar clearly identifies the primary language. When the current conversation language is given, only report a different language if there is real evidence of a PRIMARY language change — not code-mixing.

Return ONLY strict JSON, no prose:
{
  "language": "en" | "te" | "hi" | "ta" | "kn" | "ml" | "mr" | "bn" | "gu" | "pa" | "or" | "unknown",
  "confidence": <number 0.0-1.0>,
  "meaningful": <true|false>,
  "explicitSwitch": <true|false>,
  "requestedLanguage": "en" | "te" | "hi" | "ta" | "kn" | "ml" | "mr" | "bn" | "gu" | "pa" | "or" | null,
  "reason": "<short phrase>"
}`
