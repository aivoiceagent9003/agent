// config/conversation/conversation-state.js — per-call conversation memory.
//
// DETERMINISTIC ONLY. No model call, no classification pass, nothing on the audio
// path. Everything here is string work over transcript text the engine already has,
// so it adds no latency to a turn — which is the whole reason it is safe to run on
// every utterance of every call.
//
// It exists for three concrete jobs, not as decoration:
//
//   1. RECONNECT. A dropped engine session reopens with no
//      server-side history. Today the agent comes back having forgotten the entire
//      call and asks for the customer ID it was given ninety seconds ago. The state
//      renders a short recap that gets baked into the fresh system instruction.
//
//   2. QUALITY SIGNALS. Repeat questions and repeat offers are the two failure modes
//      that get reported from real calls most often, and neither is visible in any
//      existing metric. Both are detectable deterministically.
//
//   3. OUTCOME. A conservative outcome code for calls where the signal is
//      unambiguous, so the lead extractor starts from a fact rather than a guess.
//
// What it deliberately does NOT do: infer intent, score sentiment with a model, or
// ask Gemini to emit JSON on every turn. All three would cost a round trip per
// utterance on a real-time voice product.

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Words that carry no meaning for "is this the same question again?". Dropping them
// makes "and your customer ID?" and "could you give me your customer ID please" the
// same question, which is the point — the caller experiences those as a repeat.
const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'would', 'will', 'shall', 'should', 'may', 'might', 'have', 'has', 'had', 'be',
  'been', 'am', 'i', 'you', 'your', 'yours', 'me', 'my', 'we', 'our', 'us', 'it',
  'its', 'to', 'of', 'for', 'and', 'or', 'so', 'if', 'that', 'this', 'these',
  'those', 'please', 'kindly', 'just', 'ok', 'okay', 'sir', 'madam', 'andi', 'ji',
  'may', 'know', 'tell', 'give', 'get', 'let', 'like', 'want', 'need', 'sure',
])

/** Question fingerprint: content words only, sorted, so wording changes don't hide a repeat. */
function questionKey(q) {
  const words = norm(q).split(' ').filter(w => w && w.length > 1 && !STOP.has(w))
  return words.sort().join(' ')
}

// A turn can contain several sentences; only the interrogative ones are questions.
function questionsIn(text) {
  return String(text || '')
    .split(/(?<=[?])|(?<=[.!])\s+/)
    .map(s => s.trim())
    .filter(s => s.endsWith('?') && s.length > 8)
}

// The offers that get repeated at callers. Each entry is one "topic" — asking twice
// about the same topic is the failure, regardless of the exact wording used.
const OFFER_PATTERNS = [
  ['whatsapp', /\bwhats\s?app\b|\bsend (you )?(the |it )?(on|over|via)\b/i],
  ['site_visit', /\bsite visit\b|\bvisit the (site|property|project)\b|\bcome (and )?(see|visit)\b/i],
  ['callback', /\bcall (you )?back\b|\bcallback\b|\bring you (back|later)\b/i],
  ['booking', /\bbook (a|an|your)\b|\bschedule (a|an|your)\b|\bappointment\b|\bdemo\b/i],
  ['payment', /\bpay (now|today|online)\b|\bmake the payment\b|\bpayment link\b/i],
]

