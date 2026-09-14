// Finding the right row, and refusing the wrong one.
//
// This is the sharp end of the product: a caller reads out their number and either
// gets their loan or gets told they do not exist. Both failures are expensive, and
// they pull in opposite directions — loose matching hands someone a stranger's
// balance, strict matching turns a real customer away.
//
// Every case here comes from a real call.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// A tenant's uploaded sheet, in the shape the ingest actually produces: phone numbers
// carry a country code and a space, money carries a symbol and thousands commas.
const SHEET = [
  { 'Customer ID': 'LN100077', 'Customer Name': 'Ajay Acharya', 'Phone Number': '+91 7185188888', 'EMI Amount (₹)': '₹96,212', 'Outstanding Amount (₹)': '₹1,143,927' },
  { 'Customer ID': 'LN100078', 'Customer Name': 'Rekha Rao', 'Phone Number': '+91 9603859770', 'EMI Amount (₹)': '₹19,578', 'Outstanding Amount (₹)': '₹251,428' },
  { 'Customer ID': 'LN100001', 'Customer Name': 'Aadhya Reddy', 'Phone Number': '+91 8332181960', 'EMI Amount (₹)': '₹96,212', 'Outstanding Amount (₹)': '₹11,439,279' },
]
const searchText = (row) => Object.values(row).join(' ').toLowerCase()

// Stub Supabase with the substring behaviour of the real ILIKE probe.
vi.mock('../src/api/db.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ ilike: (_col, pattern) => ({
        limit: async (n) => {
          const needle = String(pattern).replace(/^%|%$/g, '').toLowerCase()
          const hits = SHEET.filter(r => searchText(r).includes(needle)).slice(0, n)
          return { data: hits.map(row => ({ row })), error: null }
        },
      }) }) }) }),
    }),
  },
}))

const { runLookup } = await import('../src/services/lookups.js')

const cfg = {
  tenant_id: 't1',
  verify_caller_identity: false,          // the gate has its own suite
  lookups: [{
    name: 'loan_status',
    parameters: [{ name: 'customer_id' }, { name: 'phone_number' }, { name: 'customer_name' }],
    backend: { type: 'table', dataset: 'loans' },
  }],
}

let call
beforeEach(() => { call = { rows: new Map() } })

/** @returns {object|null} the matched row, or null on a miss. */
async function find(args) {
  const out = await runLookup(cfg, 'loan_status', args, { state: call })
  if (/^No matching record/.test(out)) return null
  return JSON.parse(out)
}

describe('a phone number, however it is written', () => {
  // The sheet stores "+91 7185188888". The caller says ten digits. On a real call
  // this exact mismatch made the lookup refuse a correct number, twice, and the
  // customer was told their record did not exist.
  const forms = {
    'as the caller says it': '7185188888',
    'with the country code': '917185188888',
    'written the way the sheet has it': '+91 7185188888',
    'with a trunk zero': '07185188888',
    'with spacing': '71851 88888',
    'with a hyphen': '718-518-8888',
  }

  for (const [label, value] of Object.entries(forms)) {
    it(`matches ${label}`, async () => {
      expect((await find({ phone_number: value }))?.['Customer Name']).toBe('Ajay Acharya')
    })
  }

  it('still refuses a number nobody has', async () => {
    expect(await find({ phone_number: '9999900000' })).toBeNull()
  })

  it('does not match a different customer on a near-miss number', async () => {
    // One digit out is a different person, not a typo to be helpful about.
    expect(await find({ phone_number: '7185188889' })).toBeNull()
  })
})

describe('a customer ID', () => {
  it('matches the exact id', async () => {
    expect((await find({ customer_id: 'LN100077' }))?.['Customer Name']).toBe('Ajay Acharya')
  })

  it('matches however the caller spaces or punctuates it', async () => {
    for (const said of ['ln100077', 'LN 100077', 'ln-100077']) {
      expect((await find({ customer_id: said }))?.['Customer ID'], said).toBe('LN100077')
    }
  })

  it('refuses an id with a character too many', async () => {
    // The real failure: the model heard LN100077 and searched LN1000077. Returning
    // a "close" row here would hand out someone else's loan.
    expect(await find({ customer_id: 'LN1000077' })).toBeNull()
  })

  it('refuses a neighbouring id rather than guessing', async () => {
    expect(await find({ customer_id: 'LN10007' })).toBeNull()
  })

  it('never matches an id against a money column', async () => {
    // Two rows carry "₹96,212". If normalisation stripped the symbol and comma, an
    // id of 96212 would exact-match an EMI amount and return a stranger.
    expect(await find({ customer_id: '96212' })).toBeNull()
  })

  it('never lets a long account number match on its tail', async () => {
    // Phone equivalence compares the last ten digits, so it must not apply to
    // values that are too long to be a phone number.
    expect(await find({ customer_id: '99999917185188888' })).toBeNull()
  })
})

describe('a name, where partial matching is the point', () => {
  it('finds someone from part of their name', async () => {
    expect((await find({ customer_name: 'Rekha' }))?.['Customer ID']).toBe('LN100078')
  })

  it('does not treat a name as identification', async () => {
    // A name plus a wrong id must not resolve: the id is the identifier, and it
    // failed. Two people share a surname; nobody shares an account number.
    expect(await find({ customer_name: 'Rekha', customer_id: 'LN999999' })).toBeNull()
  })
})

describe('what the model is told when nothing matched', () => {
  it('hands back the exact value that was searched', async () => {
    // The spoken read-back and the searched value had drifted apart, so the caller
    // could not catch the error. Naming what was actually used closes that gap.
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1000077' }, { state: call })
    expect(out).toContain('LN1000077')
    expect(out).toMatch(/read back the EXACT value above, one character at a time/i)
  })

  it('says a wrong character is likelier than a missing customer', async () => {
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1000077' }, { state: call })
    expect(out).toMatch(/ALMOST CERTAINLY YOU HAVE ONE CHARACTER WRONG/)
    expect(out).toMatch(/do NOT suggest a technical fault/i)
  })

  it('bans the grouping that hides the error', async () => {
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1000077' }, { state: call })
    expect(out).toMatch(/NEVER say "double", "triple"/)
  })

  it('tells it to switch to a different detail if the value is confirmed', async () => {
    const out = await runLookup(cfg, 'loan_status', { phone_number: '9999900000' }, { state: call })
    expect(out).toMatch(/ask for a DIFFERENT detail instead/i)
  })

  it('never narrates the machinery, even on a miss', async () => {
    const out = await runLookup(cfg, 'loan_status', { customer_id: 'LN1000077' }, { state: call })
    expect(out).toMatch(/Do NOT mention lookups, records, systems/)
  })

  it('falls back cleanly when there was nothing to search with', async () => {
    const out = await runLookup(cfg, 'loan_status', {}, { state: call })
    expect(out).toMatch(/^No matching record/)
    expect(out).not.toContain('You searched using')
  })
})
