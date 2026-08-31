// services/language-manager.js — deterministic conversation-language state machine
// for the Gemini Live engine.
//
// WHY THIS EXISTS
// Multilingual Indian phone callers code-mix constantly: they speak Telugu or
// Hindi but borrow English nouns ("flat", "booking", "3BHK", "GST", "price") and
// proper nouns ("Kokapet", "Hyderabad", "My Home"). A naive per-utterance,
// script-based detector flips the conversation language on every borrowed word,
// producing Telugu→English→Hindi→English oscillation inside one call.
//
// This manager fixes that with three ideas:
//   1. MEANING, not just language. Greetings ("Hi", "Hello Sameera", "Good
//      morning"), acknowledgements ("ok", "yes", "haan", "ji") and filler must
//      NEVER decide the conversation language — only a SUBSTANTIVE business
//      utterance ("I need a 3BHK in Kokapet") does. We gate on substance first.
//   2. CLASSIFICATION, not heuristics, for the hard cases. Each substantive
//      FINALIZED utterance is sent to a lightweight Gemini text model that
//      understands code-mixing and reports the MATRIX (grammatical base)
//      language, a confidence, whether it is substantive, and whether the caller
//      EXPLICITLY asked to switch languages. Regexes alone cannot do this.
//   3. A STATE MACHINE with hysteresis. The first SUBSTANTIVE utterance is the
//      source of truth (never the greeting). After that, the language only
//      changes on (a) an explicit caller request — immediately — or (b) TWO
//      consecutive, confident signals of a different language.
//
// To keep latency low (the engine gates generation on this decision during
// initialization and explicit switches), the obvious cases are resolved
// SYNCHRONOUSLY with no network call: fillers are dropped locally, and an
// unambiguous Indic SCRIPT ("मैंने…", "నేను…") is committed immediately. Only
// ambiguous / romanized / code-mixed Latin text falls through to the model.
//
// The manager only DECIDES. Transport (when/how to inject a steering turn into
// the live session) stays in the engine, because that must respect the model's
// turn state (never inject mid-reply).

import { GoogleGenAI } from '@google/genai'

const SUPPORTED = ['Telugu', 'Hindi', 'English', 'Tamil', 'Kannada']
const CONFIDENCE_THRESHOLD = 0.80   // a "different language" signal must be this sure to count
const SWITCH_STREAK = 2             // …and arrive this many times in a row before we switch
const CLASSIFY_TIMEOUT_MS = 2500    // never let a slow classification hang (frees the slot faster under load)
const CLASSIFY_BACKOFF_MS = 8000    // after a classifier failure (timeout/503), stop calling it this long

// Process-wide cap on simultaneous classifier requests. The classifier is a shared
// quota across ALL concurrent calls, so without a cap 10 calls could fire 10 requests
// at once and trip 503s. Excess turns simply skip the classifier (language still
// tracks via script + the model's audio mirroring) — it's off the reply critical path,
// so shedding load here costs nothing in latency. Tunable via env for bigger boxes.
const MAX_CONCURRENT_CLASSIFY = Number(process.env.LANG_MAX_CONCURRENT_CLASSIFY || 4)
let classifyInFlight = 0

// Unicode blocks for the Indic scripts we support. A run of these characters is
// an UNAMBIGUOUS language signal — far more reliable (and instant) than asking
// the model — so we short-circuit on them. Latin is deliberately absent: it is
// ambiguous (English vs romanized Hindi/Telugu) and must go to the classifier.
const SCRIPTS = [
  { lang: 'Hindi', re: /[ऀ-ॿ]/g },   // Devanagari
  { lang: 'Telugu', re: /[ఀ-౿]/g },
  { lang: 'Tamil', re: /[஀-௿]/g },
  { lang: 'Kannada', re: /[ಀ-೿]/g },
]

