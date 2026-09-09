// The identity gate on financial lookups.
//
// This decides whether an agent may read someone's balance, EMI or due date out loud
// to whoever picked up the phone. Getting it wrong in one direction leaks a stranger's
// finances; getting it wrong in the other re-interrogates a customer who has already
// answered, which is what happened on a real call:
//
//   caller gives registered number → gets EMI details → asks a follow-up →
//   challenged again → agent invents a second requirement, apologises, and makes
//   them repeat the number they had just given.
//
// The gate had no memory of the answer, because it only ever compared the number the
// call came FROM. It never looked at what the caller SAID.

import { describe, it, expect } from 'vitest'
import { gateDisclosure, noteSpokenDigits } from '../src/services/lookups.js'

// The real record and the real call that exposed this, with the loan reference kept
// so the row shape matches production.
const row = {
  customer_id: 'LN100010',
  name: 'Manoj',
  phone: '9376311656',
  loan_start_date: '2024-06-16',
  emi_amount: '20879',
  outstanding: '848421',
}
const FROM_ANOTHER_HANDSET = '919003503664'
const spoken = (...turns) => { const s = {}; for (const t of turns) noteSpokenDigits(s, t); return s.spokenDigits }

describe('who the caller is', () => {
  it('passes a call from the number on the record', () => {
    expect(gateDisclosure(row, { callerNumber: '919376311656' }).verified).toBe(true)
  })

  it('holds a call from any other number until they answer', () => {
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET })
    expect(g.verified).toBe(false)
    expect(g.challenges).toContain('the mobile number registered on the account')
  })

  it('still hands the record over, so the agent knows one exists', () => {
    expect(gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET }).row).toBe(row)
  })

  it('cannot check a call with no caller id, so it does not pretend to', () => {
    expect(gateDisclosure(row, { callerNumber: null }).verified).toBe(true)
    expect(gateDisclosure(row, { callerNumber: 'anonymous' }).verified).toBe(true)
  })

  it('does not invent a check when the record holds no phone number', () => {
    const { phone, ...noPhone } = row
    expect(gateDisclosure(noPhone, { callerNumber: FROM_ANOTHER_HANDSET }).verified).toBe(true)
  })

  it('is off entirely for tenants that do not want it', () => {
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, tenantConfig: { verify_caller_identity: false } })
    expect(g.verified).toBe(true)
  })
})

describe('answering the challenge', () => {
  it('accepts the registered number spoken aloud from another handset', () => {
    const g = gateDisclosure(row, {
      callerNumber: FROM_ANOTHER_HANDSET,
      spokenDigits: spoken('registered mobile number aa chesi 9376311656'),
    })
    expect(g.verified).toBe(true)
    expect(g.verifiedBy).toBe('spoken')
  })

  it('accepts it however they space or punctuate it', () => {
    for (const said of ['93763 11656', '937-631-1656', 'it is 0 9376311656', '+91 9376311656']) {
      expect(gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, spokenDigits: spoken(said) }).verified,
        said).toBe(true)
    }
  })

  it('refuses a wrong number', () => {
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, spokenDigits: spoken('my number is 9999900000') })
    expect(g.verified).toBe(false)
  })

  it('refuses the customer ID — knowing the account number is not knowing the customer', () => {
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, spokenDigits: spoken('my customer id is LN100010') })
    expect(g.verified).toBe(false)
  })

  it('ignores short numbers that are not phone numbers', () => {
    // An EMI amount or a date must never be mistaken for an answer.
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, spokenDigits: spoken('I paid 20879 on 16 06 2024') })
    expect(g.verified).toBe(false)
  })

  it('leaves the gate closed when the transcript spelled the number out in words', () => {
    // Failing closed is the right direction: the agent simply asks again.
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, spokenDigits: spoken('nine three seven six three one one six five six') })
    expect(g.verified).toBe(false)
  })
})

describe('the loop that broke a real call', () => {
  it('does not challenge a second time once they have passed', () => {
    const g = gateDisclosure(row, { callerNumber: FROM_ANOTHER_HANDSET, alreadyVerified: true })
    expect(g.verified).toBe(true)
    expect(g.challenges).toBeUndefined()
  })

  it('replays the real call correctly end to end', () => {
    // A per-call scratch object, exactly as the engine keeps it.
    const state = { identityVerified: false }
    const check = () => {
      const g = gateDisclosure(row, {
        callerNumber: FROM_ANOTHER_HANDSET,
        spokenDigits: state.spokenDigits,
        alreadyVerified: state.identityVerified,
      })
      if (g.verified) state.identityVerified = true
      return g.verified
    }

    noteSpokenDigits(state, 'EMI details telusukovali anukuntunnanu')
    expect(check(), 'before they have identified themselves').toBe(false)

    noteSpokenDigits(state, 'maa customer id vachesi LN100010')
    expect(check(), 'a customer ID is not identification').toBe(false)

    noteSpokenDigits(state, 'registered mobile number aa chesi 9376311656')
    expect(check(), 'they answered the challenge').toBe(true)

    noteSpokenDigits(state, 'naa loan start date emanna gurthunda')
    expect(check(), 'follow-up question — must NOT re-challenge').toBe(true)

    noteSpokenDigits(state, 'outstanding amount kitna hai zara bataiye na')
    expect(check(), 'and again on the next lookup').toBe(true)
  })
})

describe('noteSpokenDigits', () => {
  it('survives being handed nothing', () => {
    expect(() => noteSpokenDigits(null, 'x')).not.toThrow()
    const s = {}
    noteSpokenDigits(s, null)
    expect(s.spokenDigits.size).toBe(0)
  })

  it('accumulates across turns', () => {
    const s = {}
    noteSpokenDigits(s, 'try 9000011111')
    noteSpokenDigits(s, 'no wait, 9376311656')
    expect(s.spokenDigits.size).toBe(2)
    expect(s.spokenDigits.has('9376311656')).toBe(true)
  })
})
