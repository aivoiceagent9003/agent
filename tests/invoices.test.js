// Invoices, GST and plan changes — the arithmetic a customer disputes.
//
// Every case here is one where a plausible implementation and a correct one produce
// different money. None of them throws when it is wrong; they produce a number that
// looks like a number, on a document somebody pays.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// The supplier's own registration state decides the CGST/SGST vs IGST split, and it is
// read at module load. Stubbed before the import so every test sees the same one.
vi.stubEnv('COMPANY_GST_STATE_CODE', '36')   // Telangana
const inv = await import('../src/services/invoices.js')
const { planChange, applyPendingPlan, billingCycle } = await import('../src/services/billing.js')
const { PLANS } = await import('../src/config/plans.js')

const { splitGst, rupeesToPaise, paiseToRupees, invoiceNumber, financialYear, buildInvoice, buildLineItems, prorateUpgrade, isUpgrade, invoicingReady } = inv

describe('money is stored in paise', () => {
  it('survives the amounts that break floats', () => {
    expect(rupeesToPaise(1234.56)).toBe(123456)
    expect(rupeesToPaise(0.1) + rupeesToPaise(0.2)).toBe(rupeesToPaise(0.3))
    expect(paiseToRupees(123456)).toBe(1234.56)
  })

  it('rounds rather than truncating a half-paisa', () => {
    expect(rupeesToPaise(4.505)).toBe(451)
  })
})

describe('GST', () => {
  const sub = rupeesToPaise(11999)

  it('splits a same-state sale into equal halves of CGST and SGST', () => {
    const g = splitGst(sub, '36')
    expect(g.intraState).toBe(true)
    expect(g.igst).toBe(0)
    expect(g.cgst + g.sgst).toBe(g.tax)
  })

  it('charges IGST on a sale to another state', () => {
    const g = splitGst(sub, '29')
    expect(g.intraState).toBe(false)
    expect(g.cgst).toBe(0)
    expect(g.sgst).toBe(0)
    expect(g.igst).toBe(g.tax)
  })

  // The halves are derived from the total, not computed separately. Rounding each one
  // independently loses a paisa on odd subtotals and the invoice stops adding up.
  it('charges the same total either way, to the paisa', () => {
    for (const rupees of [11999, 4999, 13999, 1, 7.77, 22411.1]) {
      const a = splitGst(rupeesToPaise(rupees), '36')
      const b = splitGst(rupeesToPaise(rupees), '29')
      expect(a.total, `₹${rupees}`).toBe(b.total)
      expect(a.cgst + a.sgst).toBe(b.igst)
    }
  })

  it('never loses a paisa between subtotal, tax and total', () => {
    for (let r = 1; r <= 500; r++) {
      const g = splitGst(rupeesToPaise(r * 7.13), '36')
      expect(g.cgst + g.sgst + g.igst).toBe(g.tax)
      expect(g.total).toBe(rupeesToPaise(r * 7.13) + g.tax)
    }
  })

  // Charging tax we cannot attribute to a state is worse than not charging it: the
  // money is collected and then filed wrong.
  it('charges nothing when it cannot tell where the supply happened', () => {
    const g = splitGst(sub, '')
    expect(g.tax).toBe(0)
    expect(g.intraState).toBeNull()
    expect(g.total).toBe(sub)
  })

  it('treats a negative subtotal as zero rather than refunding tax', () => {
    expect(splitGst(-5000, '36').total).toBe(0)
  })
})

describe('invoice numbers', () => {
  // India's financial year runs April to March, so January is in the PREVIOUS year's FY.
  it.each([
    ['2026-04-01', '2627'],
    ['2026-09-23', '2627'],
    ['2027-01-15', '2627'],
    ['2027-03-31', '2627'],
    ['2027-04-01', '2728'],
  ])('puts %s in FY %s', (date, fy) => {
    expect(financialYear(new Date(date))).toBe(fy)
  })

  it('pads to a fixed width so they sort and read consistently', () => {
    expect(invoiceNumber(1, new Date('2026-09-23'))).toBe('AL-2627-0001')
    expect(invoiceNumber(247, new Date('2026-09-23'))).toBe('AL-2627-0247')
  })
})