// Greetings / acknowledgements / filler, across English + romanized Indic + the
// common Devanagari/Telugu greeting words. These NEVER decide the conversation
// language. This is a fast local pre-filter; the classifier's `is_substantive`
// is the backstop for anything not listed here.
const FILLER_TOKENS = new Set([
  // English greetings / acks / filler
  'hello', 'hi', 'hey', 'yo', 'hii', 'helo', 'hallo',
  'good', 'morning', 'afternoon', 'evening', 'night',
  'ok', 'okay', 'okey', 'k', 'kk', 'yes', 'yeah', 'yep', 'yup', 'no', 'nope',
  'hmm', 'hm', 'umm', 'um', 'uh', 'oh', 'aa', 'ah', 'mm', 'mmm',
  'thanks', 'thank', 'you', 'welcome', 'please', 'bye', 'byee', 'goodbye',
  'sure', 'right', 'fine', 'great', 'cool', 'alright', 'wow',
  // honorifics / address terms that often trail a greeting
  'sir', 'madam', 'maam', "ma'am", 'mam', 'bro', 'bhai', 'anna', 'andi',
  'garu', 'ji', 'saar', 'boss',
  // romanized Indic greetings / acks
  'namaste', 'namaskar', 'namaskaram', 'namaskaaram', 'vanakkam',
  'haan', 'han', 'haa', 'ha', 'haa', 'sari', 'sare', 'seri', 'theek', 'thik',
  'achha', 'acha', 'accha', 'sahi', 'chaala', 'chala', 'avunu', 'kaadu',
])

// Words that, if present, mean the utterance is doing business — it can never be
// pure filler even if it also contains greeting tokens ("hello I need a flat").
const SUBSTANTIVE_HINT = /\d|bhk|flat|villa|plot|price|budget|loan|emi|booking|project|need|want|looking|available|location|area|sq|gst|chahiye|kavali|kaavali|cheyyi|choosth|chusth|matladu|dikkavali/i

// Native-script greetings / acks. A multi-word Indic-script utterance is otherwise
// committed deterministically as substantive, so we must catch script greetings
// here or "నమస్కారం అండీ" would wrongly initialize the language.
const SCRIPT_FILLER = /^(?:नमस्ते|नमस्कार|नमस्कारम्|नमस्कारम|हैलो|हाय|हाँ|हां|जी|ठीक|अच्छा|धन्यवाद|నమస్తే|నమస్కారం|నమస్కారం|హలో|హాయ్|జీ|అవును|సరే|అలాగే|ధన్యవాదాలు|வணக்கம்|ஹலோ|ஆம்| ಸರಿ|ನಮಸ್ಕಾರ|ಹಲೋ)[\sऀ-௿ఀ-೿!.,?]*$/u

