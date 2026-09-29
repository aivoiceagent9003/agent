// The call's language, decided plainly: an English agent, or the caller picks at the
// start and the call is locked. These are the pure decisions behind that — what the
// setting means, what is asked, and how an answer is read.

import { describe, it, expect } from 'vitest'
import { languagePlan, languageQuestion, choiceFromAnswer, switchRequest } from '../src/services/call-language.js'

describe('languagePlan', () => {
  it('lets the caller choose English, Telugu or Hindi when nothing is set', () => {
    // An agent whose callers speak Telugu keeps working; defaulting to English would not.
    expect(languagePlan({})).toEqual({ mode: 'caller_choice', choices: ['en', 'te', 'hi'] })
  })

  it('is English for an owner who had switched the old Multilingual toggle off', () => {
    expect(languagePlan({ allow_multilingual: false })).toEqual({ mode: 'english', choices: ['en'] })
  })

  it('follows the setting over the old toggle', () => {
    expect(languagePlan({ language_mode: 'english', allow_multilingual: true }).mode).toBe('english')
    expect(languagePlan({ language_mode: 'caller_choice', allow_multilingual: false }).mode).toBe('caller_choice')
  })

  it("offers the business's own languages", () => {
    expect(languagePlan({ language_mode: 'caller_choice', caller_languages: ['en', 'ta'] }).choices).toEqual(['en', 'ta'])
    expect(languagePlan({ caller_languages: ['English', 'Kannada'] }).choices).toEqual(['en', 'kn'])
  })

  it('falls back to the default list when fewer than two usable languages are saved', () => {
    // One language is not a choice, and an unknown one cannot be spoken.
    expect(languagePlan({ caller_languages: ['te'] }).choices).toEqual(['en', 'te', 'hi'])
    expect(languagePlan({ caller_languages: ['en', 'xx'] }).choices).toEqual(['en', 'te', 'hi'])
  })
})

describe('languageQuestion', () => {
  it('asks plainly, without reading out a list of options', () => {
    // "— English, Telugu or Hindi?" on the end sounded like a phone menu.
    expect(languageQuestion()).toBe('Which language would you like to continue in?')
  })
})

describe('choiceFromAnswer', () => {
  const offered = ['en', 'te', 'hi']

  it('reads a language named in any script', () => {
    expect(choiceFromAnswer('Telugu', offered)).toBe('te')
    expect(choiceFromAnswer('తెలుగు', offered)).toBe('te')
    expect(choiceFromAnswer('తెలుగులో మాట్లాడండి', offered)).toBe('te')
    expect(choiceFromAnswer('Hindi please', offered)).toBe('hi')
    expect(choiceFromAnswer('हिंदी में बात कीजिए', offered)).toBe('hi')
    expect(choiceFromAnswer('English is fine', offered)).toBe('en')
  })

  it('does not guess when the answer names no language', () => {
    expect(choiceFromAnswer('yes', offered)).toBeNull()
    expect(choiceFromAnswer('anything is fine', offered)).toBeNull()
  })

  it('does not accept a language the business does not offer', () => {
    expect(choiceFromAnswer('Tamil', offered)).toBeNull()
  })

  it('does not pick between two named languages, or through a negation', () => {
    // "not English, Telugu" is clear to a person and a trap for a pattern — it once read
    // a demand for Telugu as one for Hindi. Asking again costs one short question.
    expect(choiceFromAnswer('English or Telugu, anything', offered)).toBeNull()
    expect(choiceFromAnswer('not English', offered)).toBeNull()
    expect(choiceFromAnswer('తెలుగు కాదు', offered)).toBeNull()
  })
})

describe('switchRequest', () => {
  const offered = ['en', 'te', 'hi']

  it('changes language when the caller asks for another offered one', () => {
    expect(switchRequest('can you speak in Hindi please', offered, 'te')).toBe('hi')
    expect(switchRequest('Telugu lo matladandi', offered, 'en')).toBe('te')
  })

  it('ignores a language that is only mentioned', () => {
    expect(switchRequest('I watched a Hindi movie yesterday', offered, 'te')).toBeNull()
    expect(switchRequest('Hindi', offered, 'te')).toBeNull()
  })

  it('ignores a request for the language already in use, or one not offered', () => {
    expect(switchRequest('speak in Telugu', offered, 'te')).toBeNull()
    expect(switchRequest('speak in Tamil', offered, 'te')).toBeNull()
  })
})
