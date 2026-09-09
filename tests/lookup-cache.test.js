// Remembering a caller's record for the length of their call.
//
// A caller asks about their loan, then the interest rate, then the outstanding
// balance, then what is left to pay. One row, four questions — and it was four round
// trips to the database, 200-460ms each, landing in the silence after they stopped
// speaking. They heard every one.
//
// The cache lives on the per-call state object, and that scope is the point. A global
// cache with a sixty-second timer was the obvious first answer and it was wrong: on a
// real call five conversational turns passed between two lookups, the entry had
// expired, and the caller waited again. These tests pin the scope, not a duration.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub the database, and count every query. The count is the whole assertion:
// "served from cache" means the database was not asked, and nothing else proves it.
const rows = []
const db = { queries: 0 }
vi.mock('../src/api/db.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ ilike: () => ({
        limit: async () => { db.queries++; return { data: rows, error: null } },
      }) }) }) }),
      delete: () => ({ eq: () => ({ eq: async () => ({}) }) }),
    }),
  },
}))

const { runLookup } = await import('../src/services/lookups.js')

const RECORD = {
  customer_id: 'LN100042',
  name: 'Rajesh Sharma',
  phone: '9603859770',
  interest_rate: '14.07',
  emi_amount: '19578',
  outstanding: '251428',
}

const config = (tenantId = 't1') => ({
  tenant_id: tenantId,
  verify_caller_identity: false,          // the gate has its own suite
  lookups: [{
    name: 'loan_status',
    description: 'Loan status',
    parameters: [{ name: 'customer_id', description: 'Customer ID' }],
    backend: { type: 'table', dataset: 'loans' },
  }],
})

/** A fresh per-call scratch object, exactly as the engine creates one. */
const newCall = () => ({ identityChallengeSent: false, identityVerified: false, spokenDigits: new Set(), rows: new Map() })

const ask = (cfg, state, args) => runLookup(cfg, 'loan_status', args, { state })

beforeEach(() => {
  rows.length = 0
  rows.push({ row: RECORD })
  db.queries = 0
})

describe('repeat questions inside one call', () => {
  it('asks the database once, however many questions follow', async () => {
    // The sequence from the real call: rate, then outstanding, then EMI.
    const cfg = config(), call = newCall()
    const a = await ask(cfg, call, { customer_id: 'LN100042' })
    const b = await ask(cfg, call, { customer_id: 'LN100042' })
    const c = await ask(cfg, call, { customer_id: 'LN100042' })
    expect(a).toContain('251428')
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(db.queries).toBe(1)
  })

  it('still answers from cache many turns later', async () => {
    // This is what the sixty-second timer got wrong. A long call is not a stale one.
    const cfg = config(), call = newCall()
    await ask(cfg, call, { customer_id: 'LN100042' })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(10 * 60_000)
      await ask(cfg, call, { customer_id: 'LN100042' })
      expect(db.queries).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('treats differently-spoken forms of one identifier as one entry', async () => {
    const cfg = config(), call = newCall()
    const a = await ask(cfg, call, { customer_id: 'LN100042' })
    for (const said of ['ln100042', 'LN 100042', 'ln-100042', ' LN100042 ']) {
      expect(await ask(cfg, call, { customer_id: said }), said).toBe(a)
    }
    expect(db.queries).toBe(1)
  })

  it('does not confuse two different customers', async () => {
    const cfg = config(), call = newCall()
    await ask(cfg, call, { customer_id: 'LN100042' })
    rows[0] = { row: { ...RECORD, customer_id: 'LN100043', outstanding: '999999' } }
    expect(await ask(cfg, call, { customer_id: 'LN100043' })).toContain('999999')
  })

  it('does not confuse two lookups that take the same argument', async () => {
    const cfg = {
      ...config(),
      lookups: [
        { name: 'loan_status', parameters: [{ name: 'id' }], backend: { type: 'table', dataset: 'loans' } },
        { name: 'card_status', parameters: [{ name: 'id' }], backend: { type: 'table', dataset: 'cards' } },
      ],
    }
    const call = newCall()
    await runLookup(cfg, 'loan_status', { id: 'X1' }, { state: call })
    rows[0] = { row: { id: 'X1', kind: 'card', limit: '50000' } }
    expect(await runLookup(cfg, 'card_status', { id: 'X1' }, { state: call })).toContain('50000')
  })
})

describe('the scope of the cache', () => {
  it('shares nothing between two calls', async () => {
    // The next caller gets a fresh state object, so nothing can carry over — not a
    // stale figure, and not another person's record.
    const cfg = config()
    await ask(cfg, newCall(), { customer_id: 'LN100042' })
    rows[0] = { row: { ...RECORD, outstanding: 'PAID' } }
    expect(await ask(cfg, newCall(), { customer_id: 'LN100042' })).toContain('PAID')
    expect(db.queries).toBe(2)
  })

  it('queries every time when there is no call state at all', async () => {
    const cfg = config()
    await runLookup(cfg, 'loan_status', { customer_id: 'LN100042' })
    await runLookup(cfg, 'loan_status', { customer_id: 'LN100042' })
    expect(db.queries).toBe(2)
  })

  it('cannot grow without bound', async () => {
    const cfg = config(), call = newCall()
    for (let i = 0; i < 120; i++) {
      rows[0] = { row: { ...RECORD, customer_id: `LN${100000 + i}` } }
      await ask(cfg, call, { customer_id: `LN${100000 + i}` })
    }
    expect(call.rows.size).toBeLessThanOrEqual(50)
  })
})

describe('what is not cached', () => {
  it('does not cache a miss', async () => {
    // A miss almost always means the identifier was misheard, so the correction has
    // different arguments anyway — and caching one would hide a row just uploaded.
    const cfg = config(), call = newCall()
    rows.length = 0
    expect(await ask(cfg, call, { customer_id: 'LN999999' })).toMatch(/No matching record/)
    const afterMiss = db.queries

    rows.push({ row: { ...RECORD, customer_id: 'LN999999', outstanding: '4242' } })
    expect(await ask(cfg, call, { customer_id: 'LN999999' })).toContain('4242')
    // Not a fixed count: a miss runs several probe variants before giving up, and
    // that is resolveTable's business, not the cache's.
    expect(db.queries).toBeGreaterThan(afterMiss)
  })

  it('does not cache a call with no arguments', async () => {
    const cfg = config(), call = newCall()
    expect(await ask(cfg, call, {})).toMatch(/No matching record/)
    expect(call.rows.size).toBe(0)
  })
})

describe('the identity gate still runs on a cached row', () => {
  it('re-checks every lookup rather than inheriting a verdict', async () => {
    // A cached "verified" would be a way to inherit someone else's verification, so
    // the row is cached but the gate is not.
    const cfg = { ...config(), verify_caller_identity: true }
    const call = newCall()
    const from = '919003503664'              // not the number on the record

    const first = await runLookup(cfg, 'loan_status', { customer_id: 'LN100042' }, { callerNumber: from, state: call })
    expect(first).toMatch(/IDENTITY NOT VERIFIED/)

    // Served from cache this time — and still gated.
    const second = await runLookup(cfg, 'loan_status', { customer_id: 'LN100042' }, { callerNumber: from, state: call })
    expect(db.queries).toBe(1)
    expect(second).toMatch(/IDENTITY STILL NOT VERIFIED/)
  })
})