export class LanguageManager {
  /**
   * @param {object}   deps
   * @param {GoogleGenAI} [deps.ai]    reuse the engine's client (else one is made)
   * @param {string}   [deps.model]    classifier model id
   */
  constructor({ ai, model } = {}) {
    this.ai = ai || new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY })
    this.model = model || process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.5-flash-lite'

    // ── State machine ────────────────────────────────────────────────────────
    this.initialized = false      // has the first SUBSTANTIVE utterance been seen?
    this.currentLanguage = null   // the committed conversation language (UNKNOWN until init)
    this.pendingLanguage = null   // a candidate language building up a streak
    this.pendingCount = 0         // consecutive confident signals for pendingLanguage
    this.lastConfidence = 0       // confidence of the most recent classification
    this.languageLocked = false   // true once the caller EXPLICITLY chose a language
    // How many finalized utterances were spoken under each committed language.
    // This — not whatever happened to be current when the call ended — is what
    // describes the call. See the `dominant` getter.
    this.languageTurns = new Map()

    // ── Observability ─────────────────────────────────────────────────────────
    // Populated on every ingest() so the engine can emit telemetry. Never on the
    // hot path's critical decision — just a record of what we just decided.
    this.lastDecision = null      // { detected, language, source, reason, confidence, classifierUsed, classifierLatencyMs }
    this._classifierUsed = false  // did THIS ingest() call the model?
    this._classifierMs = 0        // latency of THIS ingest()'s classifier call (0 if none)
    this._classifyBackoffUntil = 0 // skip the classifier until this time (set after a failure)
  }

  /** The committed conversation language (null until the first substantive utterance). */
  get current() { return this.currentLanguage }

  /**
   * The language the conversation was actually CONDUCTED in: the one committed for
   * the most finalized utterances.
   *
   * `current` is the live steering state and is the wrong thing to file a call
   * under. The caller transcription is a noisy side-channel that regularly emits
   * the wrong script entirely (Devanagari for Telugu speech, and worse), so two
   * garbled lines at the end of a long Telugu call could flip `current` to Hindi
   * and that was the value the whole call got labelled with. Weighing every turn
   * makes a late mis-detection cost one vote instead of rewriting history.
   */
  get dominant() {
    let best = null, bestN = 0
    for (const [lang, n] of this.languageTurns) if (n > bestN) { bestN = n; best = lang }
    return best || this.currentLanguage
  }

  _resetPending() { this.pendingLanguage = null; this.pendingCount = 0 }

  _wordCount(text) { return (String(text).trim().match(/\S+/g) || []).length }

  // Map any model spelling/code to one of our supported language labels, else null.
  _normalize(lang) {
    if (!lang) return null
    const s = String(lang).trim().toLowerCase()
    const map = {
      telugu: 'Telugu', te: 'Telugu',
      hindi: 'Hindi', hi: 'Hindi',
      english: 'English', en: 'English',
      tamil: 'Tamil', ta: 'Tamil',
      kannada: 'Kannada', kn: 'Kannada',
    }
    return map[s] || (SUPPORTED.includes(lang) ? lang : null)
  }

  // Return the dominant Indic script language if the text is clearly in one
  // (and not Latin-dominant), else null. Borrowed Latin nouns ("3BHK",
  // "Kokapet") inside Telugu/Hindi script don't change the verdict.
  _detectScript(text) {
    let best = null, bestN = 0
    for (const { lang, re } of SCRIPTS) {
      const n = (text.match(re) || []).length
      if (n > bestN) { bestN = n; best = lang }
    }
    return bestN >= 2 ? best : null   // need a real run, not one stray glyph
  }

  /**
   * Is this utterance a greeting / acknowledgement / filler that must NOT decide
   * the conversation language? Synchronous and conservative — it only catches the
   * obvious cases; the classifier's `is_substantive` covers the rest.
   */
  _isFiller(text) {
    if (SCRIPT_FILLER.test(String(text).trim())) return true   // native-script greeting/ack
    const clean = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()
    if (!clean) return true
    if (SUBSTANTIVE_HINT.test(text)) return false      // it's doing business
    const tokens = clean.split(/\s+/)
    if (tokens.length > 4) return false                // too long to be pure filler
    let fillers = 0
    for (const t of tokens) if (FILLER_TOKENS.has(t)) fillers++
    // Pure filler, or a greeting trailed by a single non-filler token (a name:
    // "Hello Sameera", "Good morning Priya").
    return fillers === tokens.length || (fillers >= 1 && tokens.length - fillers <= 1)
  }

  /**
   * Best-effort synchronous check of whether a MODEL REPLY (`text`) is plausibly in
   * `lang`. Returns true (matches), false (clearly a different language), or null
   * (unsure / empty). Lets the engine keep a reply the model already produced in the
   * right language instead of discarding and re-issuing it.
   */
  replyMatchesLanguage(text, lang) {
    const t = String(text || '')
    if (!t.trim()) return null
    const guess = this.guessLanguage(t)
    return guess === null ? null : guess === lang
  }

  /**
   * Best-effort synchronous language of a piece of WRITTEN text we control (a
   * greeting template, a model reply) — NOT caller speech, which goes through
   * ingest()/the classifier because romanized Indic is ambiguous there.
   *
   * Indic script is decisive; Latin-only means English, which holds for text we
   * authored (nobody writes a greeting in romanized Telugu) but would be wrong
   * for a caller. Returns null for empty text.
   */
  guessLanguage(text) {
    const t = String(text || '')
    if (!t.trim()) return null
    return this._detectScript(t) || 'English'
  }

  /**
   * Cheap synchronous hint that the caller is asking to change languages
   * ("speak in Hindi", "telugu lo matladandi", "अब हिंदी में बात कीजिए"). Used by
   * the engine to decide whether to GATE this turn; the classifier confirms the
   * actual target. False positives are harmless (the gate just releases).
   */
  looksLikeSwitchRequest(text) {
    const t = String(text || '')
    return (
      /\b(speak|talk|continue|reply|say|switch|change)\b[^.]*\b(in|to)\b[^.]*\b(english|hindi|telugu|tamil|kannada)\b/i.test(t) ||
      /\b(english|hindi|telugu|tamil|kannada)\b\s*(me|mein|mai|lo|lon|ku|la|le)\b/i.test(t) ||
      /\b(english|hindi|telugu|tamil|kannada)\b[^.]*\b(matlad|maatlaad|cheppu|kijiye|kijie|bolo|baat|please)\b/i.test(t) ||
      /(हिंदी|हिन्दी|अंग्रेज़ी|अंग्रेजी|इंग्लिश)[^।]*(में|बात|बोल|कीजि)/.test(t) ||
      /(తెలుగు|ఇంగ్లీష్|ఇంగ్లిష్|హిందీ)[^.]*(లో|మాట్లాడ|చెప్ప)/.test(t)
    )
  }

  // Parse the TARGET language of a switch request locally (no model call), so a
  // SIMPLE, unambiguous explicit switch ("speak in Hindi", "telugu lo matladandi")
  // resolves deterministically. Returns a supported label, or null — and null is
  // the SAFE default: if more than one language is named, or any negation is
  // present (e.g. "Telugu lo matladu, Hindi lo KADU" = "speak Telugu, NOT Hindi";
  // "why are you replying in Hindi when I speak Telugu"), we CANNOT tell the wanted
  // language from the rejected one with a regex, so we defer to the classifier.
  // Guessing here is catastrophic — it once read a demand for Telugu as a demand
  // for Hindi and locked the wrong language.
  parseSwitchTarget(text) {
    const t = String(text || '')
    const tests = [
      ['Hindi', /\bhindi\b|हिंदी|हिन्दी|హిందీ/i],
      ['Telugu', /\btelugu\b|తెలుగు|तेलुगु/i],
      ['Tamil', /\btamil\b|தமிழ்|तमिल/i],
      ['Kannada', /\bkannada\b|ಕನ್ನಡ|कन्नड़/i],
      ['English', /\benglish\b|इंग्लिश|अंग्रेज़ी|अंग्रेजी|ఇంగ్లీష్|ఇంగ్లిష్|ఆంగ్ల/i],
    ]
    const mentioned = tests.filter(([, re]) => re.test(t)).map(([lang]) => lang)
    if (mentioned.length !== 1) return null   // 0 or 2+ languages named → ambiguous
    // Any negation anywhere makes the target ambiguous ("not Hindi", "Hindi lo kadu").
    const negation = /\b(not|don'?t|do\s?nt|no|never|nahi+n?|mat|band|chh?od)\b/i.test(t) ||
      /\bkaa?du\b|\bvodd?u\b|లేదు|కాదు|వద్దు|नहीं|मत|बंद/u.test(t)
    return negation ? null : mentioned[0]
  }

  /**
   * Should the engine GATE (hold the model's reply for) this utterance?
   *
   * ONLY when the decision is SYNCHRONOUS — a locally-parsed explicit switch, or a
   * clear Indic script — so the held reply is released within ~a microtask. We do
   * NOT gate classifier-dependent turns (romanized/Latin/ambiguous): the classifier
   * is a slow, shared dependency that under load (8–10 concurrent calls) times out
   * or returns 503, so holding for it just adds ~1s of dead air for no benefit. Those
   * turns flow immediately and a steer (if needed) corrects the next turn instead.
   */
  shouldGate(text) {
    const t = String(text || '')
    if (this.looksLikeSwitchRequest(t) && this.parseSwitchTarget(t)) return true   // explicit, parsed locally
    const script = this._detectScript(t)
    if (script && this._wordCount(t) >= 2) return !this.initialized || script !== this.currentLanguage
    return false   // needs the classifier → don't hold the reply
  }

  /**
   * Classify a single finalized utterance via the lightweight Gemini model.
   * @returns {Promise<{language:string,confidence:number,explicit_switch:boolean,requested_language:string|null,is_substantive:boolean}|null>}
   */
  async classify(text) {
    const started = Date.now()
    this._classifierUsed = true
    const call = this.ai.models.generateContent({
      model: this.model,
      contents: `${CLASSIFIER_PROMPT}\n\nUtterance:\n"""${text}"""`,
      config: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 256 },
    })
    // Don't let a slow classification stall language steering.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('classify timeout')), CLASSIFY_TIMEOUT_MS))
    try {
      const res = await Promise.race([call, timeout])
      const raw = (res?.text ?? res?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
        .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      return JSON.parse(raw)
    } finally {
      this._classifierMs = Date.now() - started
    }
  }

  /**
   * Ingest ONE finalized caller utterance and decide the conversation language.
   * Mutates internal state only; returns the language the engine should STEER to
   * right now (a string), or null if nothing should change.
   *
   * Resolves SYNCHRONOUSLY (same microtask, no network) for the common cases —
   * fillers and unambiguous Indic script — so the engine's generation gate is
   * not held waiting on a model round-trip.
   */
  async ingest(text) {
    const steer = await this._ingest(text)
    // One vote per finalized utterance, for the language in force at the time.
    if (this.currentLanguage) {
      this.languageTurns.set(this.currentLanguage, (this.languageTurns.get(this.currentLanguage) || 0) + 1)
    }
    return steer
  }

  async _ingest(text) {
    const clean = String(text || '').trim()
    this._classifierUsed = false
    this._classifierMs = 0
    if (!clean) { this.lastDecision = null; return null }

    // ── PRIORITY 1: deterministic, local, zero-dependency detection ───────────

    // (A) Explicit switch request. If we can parse the target locally, switch with
    //     NO model call. Only an unparseable target falls through to the classifier.
    if (this.looksLikeSwitchRequest(clean)) {
      const target = this.parseSwitchTarget(clean)
      if (target) {
        return this._commit({ language: target, confidence: 0.99, is_substantive: true, explicit_switch: true, requested_language: target }, 'explicit_request')
      }
      return this._classifyAndCommit(clean)
    }

    // (B) Greetings / acknowledgements / filler never touch the language — no model.
    if (this._isFiller(clean)) { this._resetPending(); this._setDecision(null, 'unicode', 0); return null }

    // (C) Unambiguous Indic script of real length → commit immediately, no model.
    const script = this._detectScript(clean)
    if (script && this._wordCount(clean) >= 2) {
      return this._commit({ language: script, confidence: 0.97, is_substantive: true, explicit_switch: false, requested_language: null }, 'unicode')
    }

    // ── PRIORITY 2: classifier, ONLY when deterministic detection can't decide ──
    // (romanized Hindi/Telugu, Hinglish/Tenglish, fully-Latin, mixed grammar)

    if (!this.initialized) {
      // First utterance is Latin/ambiguous — we must classify to know the language.
      return this._classifyAndCommit(clean)
    }

    // Steady state: spend a classifier call ONLY when there's a real switch signal.
    if (this.currentLanguage === 'English') {
      // English is locked and the text is Latin → overwhelmingly still English.
      // No signal, no classifier. (A genuine switch shows up as Indic script via (C)
      // or as an explicit request via (A).)
      this._setDecision(null, 'unicode', 0)
      return null
    }

    // An Indic language is locked but this utterance is fully Latin → genuine
    // ambiguity ("are we moving to English?"). This is a switch SIGNAL — classify.
    return this._classifyAndCommit(clean)
  }

  // Run the model classifier and commit its verdict. Centralizes the "keep current
  // language on failure — never destabilize" policy.
  async _classifyAndCommit(text) {
    // Under load the classifier 503s / times out. We protect it two ways: a per-call
    // BACKOFF after a failure, and a process-wide CONCURRENCY cap. If either trips we
    // skip the call and keep the current language (the model still mirrors via audio).
    // Both are safe because classification is OFF the reply critical path.
    if (Date.now() < this._classifyBackoffUntil || classifyInFlight >= MAX_CONCURRENT_CLASSIFY) {
      this._setDecision(null, 'classifier', 0)
      return null
    }
    let c
    classifyInFlight++
    try {
      c = await this.classify(text)
      this._classifyBackoffUntil = 0   // recovered
    } catch (e) {
      console.error('[LANG] classify failed:', e.message)
      this._classifyBackoffUntil = Date.now() + CLASSIFY_BACKOFF_MS
      this._setDecision(null, 'classifier', 0)
      return null
    } finally {
      classifyInFlight--
    }
    if (!c) { this._setDecision(null, 'classifier', 0); return null }
    return this._commit(c, 'classifier')
  }

  // Record what we decided, for the engine's telemetry. `steer` is the language we
  // return to the engine (or null); `source` is how the LABEL was determined.
  _setDecision(steer, source, confidence, reason = null, detected = null) {
    this.lastDecision = {
      detected,
      language: steer,
      source,
      reason,
      confidence,
      classifierUsed: this._classifierUsed,
      classifierLatencyMs: this._classifierMs,
    }
  }

  /**
   * Apply a classification (from the model or the synchronous fast path) to the
   * state machine. Returns the language to steer to, or null.
   */
  _commit(c, source) {
    const detected = this._normalize(c.language)
    const requested = this._normalize(c.requested_language)
    const conf = Number(c.confidence) || 0
    const substantive = c.is_substantive !== false   // default true when absent
    this.lastConfidence = conf

    // 1) EXPLICIT request — overrides everything, switches immediately, no streak.
    if (c.explicit_switch && requested) {
      this._resetPending()
      this.languageLocked = true
      if (!this.initialized || requested !== this.currentLanguage) {
        this.initialized = true
        this.currentLanguage = requested
        this._setDecision(requested, 'explicit_request', conf, 'explicit', detected)
        return requested
      }
      this._setDecision(null, 'explicit_request', conf, null, detected)
      return null   // already speaking the requested language
    }

    // 2) Greetings / acknowledgements / filler never initialize or switch.
    if (!substantive) { this._resetPending(); this._setDecision(null, source, conf, null, detected); return null }

    // 3) FIRST SUBSTANTIVE utterance = source of truth (the greeting is ignored).
    if (!this.initialized) {
      if (!detected) { this._setDecision(null, source, conf, null, detected); return null }
      this.initialized = true
      this.currentLanguage = detected
      this._resetPending()
      this._setDecision(detected, source, conf, 'init', detected)
      return detected
    }

    // 4) Same language (or unrecognized) — stay, and clear any half-built streak.
    if (!detected || detected === this.currentLanguage) {
      this._resetPending()
      this._setDecision(null, source, conf, null, detected)
      return null
    }

    // 5) A DIFFERENT language — only switch after TWO consecutive CONFIDENT signals.
    if (conf >= CONFIDENCE_THRESHOLD) {
      if (this.pendingLanguage === detected) this.pendingCount += 1
      else { this.pendingLanguage = detected; this.pendingCount = 1 }

      if (this.pendingCount >= SWITCH_STREAK) {
        this.currentLanguage = detected
        this._resetPending()
        this._setDecision(detected, source, conf, 'streak', detected)
        return detected
      }
    } else {
      // Weak/ambiguous signal — don't let it build a false streak toward a switch.
      this._resetPending()
    }
    this._setDecision(null, source, conf, null, detected)
    return null
  }
}

