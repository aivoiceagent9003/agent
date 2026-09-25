// acknowledgements.js — what the agent says while it is genuinely busy.
//
// A knowledge turn costs the caller about 4.2 seconds of silence, and almost none of
// that is avoidable: the model has to decide it needs a lookup, the lookup has to run,
// and then the model has to be asked a SECOND time with the result. Measured on this
// stack that second round alone is ~1.3s. The work is real, so the only thing left to
// remove is the silence on top of it.
//
// This is not filler. Filler is "One moment please" after somebody says "yes", and it
// is what makes an agent sound like a machine stalling. The rule here is narrow:
//
//   speak ONLY while a genuinely slow asynchronous operation is actually running,
//   and only when the model has not already said something itself.
//
// What it must never do is imply an answer it does not have. "Let me check" is fine.
// "Yes, there are two available" before the search has returned is a fabrication, and
// on an insurance line that is a compliance problem, not a style one.
//
// No model call is involved — asking an LLM to write the line would cost exactly the
// latency this exists to hide.

/**
 * Which family of phrases fits the operation. Tenants name their own lookups, so the
 * mapping is by intent rather than by an exhaustive list of tool names:
 *
 *   knowledge — looking something up in what the business knows (plans, policies)
 *   record    — looking up THIS caller's own record (order, due, booking, payment)
 *   search    — looking for matching options (availability, property, stock)
 */
export const FAMILIES = ['knowledge', 'record', 'search']

// Tools that must never produce an acknowledgement: they either return instantly, or
// the model narrates the outcome itself, or speaking over them is actively wrong.
// end_call in particular — announcing a check while hanging up is nonsense.
export const SILENT_TOOLS = new Set(['end_call', 'add_to_dnd', 'send_whatsapp'])

// Matched against the tenant's own lookup name, longest intent first. A tenant calling
// something `check_payment_status` should get the record family, not the generic one.
const NAME_HINTS = [
  [/payment|due|dues|bill|invoice|emi|premium_status|balance/i, 'record'],
  [/order|booking|appointment|reservation|ticket|policy_status|claim/i, 'record'],
  [/availab|inventory|stock|property|listing|slot|schedule|vacan/i, 'search'],
]

/**
 * The family of phrases for a tool.
 * @returns {string|null} null when this tool must stay silent.
 */
export function familyFor(tool) {
  const name = String(tool || '')
  if (!name || SILENT_TOOLS.has(name)) return null
  if (name === 'search_knowledge') return 'knowledge'
  for (const [re, family] of NAME_HINTS) if (re.test(name)) return family
  return 'record'   // a tenant lookup we cannot classify is still about the caller
}

/**
 * The lines themselves.
 *
 * Short on purpose. Every millisecond of acknowledgement audio is a millisecond the
 * real answer may have to queue behind, so these are one clause, not a sentence and a
 * half. They are written the way the speech rules require — Telugu in Telugu script,
 * Hindi in Devanagari, business words left in English — because they go to the same
 * voice as everything else and romanised Telugu comes out unintelligible.
 *
 * None of them claims a result, and none of them promises how long it will take.
 */
const LINES = {
  en: {
    knowledge: ['Sure, let me check that.', 'Let me look that up for you.', 'One second, let me check.'],
    record: ['Sure, let me pull that up.', 'Let me check your details.', 'One second, checking that now.'],
    search: ['Let me see what we have.', 'Sure, let me look at the options.', 'Let me check the options for you.'],
  },
  te: {
    knowledge: ['ఒక్కసారి చూస్తాను అండి.', 'అవునండి, ఒక్కసారి చెక్ చేస్తాను.', 'ఒక్క నిమిషం, చూసి చెప్తాను.'],
    record: ['మీ details ఒక్కసారి చూస్తాను.', 'ఒక్క నిమిషం, చెక్ చేస్తాను అండి.', 'అవునండి, ఒక్కసారి చూసి చెప్తాను.'],
    search: ['ఏమేమి ఉన్నాయో చూస్తాను.', 'ఒక్కసారి options చూస్తాను అండి.', 'ఒక్క నిమిషం, చూస్తాను.'],
  },
  hi: {
    knowledge: ['जी, एक सेकंड चेक करता हूँ।', 'ज़रूर, मैं देख लेता हूँ।', 'एक मिनट, देखता हूँ।'],
    record: ['आपकी details एक बार देख लेता हूँ।', 'जी, एक सेकंड चेक करता हूँ।', 'एक मिनट, देखता हूँ।'],
    search: ['देखता हूँ क्या उपलब्ध है।', 'जी, options देख लेता हूँ।', 'एक मिनट, देखता हूँ।'],
  },
}

export const LANGUAGES = Object.keys(LINES)

/**
 * Pick the line to speak.
 *
 * Varied but DETERMINISTIC: the same call and turn always produce the same line, so a
 * test can assert on it and a recording can be reproduced. Randomness here would buy a
 * little naturalness and cost the ability to reason about what happened on a call.
 * Rotation is by turn, so a caller who triggers three lookups in a row hears three
 * different lines rather than the same one three times.
 *
 * @param {object} opts
 * @param {string} opts.tool      the tool about to run
 * @param {string} opts.language  'te' | 'hi' | 'en' — the language of THIS conversation
 * @param {number} [opts.turn]    turn number, to rotate the wording
 * @param {string} [opts.seed]    call id, so two concurrent calls do not say the same thing
 * @returns {{text: string, family: string, language: string}|null} null = stay silent
 */
export function acknowledgementFor({ tool, language, turn = 0, seed = '' } = {}) {
  const family = familyFor(tool)
  if (!family) return null
  // An unknown language falls back to English rather than guessing: speaking Telugu at
  // a Hindi caller is worse than the silence this is meant to remove.
  const lang = LINES[language] ? language : 'en'
  const options = LINES[lang][family]
  let hash = 0
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return { text: options[(hash + turn) % options.length], family, language: lang }
}

/**
 * Every line, for pre-rendering into the TTS cache before a call needs one.
 *
 * Ordered FAMILY-first, and that order is the point: the warm-up renders these one at a
 * time and a line that is not rendered yet masks nothing. Language-major put Telugu
 * knowledge at positions 9-11 of 27, roughly seven seconds into the process's first
 * call — and a real call reached its first knowledge turn before that and went
 * unmasked at 6.7s, against 2.5s for the same shape of turn once warm.
 *
 * `knowledge` leads because it is the family that covers search_knowledge, which is
 * both the commonest slow tool and the one whose second model round the caller waits
 * through in silence. Within a family every language comes before the next family, so
 * whichever of the three a caller speaks is ready at roughly the same time.
 */
export function allAcknowledgements() {
  const out = []
  for (const family of FAMILIES) for (const lang of LANGUAGES) {
    for (const text of LINES[lang][family]) out.push({ text, language: lang, family })
  }
  return out
}

/**
 * The other lines that would have served just as well.
 *
 * acknowledgementFor picks one of three deterministically, and determinism is worth
 * keeping — a test can assert on it and a recording can be reproduced. But it means the
 * pick can land on the one line of the three that has not been rendered yet, and the
 * turn then goes unmasked while two perfectly good alternatives sit in the cache. These
 * are those alternatives, in order, for a caller that has audio and needs any of them.
 */
export function siblingAcknowledgements({ family, language, text } = {}) {
  const lines = LINES[language]?.[family]
  if (!lines) return []
  return lines.filter(t => t !== text).map(t => ({ text: t, family, language }))
}
