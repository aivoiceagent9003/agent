import { describe, it, expect } from 'vitest'
import { acknowledgementFor, allAcknowledgements, familyFor, SILENT_TOOLS, LANGUAGES } from '../src/services/acknowledgements.js'

describe('which operations are worth speaking for', () => {
  it('treats a knowledge search as a knowledge lookup', () => {
    expect(familyFor('search_knowledge')).toBe('knowledge')
  })

  it('stays silent for tools that are instant or end the call', () => {
    for (const tool of SILENT_TOOLS) expect(familyFor(tool)).toBe(null)
    // Announcing a check while hanging up is nonsense, so this one matters most.
    expect(acknowledgementFor({ tool: 'end_call', language: 'en' })).toBe(null)
  })

  it('reads a tenant\'s own lookup name for what it is about', () => {
    // Tenants name these themselves, so the mapping is by intent, not a fixed list.
    expect(familyFor('check_payment_status')).toBe('record')
    expect(familyFor('lookup_emi_due')).toBe('record')
    expect(familyFor('find_booking')).toBe('record')
    expect(familyFor('property_availability')).toBe('search')
    expect(familyFor('check_inventory')).toBe('search')
  })

  it('falls back to the caller\'s-own-record wording for a lookup it cannot classify', () => {
    expect(familyFor('acme_custom_thing')).toBe('record')
  })

  it('says nothing for an empty or missing tool name', () => {
    expect(familyFor('')).toBe(null)
    expect(familyFor(undefined)).toBe(null)
  })
})

describe('what the acknowledgement is allowed to say', () => {
  const every = allAcknowledgements()

  it('never claims a result, a count, or a success', () => {
    // The whole risk of speaking before the answer exists is implying you have it.
    // On an insurance line that is a compliance problem, not a style one.
    // The test is for ASSERTIONS, not for words: "let me check what is available" is
    // fine, "there are two available" is not, and only the second one is a claim.
    const claims = [
      /\bi (found|have|checked)\b/i,
      /\bthere (are|is|were)\b/i,
      /\bwe have \d/i,
      /\b(is|are) available\b/i,
      /\b(confirmed|approved|eligible|rejected)\b/i,
      /₹|\brupees\b|\d{3,}/,
      /దొరికింది|ఉన్నాయి అని|मिल गया|मिल गये/,
    ]
    for (const { text } of every) {
      for (const claim of claims) expect(text, `${text} matched ${claim}`).not.toMatch(claim)
    }
  })

  it('stays short, because whatever is still playing delays the real answer', () => {
    for (const { text } of every) expect(text.length, text).toBeLessThanOrEqual(42)
  })

  it('writes Telugu in Telugu script and Hindi in Devanagari', () => {
    // Romanised Telugu is read with English phonetics and comes out unintelligible,
    // which is the one failure that makes this worse than silence.
    for (const { text, language } of every) {
      if (language === 'te') expect(text, text).toMatch(/[ఀ-౿]/)
      if (language === 'hi') expect(text, text).toMatch(/[ऀ-ॿ]/)
      if (language === 'te') expect(text, text).not.toMatch(/\bandi\b|\bcheyyanu\b/i)
    }
  })

  it('offers every family in every language', () => {
    expect(LANGUAGES).toEqual(expect.arrayContaining(['te', 'hi', 'en']))
    expect(every.length).toBe(LANGUAGES.length * 3 * 3)
  })
})

describe('variation without unpredictability', () => {
  it('gives the same call and turn the same line every time', () => {
    const once = acknowledgementFor({ tool: 'search_knowledge', language: 'te', turn: 3, seed: 'CA123' })
    const again = acknowledgementFor({ tool: 'search_knowledge', language: 'te', turn: 3, seed: 'CA123' })
    expect(once.text).toBe(again.text)
  })

  it('does not repeat itself when a caller triggers several lookups in a row', () => {
    const said = [1, 2, 3].map(turn =>
      acknowledgementFor({ tool: 'search_knowledge', language: 'en', turn, seed: 'CA1' }).text)
    expect(new Set(said).size).toBe(3)
  })

  it('starts different calls at different points in the rotation', () => {
    // Not a promise that two given calls differ — with three lines they collide a
    // third of the time, and two callers cannot hear each other anyway. What matters
    // is that the call id moves the starting point at all, so the whole fleet does
    // not open every lookup with the same sentence.
    const firstLines = new Set(
      ['CA-a', 'CA-b', 'CA-c', 'CA-d', 'CA-e', 'CA-f'].map(seed =>
        acknowledgementFor({ tool: 'search_knowledge', language: 'en', turn: 1, seed }).text))
    expect(firstLines.size).toBeGreaterThan(1)
  })

  it('answers in the caller\'s language', () => {
    expect(acknowledgementFor({ tool: 'search_knowledge', language: 'te' }).language).toBe('te')
    expect(acknowledgementFor({ tool: 'search_knowledge', language: 'hi' }).language).toBe('hi')
  })

  it('falls back to English rather than guessing at an unknown language', () => {
    // Speaking Telugu at a Hindi caller is worse than the silence this removes.
    const ack = acknowledgementFor({ tool: 'search_knowledge', language: 'ta' })
    expect(ack.language).toBe('en')
  })
})