describe('what goes on the invoice', () => {
  const cycle = { start: '2026-09-08T00:00:00Z', end: '2026-10-08T00:00:00Z', daysTotal: 30 }
  const profile = { legal_name: 'GSK Insurance Pvt Ltd', gstin: '36AAAAA0000A1Z5', state_code: '36', state: 'Telangana', billing_email: 'accounts@example.test' }

  it('always bills the subscription, even with no usage', () => {
    const items = buildLineItems({ plan: PLANS.growth })
    expect(items).toHaveLength(1)
    expect(items[0].amountPaise).toBe(rupeesToPaise(11999))
  })

  it('bills overage at the plan rate', () => {
    const items = buildLineItems({ plan: PLANS.growth, overageMinutes: 100 })
    expect(items[1].amountPaise).toBe(rupeesToPaise(450))
  })

  // An upgrade is charged when it happens. Without this credit the customer pays the
  // difference twice — once mid-cycle and again on the invoice.
  it('credits back an upgrade already charged mid-cycle', () => {
    const items = buildLineItems({ plan: PLANS.scale, proratedPaise: rupeesToPaise(4500) })
    const credit = items.find(i => i.amountPaise < 0)
    expect(credit).toBeTruthy()
    expect(credit.amountPaise).toBe(-rupeesToPaise(4500))
    expect(items.reduce((a, i) => a + i.amountPaise, 0)).toBe(rupeesToPaise(13999 - 4500))
  })

  it('adds up to the total it charges', () => {
    const invoice = buildInvoice({
      tenantId: 't1', number: 'AL-2627-0001', plan: PLANS.growth,
      cycle, overageMinutes: 100, extraNumbers: 2, profile,
    })
    const lines = invoice.line_items.reduce((a, i) => a + i.amountPaise, 0)
    expect(invoice.subtotal_paise).toBe(lines)
    expect(invoice.total_paise).toBe(
      invoice.subtotal_paise + invoice.cgst_paise + invoice.sgst_paise + invoice.igst_paise)
  })

  // A customer who moves office next month must not find last month's invoice rewritten.
  it('freezes the billing address into the row', () => {
    const invoice = buildInvoice({ tenantId: 't1', number: 'AL-2627-0001', plan: PLANS.growth, cycle, profile })
    expect(invoice.bill_to.legal_name).toBe('GSK Insurance Pvt Ltd')
    expect(invoice.bill_to.gstin).toBe('36AAAAA0000A1Z5')
    expect(invoice.place_of_supply).toBe('36')
  })

  it('gives a due date after the issue date', () => {
    const i = buildInvoice({ tenantId: 't1', number: 'x', plan: PLANS.starter, cycle, profile })
    expect(new Date(i.due_at).getTime()).toBeGreaterThan(new Date(i.issued_at).getTime())
  })

  it('will not call itself ready without the details GST requires', () => {
    expect(invoicingReady({}).ready).toBe(false)
    expect(invoicingReady({}).missing).toContain('legal name')
    expect(invoicingReady(profile).ready).toBe(true)
  })
})

