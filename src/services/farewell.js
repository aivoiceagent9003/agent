// farewell.js — recognise the agent saying goodbye, so the line can be closed.
//
// end_call exists, is declared on every call, and the prompt says "say your closing
// line and call end_call". It has never once fired: a replay of five different
// goodbyes in three languages got 0/15. The model writes a
// flawless sign-off — "సరే అండి, థాంక్యూ. ఉంటాను." — and emits no tool call with it,
// which is ordinary behaviour for a turn that feels conversational rather than
// operational. So both real calls ended with the CALLER hanging up, which on a
// service line reads as being dumped and spends their airtime.
//
// WHY THIS MATCHES THE AGENT AND NOT THE CALLER. agent-tools.js argues against
// finding a goodbye in the transcript, and it is right — about the caller. "బై ది వే"
// is "by the way", "थैंक्यू" opens as many turns as it closes, and a caller saying
// "bye" mid-sentence is common. None of that applies here. The agent's line is
// generated, well-formed, in a script we chose, and it only says goodbye when the
// model has already decided the call is over. This reads that decision off the
// channel the model actually uses instead of the one we asked it to use.
//
// DELIBERATELY CONSERVATIVE, because the two failures are not equally bad. Missing a
// goodbye leaves the line open and the caller hangs up — today's behaviour, mildly
// rude. Matching one that is not there hangs up on somebody mid-conversation. So a
// farewell has to clear three separate bars, and anything ambiguous is left alone.

// Unambiguous sign-offs only.
//
// NOT included, on purpose: నమస్కారం and नमस्ते, which are how these calls OPEN as
// well as close — the agent greets with "నమస్కారం అండి", and a pattern that matched it
// would hang up on the greeting. Nor plain thanks: the agent thanks people all call.
// Regex LITERALS, not strings fed to new RegExp: the string form needs every
// backslash doubled, and a \\b that loses one becomes a literal backspace
// character. It matched nothing and it looked completely correct.
const FAREWELL = [
  /ఉంటాను/,                        // Telugu "I will be going" — the standard sign-off
  /వెళ్తాను|వెళ్ళొస్తాను/,             // "I will go" / "I will take leave"
  /మంచి రోజు/,                      // a calque we discourage, but it IS a goodbye
  /रखता हूँ|रखती हूँ|रखता हुँ/,       // Hindi "I will hang up"
  /अलविदा/,
  /\bgood ?bye\b|\bbye\b/i,
  /\btake care\b/i,
  /\bhave a (good|nice|great) (day|evening)\b/i,
]

// A genuine sign-off is one clause. The register rules require that, and it doubles as
// a guard: a farewell word inside a long explanatory paragraph is not a sign-off.
const MAX_CLOSING_CHARS = 180
// Only the tail counts. "ఉంటాను" early in a reply that carries on afterwards is the
// agent still talking.
const TAIL_CHARS = 70

/**
 * Is this reply the agent closing the call?
 *
 * All three bars must be cleared:
 *   1. a farewell in the LAST few words, not merely somewhere in the reply
 *   2. no question anywhere — an agent that just asked something is not finished
 *   3. short overall, because a real sign-off is one clause
 *
 * @param {string} text the agent's reply, after any markers are stripped
 * @returns {boolean}
 */
export function isFarewell(text) {
  const s = String(text || '').trim()
  if (!s || s.length > MAX_CLOSING_CHARS) return false
  // A question means the conversation is still open, whatever else the line says.
  // Both the Latin '?' and the Devanagari danda-adjacent form callers' scripts use.
  if (/[?？]/.test(s)) return false
  const tail = s.slice(-TAIL_CHARS)
  return FAREWELL.some(re => re.test(tail))
}

// Signals from the CALLER that they are staying on the line.
//
// Matching the caller to TRIGGER a hangup is what agent-tools.js warns against and
// this module refuses to do. Matching them to SUPPRESS one is the opposite trade and
// it is safe, because of where the mistakes land: a veto that fires wrongly leaves the
// line open, which is exactly the behaviour we had before any of this existed. A
// veto that misses costs nothing beyond what the farewell check already decided.
//
// Measured case: the caller said "థాంక్యూ. నేను ఆలోచించి చెప్తాను, ఒక్క నిమిషం." — thank
// you, I will think it over, one minute — and the agent signed off over the top of the
// "one minute". The agent decided wrongly; this stops that decision being final.
const HOLD_ON = [
  /ఒక్క నిమిషం|ఒక నిమిషం|ఆగండి|ఉండండి|ఒక్కసారి ఆగ/,
  /एक मिनट|रुकिए|रुको|ठहरिए|ज़रा रुक/,
  /\bhold on\b|\bhang on\b|\bone (minute|sec|second)\b|\bjust a (sec|second|minute)\b|\bplease wait\b|\bwait a (sec|second|minute|moment)\b/i,
]

/**
 * Did the caller ask to stay on the line? If so, no farewell closes it.
 * @param {string} text the caller's last turn, as transcribed
 * @returns {boolean}
 */
export function callerWantsToStay(text) {
  const s = String(text || '').trim()
  return !!s && HOLD_ON.some(re => re.test(s))
}