// services/call-language.js — which language a call is spoken in, decided plainly.
//
// A business picks one of two settings in Agent settings (tenants.config.language_mode):
//   'english'        — every call is in English.
//   'caller_choice'  — after the greeting the agent asks which of the business's languages
//                      (config.caller_languages) the caller wants, and the call is LOCKED
//                      to that language from then on.
//
// This replaced letting the model decide the language turn by turn. It was told to mirror
// the caller, and the prompt that told it so was full of Telugu and Hindi examples; on
// real English calls it answered in Telugu and Hindi anyway. A language the caller chose,
// restated on every turn, leaves nothing for the model to guess.
//
// Pure functions only — the per-call state (what was chosen, when) lives in cascade.js.

import { toCode, mentionedLanguages, hasNegation, isSwitchRequest } from './language-manager.js'

// Languages the whole stack handles end to end: Sarvam hears them, their script is
// recognised (tts-text.js) and Telnyx speaks them.
export const CHOOSABLE_LANGUAGES = ['en', 'te', 'hi', 'ta', 'kn', 'ml', 'mr', 'bn']
export const DEFAULT_CALLER_LANGUAGES = ['en', 'te', 'hi']

/**
 * The language setting for this call: { mode: 'english'|'caller_choice', choices: codes[] }.
 *
 * Unset means 'caller_choice' — an agent whose callers speak Telugu keeps working, where
 * defaulting to English would silently stop it — except for an agent whose owner had
 * switched the old "Multilingual" toggle off, which meant English.
 */
export function languagePlan(config = {}) {
  const mode = config.language_mode === 'english' || config.language_mode === 'caller_choice'
    ? config.language_mode
    : config.allow_multilingual === false ? 'english' : 'caller_choice'
  if (mode === 'english') return { mode, choices: ['en'] }
  const picked = [...new Set((Array.isArray(config.caller_languages) ? config.caller_languages : [])
    .map(toCode).filter(c => CHOOSABLE_LANGUAGES.includes(c)))]
  return { mode, choices: picked.length >= 2 ? picked : DEFAULT_CALLER_LANGUAGES }
}

/**
 * The question the call opens with in 'caller_choice' mode. It names no options: read
 * out as a list ("— English, Telugu or Hindi?") it sounded like a phone menu. The
 * options only come up if the caller asks for one the business does not offer.
 */
export function languageQuestion() {
  return 'Which language would you like to continue in?'
}

/**
 * The language the caller picked in answer to the question, or null when the answer
 * does not settle it: nothing named, a language the business does not offer, two
 * languages named, or a negation ("not English, Telugu"), which a pattern cannot read
 * safely. Null means the agent asks again — never a guess.
 */
export function choiceFromAnswer(text, choices) {
  const named = mentionedLanguages(text).filter(c => choices.includes(c))
  if (named.length !== 1 || hasNegation(text)) return null
  return named[0]
}

/**
 * Once locked, the language changes only when the caller explicitly asks for another
 * offered one ("can you speak in Hindi?") — the caller choosing again. A borrowed
 * English word, a "yes" or a Hindi name in a Telugu sentence is not a request.
 */
export function switchRequest(text, choices, current) {
  if (!isSwitchRequest(text)) return null
  const target = choiceFromAnswer(text, choices)
  return target && target !== current ? target : null
}