// Caller cues. Deliberately narrow: a false positive here changes how the agent is
// scored, so each pattern only matches language that is unambiguous in context.
const CUES = [
  ['busy', /\b(i'?m |i am )?(busy|driving|in a meeting|at work)\b|\bcall (me )?later\b|\bnot a good time\b|\bmake it (quick|fast)\b/i],
  ['frustrated', /\b(fed up|ridiculous|useless|waste of (my )?time|third time|again and again|nonsense|worst)\b|\bnot happy\b|\bvery (bad|poor)\b/i],
  ['confused', /\bi (don'?t|do not) understand\b|\bwhat do you mean\b|\bconfus(ed|ing)\b|\bnot clear\b|\bcome again\b/i],
  ['not_interested', /\bnot interested\b|\bdon'?t want\b|\bno thanks?\b|\bnot required\b/i],
  ['wants_human', /\b(speak|talk) to (a |an )?(human|person|agent|manager|representative|someone)\b|\btransfer me\b/i],
  ['already_done', /\balready (paid|renewed|done|booked|cancelled)\b|\bi (have|'ve) (paid|renewed|booked)\b/i],
  ['dnd', /\b(stop|don'?t) call(ing)? me\b|\bremove me\b|\bunsubscribe\b|\btake me off\b/i],
]

// A customer ID, policy or reference number the caller said out loud. Anything the
// caller spells out is worth remembering across a reconnect — it is the single most
// annoying thing to be asked for twice.
const IDENTIFIER = /\b([A-Z]{2,4}[\s-]?\d{4,12}|\d{10,16})\b/g

export class ConversationState {
  constructor({ callSid = null, template = null, tenantConfig = {} } = {}) {
    this.callSid = callSid
    this.templateId = template?.id || null
    this.startedAt = Date.now()

    // Seeded from the campaign contact row, so a reconnect does not re-ask for what
    // we knew before the call even started.
    this.known = new Map()
    if (tenantConfig.contact_name) this.known.set('name', String(tenantConfig.contact_name))

    this.turns = 0
    this.callerTurns = []          // recent caller text, bounded
    this.questionsAsked = new Map() // fingerprint -> count
    this.offersMade = new Map()     // topic -> count
    this.identifiers = new Set()
    this.cues = new Set()
    this.toolsUsed = []
    this.toolFailures = 0
    this.interruptions = 0
    this.repeatedQuestions = 0
    this.repeatedOffers = 0
    this.unresolved = []
    this.handedOff = false
    // Anything actually happening on the call, as opposed to what we were seeded
    // with. A recap is only worth rendering once this is true — otherwise a fresh
    // call would open by telling the model it had dropped and reconnected.
    this.touched = false
  }

  /** A finalized caller utterance. */
  observeCaller(text) {
    const t = String(text || '').trim()
    if (!t) return
    this.turns++
    this.touched = true
    this.callerTurns.push(t)
    if (this.callerTurns.length > 8) this.callerTurns.shift()

    for (const [cue, re] of CUES) if (re.test(t)) this.cues.add(cue)
    for (const m of t.toUpperCase().matchAll(IDENTIFIER)) this.identifiers.add(m[1].replace(/[\s-]/g, ''))
  }

  /**
   * A finalized agent reply. Returns the quality problems detected in it, so the
   * caller of this method can emit metrics without re-deriving them.
   * @returns {{repeatedQuestion: string|null, repeatedOffer: string|null}}
   */
  observeAgent(text) {
    const t = String(text || '').trim()
    const out = { repeatedQuestion: null, repeatedOffer: null }
    if (!t) return out
    this.touched = true

    for (const q of questionsIn(t)) {
      const key = questionKey(q)
      if (!key) continue
      const seen = (this.questionsAsked.get(key) || 0) + 1
      this.questionsAsked.set(key, seen)
      if (seen > 1) { this.repeatedQuestions++; out.repeatedQuestion = q }
    }

    for (const [topic, re] of OFFER_PATTERNS) {
      if (!re.test(t)) continue
      const seen = (this.offersMade.get(topic) || 0) + 1
      this.offersMade.set(topic, seen)
      if (seen > 1) { this.repeatedOffers++; out.repeatedOffer = topic }
    }

    if (/\[HANDOFF\]/.test(t)) this.handedOff = true
    return out
  }

  /** A tool ran. `hit` is false when it returned nothing useful. */
  observeTool(name, { ok = true, hit = true } = {}) {
    this.toolsUsed.push(String(name))
    this.touched = true
    if (!ok) this.toolFailures++
    if (ok && !hit && this.callerTurns.length) {
      const last = this.callerTurns[this.callerTurns.length - 1]
      if (last.length < 200) this.unresolved.push(last)
    }
  }

  observeInterruption() { this.interruptions++ }

  /** Record a fact the agent now holds — from a lookup result or the caller. */
  remember(key, value) {
    const k = String(key || '').trim()
    const v = value === null || value === undefined ? '' : String(value).trim()
    if (k && v) { this.known.set(k, v.slice(0, 120)); this.touched = true }
  }

  /**
   * The only outcome codes derivable without a model. Everything subtler is left to
   * the lead extractor — a confidently wrong outcome is worse than an empty one.
   * @returns {string|null}
   */
  outcome() {
    if (this.cues.has('dnd')) return 'NOT_INTERESTED'
    if (this.handedOff || this.cues.has('wants_human')) return 'ESCALATED'
    if (this.cues.has('not_interested')) return 'NOT_INTERESTED'
    if (this.cues.has('busy')) return 'CALLBACK_REQUESTED'
    return null
  }

  /** Flat object for telemetry and the Operations Center. */
  snapshot() {
    return {
      templateId: this.templateId,
      turns: this.turns,
      known: Object.fromEntries(this.known),
      identifiers: [...this.identifiers],
      cues: [...this.cues],
      toolsUsed: [...new Set(this.toolsUsed)],
      toolFailures: this.toolFailures,
      interruptions: this.interruptions,
      repeatedQuestions: this.repeatedQuestions,
      repeatedOffers: this.repeatedOffers,
      unresolved: this.unresolved.slice(-3),
      outcome: this.outcome(),
    }
  }

  /**
   * A short recap to bake into the system instruction of a RECONNECTED session,
   * which has no memory of the call. Empty before anything has happened, so a fresh
   * call never carries this block.
   */
  summaryForModel() {
    if (!this.touched) return ''
    const lines = []

    if (this.known.size) {
      lines.push('Already known — do NOT ask for any of this again:')
      for (const [k, v] of this.known) lines.push(`- ${k.replace(/_/g, ' ')}: ${v}`)
    }
    if (this.identifiers.size) {
      lines.push(`The caller has already given you: ${[...this.identifiers].join(', ')}. Do not ask again.`)
    }
    if (this.questionsAsked.size) {
      lines.push(`You have already asked ${this.questionsAsked.size} question(s) on this call. Do not repeat them.`)
    }
    for (const [topic, n] of this.offersMade) {
      if (n > 0) lines.push(`You have already offered: ${topic.replace(/_/g, ' ')}. Do not offer it again.`)
    }
    if (this.cues.has('busy')) lines.push('The caller said they are busy. Keep every reply short.')
    if (this.cues.has('frustrated')) lines.push('The caller is unhappy. Stay calm, do not be cheerful, focus on resolving it.')
    if (this.cues.has('already_done')) lines.push('The caller says the thing you called about is already done. Do not chase it.')
    if (this.unresolved.length) lines.push(`Still unanswered for them: "${this.unresolved[this.unresolved.length - 1]}"`)

    if (!lines.length) return ''
    return `WHAT HAS ALREADY HAPPENED ON THIS CALL

The connection dropped and you are resuming mid-conversation. Do NOT greet again and
do NOT start over — carry on as if nothing happened.

${lines.join('\n')}`
  }
}