const CLASSIFIER_PROMPT = `You classify ONE utterance from a multilingual Indian real-estate phone call.

Callers naturally CODE-MIX: they speak Telugu or Hindi but borrow English nouns (e.g. "flat", "booking", "3BHK", "4BHK", "villa", "project", "price", "GST", "loan", "EMI") and proper nouns (e.g. "Kokapet", "Hyderabad", "Gachibowli", "My Home", "Akara"). Your job is to report the MATRIX language — the grammatical base of the sentence — NOT the language of the borrowed nouns.

Worked examples:
- "Mujhe Kokapet mein flat chahiye" -> Hindi, substantive   (grammar is Hindi; "Kokapet","flat" are borrowed)
- "Sir booking amount entha?"        -> Telugu, substantive  ("entha" is Telugu grammar)
- "My Home Akara lo 3BHK unda?"      -> Telugu, substantive  ("lo","unda" are Telugu)
- "What is the price of this project?" -> English, substantive
- "Hindi mein baat kijiye"           -> Hindi, EXPLICIT switch to Hindi, substantive
- Romanized Hindi/Telugu count as Hindi/Telugu, never as English.

CRITICAL — substance:
Greetings, acknowledgements and filler are NOT substantive and must set "is_substantive": false. They must NOT decide the conversation language. Examples that are NOT substantive: "Hello", "Hi", "Hi Sameera", "Hey", "Good morning", "Namaste", "Ji", "Haan", "Ok", "Okay", "Yes", "No", "Hmm", "Thanks", "Sir".
An utterance IS substantive when it carries a request, question, or business detail. Examples that ARE substantive: "I need a 3BHK in Kokapet.", "నేను కోకాపేట్ లో ఫ్లాట్ చూస్తున్నాను.", "मुझे फ्लैट चाहिए.", "What is the price?".

Also decide if the caller is EXPLICITLY asking to change the conversation language (e.g. "speak in Hindi", "Hindi mein baat kijiye", "English lo cheppu", "switch to Telugu", "telugu lo matladandi"). This is true ONLY when they ask to change the language of the conversation — not when they merely use a foreign word. An explicit switch request is always substantive.

CRITICAL — wanted vs rejected language:
When the caller COMPLAINS that you are replying in the wrong language, or CONTRASTS two languages, "requested_language" is the language they WANT (the one they are speaking), NEVER the one they are rejecting. Worked examples:
- "Telugu lo matladutunna, Hindi lo kadu" ("I'm speaking Telugu, NOT Hindi") -> explicit_switch=true, requested_language="Telugu".
- "Why are you replying in Hindi when I am speaking Telugu?" -> explicit_switch=true, requested_language="Telugu".
- "I was talking in Telugu but you reply in Hindi which I don't know" -> explicit_switch=true, requested_language="Telugu".
- "Hindi nahi, English mein bolo" ("not Hindi, speak English") -> explicit_switch=true, requested_language="English".

Return ONLY strict JSON, no prose:
{
  "language": "Telugu" | "Hindi" | "English" | "Tamil" | "Kannada" | "Other",
  "confidence": <number 0.0-1.0>,
  "is_substantive": <true|false>,
  "explicit_switch": <true|false>,
  "requested_language": "Telugu" | "Hindi" | "English" | "Tamil" | "Kannada" | null
}

Rules:
- "language" is the matrix language of THIS utterance.
- Borrowed English nouns must NEVER make the language English. Only English GRAMMAR does.
- "is_substantive" is false for greetings/acknowledgements/filler, true for requests/questions/business detail.
- "confidence" reflects certainty about the matrix language; very short or ambiguous utterances -> low confidence (<= 0.5).
- "requested_language" is the target only when "explicit_switch" is true, otherwise null.`
