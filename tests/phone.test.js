// E.164 phone normalisation.
//
// Regression cover for two bugs that both had the same consequence. Suppression is
// an EXACT STRING COMPARISON against this output, so any spelling of a number that
// normalises differently from the others is a do-not-call request that looks
// recorded and silently is not. That is the worst available failure for the opt-out
// feature: the person asked, the system said yes, and the calls keep coming.
//
//   1. "09876543210" kept the national trunk zero      -> "+09876543210"
//   2. "0091 9876543210" kept the IDD access prefix    -> "+00919876543210"
//
// Neither is dialable, and neither matches the same person written any other way.

import { describe, it, expect } from 'vitest'
import { normalizePhone } from '../src/services/campaigns/contacts.js'
import { normalizePhone as dndNormalizePhone } from '../src/services/dnd.js'

const E164 = /^\+[1-9]\d{7,14}$/

describe('one Indian mobile, ten spellings', () => {
  const spellings = [
    '+919876543210',
    '919876543210',
    '9876543210',
    '09876543210',        // national trunk prefix
    '0091 9876543210',    // IDD access prefix, spaced
    '00919876543210',     // IDD access prefix
    '+91 98765 43210',
    '+91-9876543210',
    '98765-43210',
    ' 0 98765 43210 ',
  ]

  for (const raw of spellings) {
    it(`normalises ${JSON.stringify(raw)}`, () => {
      expect(normalizePhone(raw)).toBe('+919876543210')
    })
  }

  it('produces exactly one distinct value across all of them', () => {
    // The property that actually matters — not that any single input is right, but
    // that no two spellings of one number can end up as different keys.
    expect(new Set(spellings.map((s) => normalizePhone(s))).size).toBe(1)
  })
})

describe('international numbers', () => {
  it('keeps an explicit country code', () => {
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671')
  })

  it('strips the IDD prefix from a non-Indian number too', () => {
    expect(normalizePhone('0014155552671')).toBe('+14155552671')
  })

  it('honours a country code argument for bare local numbers', () => {
    expect(normalizePhone('4155552671', '1')).toBe('+14155552671')
  })
})

describe('rejection', () => {
  const rejected = [
    ['empty', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['letters only', 'not a phone'],
    ['too short', '12345'],
    ['plus with IDD prefix', '+00919876543210'],
    ['plus with leading zero', '+0919876543210'],
    ['all zeros', '000000000000'],
  ]

  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(normalizePhone(raw)).toBeNull()
    })
  }

  it('never returns a leading-zero country code', () => {
    // E.164 has no country code starting with zero. Accepting one would put an
    // undialable value into the suppression list that cannot ever match.
    for (const [, raw] of rejected) {
      const out = normalizePhone(raw)
      if (out !== null) expect(out.startsWith('+0')).toBe(false)
    }
  })
})

describe('every accepted value is valid E.164', () => {
  const inputs = [
    '+919876543210', '9876543210', '09876543210', '0091 9876543210',
    '+1 415 555 2671', '0014155552671', '+91 98765 43210', '98765-43210',
    '', 'abc', '12345', '+00919876543210', '000000000000',
  ]

  it('holds for the whole corpus', () => {
    for (const raw of inputs) {
      const out = normalizePhone(raw)
      if (out !== null) expect(out).toMatch(E164)
    }
  })
})

describe('the DND normaliser agrees with the contact importer', () => {
  // These MUST agree by construction — dnd.js delegates here rather than
  // reimplementing. If they ever diverge, an opt-out recorded on a call stops
  // matching the imported contact row and the person gets called again.
  const inputs = [
    '+919876543210', '919876543210', '9876543210', '09876543210',
    '0091 9876543210', '00919876543210', '+91 98765 43210', '98765-43210',
    '+1 415 555 2671', '0014155552671',
    '', '   ', 'abc', '12345', '+00919876543210', '000000000000',
  ]

  for (const raw of inputs) {
    it(`agrees on ${JSON.stringify(raw)}`, () => {
      // dnd.js returns '' where contacts.js returns null; both mean "unusable".
      expect(dndNormalizePhone(raw)).toBe(normalizePhone(raw) || '')
    })
  }
})
