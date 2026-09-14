// What the model is actually handed while a caller is unverified.
//
// The identity gate was well tested and still leaked, because every test called
// gateDisclosure directly and none looked at what runLookup returns. The gate said
// "not verified" perfectly correctly, and then the full record was sent to the
// model anyway with a note asking it not to use it. The data and the prohibition
// travelled together, so the only thing protecting someone's loan position was the
// model choosing to obey — while that same instruction asked it to check the
// caller's answer against a record it was told to keep secret.
//
// Two real calls came out of that: one where the agent greeted the account holder
// by name before asking anything, and one where it read out an overdue balance a
// single turn after a number was spoken, before any code compared that number to
// anything. Both times it happened to be the right person.
//
// So these tests assert on the payload, not the verdict. The question is never
// "did the gate say no" — it is "could the model have said it anyway".

import { describe, it, expect, beforeEach, vi } from 'vitest'

const RECORD = {
  'Customer ID': 'LN1068803',
  'Customer Name': 'Sai Nagarajan',
  'Phone Number': '+91 8475784680',
  'Amount Due (₹)': '₹295,127',
  'Outstanding Amount (₹)': '₹7,202,017',
  'Interest Rate (% p.a.)': '8.63%',
  'Next Due Date': '15-Sep-2026',
}

// Everything in the record that must never reach the model unverified. If any of
// these strings appears in the payload, the caller could have heard it.
const SECRETS = Object.values(RECORD)

const searchText = (row) => Object.values(row).join(' ').toLowerCase()

vi.mock('../src/api/db.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({
        ilike: (_c, pattern) => ({
          limit: async (n) => {
            const needle = String(pattern).replace(/^%|%$/g, '').toLowerCase()
            const hit = searchText(RECORD).includes(needle) ? [{ row: RECORD }] : []
            return { data: hit.slice(0, n), error: null }
          },
        }),
        // the empty-dataset check on the miss path
        then: (res) => res({ count: 1, error: null }),
      }) }) }),
    }),
  },
}))

const { runLookup, noteSpokenDigits } = await import('../src/services/lookups.js')

const REGISTERED = '8475784680'
const ANOTHER_HANDSET = '919003503664'   // the number this call is coming from

const cfg = {
  tenant_id: 't1',
  lookups: [{
    name: 'loan_status',
    parameters: [{ name: 'customer_id' }],
    backend: { type: 'table', dataset: 'loans' },
  }],
}

let state
beforeEach(() => {
  state = { rows: new Map(), spokenDigits: new Set(), identityVerified: false, identityChallengeSent: false }
})

const lookup = (callerNumber = ANOTHER_HANDSET) =>
  runLookup(cfg, 'loan_status', { customer_id: 'LN1068803' }, { callerNumber, state })

describe('a caller ringing from a number that is not on the account', () => {
  it('is handed none of the record', async () => {
    const out = await lookup()
    for (const secret of SECRETS) expect(out, `leaked ${secret}`).not.toContain(secret)
  })

  it('is not even handed the account holder’s name', async () => {
    // The narrowest leak and the one that actually happened: "Thank you Rajesh
    // Sharma garu", said before a single question was asked.
    expect(await lookup()).not.toContain('Sai Nagarajan')
  })

  it('does not leak a figure in some other formatting either', async () => {
    // Guards against a future payload that "helpfully" sends stripped numbers.
    const out = await lookup()
    expect(out).not.toMatch(/295[,.]?127/)
    expect(out).not.toMatch(/8475784680/)
  })

  it('is told a record exists, so it does not apologise for finding nothing', async () => {
    // Withholding must not look like a miss, or the agent tells a real customer
    // they have no account.
    const out = await lookup()
    expect(out).not.toMatch(/^No matching record/)
    expect(JSON.parse(out.split('\n')[0])).toMatchObject({ record_found: true })
  })

  it('starts with something the model can parse', async () => {
    const out = await lookup()
    expect(() => JSON.parse(out.split('\n')[0])).not.toThrow()
  })
})

describe('what it is told to do instead', () => {
  it('asks for the registered mobile number', async () => {
    expect(await lookup()).toContain('the mobile number registered on the account')
  })

  it('offers only a challenge the code can check', async () => {
    // A question nothing verifies can never release the record, so a genuine
    // caller would answer it correctly and be asked again forever.
    const out = await lookup()
    expect(out).not.toMatch(/date of birth|registered address|email address/i)
  })

  it('is told to call the lookup again once they answer', async () => {
    // Without this the model has no route to the data at all and will either
    // stall or invent something.
    expect(await lookup()).toMatch(/CALL THIS LOOKUP AGAIN/)
  })

  it('is told it has nothing until it does', async () => {
    const out = await lookup()
    expect(out).toMatch(/until you call the lookup again you still have nothing/i)
  })

  it('is forbidden from inventing a figure to fill the gap', async () => {
    // The new risk. It cannot leak what it does not have, so the remaining danger
    // is confabulation.
    expect(await lookup()).toMatch(/must not guess, estimate or invent/i)
  })

  it('is told not to announce it as a security step', async () => {
    expect(await lookup()).toMatch(/do NOT say "for security"/)
  })

  it('does not ask a second time on the next gated lookup', async () => {
    await lookup()
    expect(await lookup()).toMatch(/ALREADY asked/)
  })

  it('still withholds the record on that second lookup', async () => {
    await lookup()
    const out = await lookup()
    for (const secret of SECRETS) expect(out).not.toContain(secret)
  })
})

describe('once the caller answers', () => {
  it('releases the record when they state the registered number', async () => {
    await lookup()
    noteSpokenDigits(state, 'register mobile number ho jayegi 8475784680')
    const out = await lookup()
    expect(JSON.parse(out)['Customer Name']).toBe('Sai Nagarajan')
    expect(JSON.parse(out)['Amount Due (₹)']).toBe('₹295,127')
  })

  it('matches the number however they say it', async () => {
    await lookup()
    noteSpokenDigits(state, 'it is +91 84757-84680')
    expect(await lookup()).toContain('Sai Nagarajan')
  })

  it('keeps withholding when they state the wrong number', async () => {
    await lookup()
    noteSpokenDigits(state, 'my number is 9999900000')
    const out = await lookup()
    for (const secret of SECRETS) expect(out).not.toContain(secret)
  })

  it('is not fooled by them reciting the customer ID back', async () => {
    // The ID is what they used to search. It proves nothing about who they are.
    await lookup()
    noteSpokenDigits(state, 'my customer id is LN1068803')
    expect(await lookup()).not.toContain('Sai Nagarajan')
  })

  it('stays verified for the rest of the call', async () => {
    await lookup()
    noteSpokenDigits(state, '8475784680')
    await lookup()
    expect(state.identityVerified).toBe(true)
    expect(await lookup()).toContain('Sai Nagarajan')
  })
})

describe('callers the gate was never meant to stop', () => {
  it('hands the record straight over when they ring from the registered number', async () => {
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1068803' },
      { callerNumber: `91${REGISTERED}`, state })
    expect(JSON.parse(out)['Customer Name']).toBe('Sai Nagarajan')
  })

  it('does not gate a tenant that has turned identity checks off', async () => {
    const off = { ...cfg, verify_caller_identity: false }
    const out = await runLookup(off, 'loan_status', { customer_id: 'LN1068803' },
      { callerNumber: ANOTHER_HANDSET, state })
    expect(out).toContain('Sai Nagarajan')
  })

  it('does not gate when there is no caller ID to compare', async () => {
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1068803' },
      { callerNumber: null, state })
    expect(out).toContain('Sai Nagarajan')
  })
})