describe('changing plan', () => {
  const SIGNUP = '2026-09-08T09:00:00Z'
  const now = new Date('2026-09-23T12:00:00Z')   // day 16 of a 30-day cycle

  it('knows which direction a change goes', () => {
    expect(isUpgrade('starter', 'scale')).toBe(true)
    expect(isUpgrade('scale', 'starter')).toBe(false)
    expect(isUpgrade('growth', 'nonsense')).toBe(false)
  })

  // Charging the full new price mid-cycle bills the customer twice for days they have
  // already paid for. Only the difference, and only for the days remaining.
  it('charges an upgrade pro rata on the difference alone', () => {
    const c = planChange({ tenantConfig: { plan: 'starter' }, toPlanId: 'scale', signupAt: SIGNUP, now })
    expect(c.kind).toBe('upgrade')
    const full = rupeesToPaise(PLANS.scale.monthlyInr - PLANS.starter.monthlyInr)
    expect(c.proratedPaise).toBeLessThan(full)
    expect(c.proratedPaise).toBe(Math.round(full * (15 / 30)))
  })

  it('takes an upgrade immediately', () => {
    const c = planChange({ tenantConfig: { plan: 'starter' }, toPlanId: 'growth', signupAt: SIGNUP, now })
    expect(c.config.plan).toBe('growth')
    expect(new Date(c.effectiveAt).getTime()).toBeCloseTo(now.getTime(), -3)
  })

  // They paid for this cycle's allowance. Taking it away the moment they click is
  // taking back something already sold — and it would let someone upgrade for a busy
  // week then downgrade before the invoice.
  it('queues a downgrade to the cycle boundary and charges nothing', () => {
    const c = planChange({ tenantConfig: { plan: 'scale' }, toPlanId: 'starter', signupAt: SIGNUP, now })
    expect(c.kind).toBe('downgrade')
    expect(c.proratedPaise).toBe(0)
    expect(c.config.plan).toBeUndefined()          // current plan untouched
    expect(c.config.pending_plan).toBe('starter')
    expect(c.effectiveAt.slice(0, 10)).toBe('2026-10-08')
  })

  it('cancels a queued downgrade when the customer upgrades instead', () => {
    const c = planChange({
      tenantConfig: { plan: 'growth', pending_plan: 'starter' }, toPlanId: 'scale', signupAt: SIGNUP, now,
    })
    expect(c.config.pending_plan).toBeNull()
    expect(c.clearsPending).toBe(true)
  })

  it('refuses a plan that does not exist', () => {
    expect(planChange({ tenantConfig: { plan: 'growth' }, toPlanId: 'enterprise', signupAt: SIGNUP, now }).ok).toBe(false)
  })

  it('refuses a move to the plan they are already on', () => {
    expect(planChange({ tenantConfig: { plan: 'growth' }, toPlanId: 'growth', signupAt: SIGNUP, now }).ok).toBe(false)
  })

  it('never prorates more than a whole cycle, however odd the clock', () => {
    const early = planChange({ tenantConfig: { plan: 'starter' }, toPlanId: 'scale', signupAt: SIGNUP, now: new Date('2026-09-08T00:00:01Z') })
    expect(early.proratedPaise).toBeLessThanOrEqual(rupeesToPaise(PLANS.scale.monthlyInr - PLANS.starter.monthlyInr))
  })

  it('charges nothing for an upgrade on the last day', () => {
    const last = prorateUpgrade({
      fromPlan: PLANS.starter, toPlan: PLANS.scale,
      cycle: billingCycle(SIGNUP, new Date('2026-10-07T23:00:00Z')),
      now: new Date('2026-10-07T23:00:00Z'),
    })
    expect(last.paise).toBeLessThan(rupeesToPaise(500))
  })
})

describe('a queued downgrade landing', () => {
  const SIGNUP = '2026-09-08T09:00:00Z'

  it('does nothing while the cycle it was queued in is still running', () => {
    expect(applyPendingPlan(
      { plan: 'scale', pending_plan: 'starter', plan_since: '2026-09-10T00:00:00Z' },
      SIGNUP, new Date('2026-09-25T00:00:00Z'))).toBeNull()
  })

  it('applies once the boundary has passed', () => {
    const applied = applyPendingPlan(
      { plan: 'scale', pending_plan: 'starter', plan_since: '2026-09-10T00:00:00Z' },
      SIGNUP, new Date('2026-10-12T00:00:00Z'))
    expect(applied.plan).toBe('starter')
    expect(applied.pending_plan).toBeNull()
  })

  it('does nothing when nothing is queued', () => {
    expect(applyPendingPlan({ plan: 'growth' }, SIGNUP, new Date())).toBeNull()
  })
})

afterEach(() => vi.unstubAllEnvs())
