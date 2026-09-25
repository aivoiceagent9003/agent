// What a customer is charged, and every way that arithmetic goes quietly wrong.
//
// Billing defects do not throw. They produce a number that looks like a number, and
// nobody finds out until an invoice is disputed — by which point the same bug has been
// applied to every customer for a month. So the cases here are the ones where a
// plausible implementation and a correct one differ: month lengths, signup on the 31st,
// the free minutes in cycle one, and how a 4-second call is rounded.
import { describe, expect, it } from 'vitest'
import { billingCycle, isFirstCycle, summariseBilling } from '../src/services/billing.js'
import { PLANS, billableMinutes, planFor } from '../src/config/plans.js'

const call = (seconds, at = '2026-09-10T10:00:00Z') => ({ duration_seconds: seconds, created_at: at })
const SIGNUP = '2026-09-08T09:00:00Z'

describe('the billing cycle', () => {
  it('runs from the signup anniversary, not the 1st of the month', () => {
    const c = billingCycle(SIGNUP, new Date('2026-09-23T12:00:00Z'))
    expect(c.start.toISOString().slice(0, 10)).toBe('2026-09-08')
    expect(c.end.toISOString().slice(0, 10)).toBe('2026-10-08')
  })

  it('puts a date before the anniversary in the PREVIOUS cycle', () => {
    const c = billingCycle(SIGNUP, new Date('2026-10-03T12:00:00Z'))
    expect(c.start.toISOString().slice(0, 10)).toBe('2026-09-08')
    expect(c.end.toISOString().slice(0, 10)).toBe('2026-10-08')
  })

  // A tenant who signed up on the 31st has no anniversary in a 30-day month, and in
  // February has none for three days running. Clamping to the last day is what billing
  // systems do; the naive version rolls into the next month and skips a cycle entirely.
  it('clamps to the last day of a shorter month', () => {
    // Mid-February is still inside the cycle that opened on 31 January...
    const jan = billingCycle('2026-01-31T00:00:00Z', new Date('2026-02-15T00:00:00Z'))
    expect(jan.start.toISOString().slice(0, 10)).toBe('2026-01-31')
    expect(jan.end.toISOString().slice(0, 10)).toBe('2026-02-28')
    // ...and the NEXT one opens on the 28th, because February has no 31st. Rolling
    // forward to 3 March instead would skip a cycle and give the month away.
    const feb = billingCycle('2026-01-31T00:00:00Z', new Date('2026-03-02T00:00:00Z'))
    expect(feb.start.toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(feb.end.toISOString().slice(0, 10)).toBe('2026-03-31')
  })

  it('counts the real length of the month, not 30 days', () => {
    expect(billingCycle('2026-01-05T00:00:00Z', new Date('2026-01-20T00:00:00Z')).daysTotal).toBe(31)
    expect(billingCycle('2026-04-05T00:00:00Z', new Date('2026-04-20T00:00:00Z')).daysTotal).toBe(30)
  })

  it('never reports a day past the end of the cycle', () => {
    const c = billingCycle(SIGNUP, new Date('2026-10-07T23:59:00Z'))
    expect(c.daysElapsed).toBeLessThanOrEqual(c.daysTotal)
  })

  it('knows the first cycle from every later one', () => {
    expect(isFirstCycle(SIGNUP, new Date('2026-09-23T00:00:00Z'))).toBe(true)
    expect(isFirstCycle(SIGNUP, new Date('2026-11-20T00:00:00Z'))).toBe(false)
  })
})

describe('turning seconds into billable minutes', () => {
  // Measured on 58 real calls: rounding each call up to a full minute inflates billable
  // time by 19.8%, because 17% of calls are under a minute. That turns an advertised
  // ₹4.50 into ₹5.39 actually charged. Six seconds costs 1.7% and keeps the rate honest.
  it.each([
    [0, 0],
    [1, 0.1],
    [6, 0.1],
    [7, 0.2],
    [60, 1],
    [61, 1.1],
    [144, 2.4],
  ])('bills %ss as %s min', (seconds, expected) => {
    expect(billableMinutes(seconds)).toBeCloseTo(expected, 2)
  })

  it('bills nothing for a call that never connected', () => {
    expect(billableMinutes(0)).toBe(0)
    expect(billableMinutes(null)).toBe(0)
    expect(billableMinutes(-5)).toBe(0)
  })

  it('always rounds up, never down', () => {
    // Compared with a tolerance because minutes are fractional: 246s bills as exactly
    // 4.1 minutes, and 4.1 * 60 is 245.99999999999997 in binary floating point.
    for (let s = 1; s <= 300; s++) expect(billableMinutes(s) * 60).toBeGreaterThanOrEqual(s - 1e-9)
  })
})

describe('what the customer owes', () => {
  const summarise = (over = {}) => summariseBilling({
    tenantConfig: { plan: 'growth' },
    signupAt: SIGNUP,
    now: new Date('2026-09-23T12:00:00Z'),
    calls: [],
    ...over,
  })

  it('adds the free minutes to the plan allowance in the first cycle only', () => {
    expect(summarise().usage.allowanceMinutes).toBe(3500)   // 2500 plan + 1000 free
    const later = summariseBilling({
      tenantConfig: { plan: 'growth' }, signupAt: SIGNUP, calls: [],
      now: new Date('2026-12-15T12:00:00Z'),
    })
    expect(later.usage.allowanceMinutes).toBe(2500)
    expect(later.usage.freeMinutes).toBe(0)
  })

  it('charges nothing extra while inside the allowance', () => {
    const s = summarise({ calls: [call(600), call(600)] })
    expect(s.usage.overageMinutes).toBe(0)
    expect(s.charges.totalInr).toBe(PLANS.growth.monthlyInr)
  })

  it('charges the plan rate for every minute past it', () => {
    // 3,600 minutes of calls against a 3,500 allowance = 100 over, at ₹4.50.
    const calls = Array.from({ length: 60 }, () => call(3600))
    const s = summarise({ calls })
    expect(s.usage.billableMinutes).toBe(3600)
    expect(s.usage.overageMinutes).toBe(100)
    expect(s.charges.overageInr).toBeCloseTo(450, 2)
    expect(s.charges.totalInr).toBeCloseTo(11999 + 450, 2)
  })

  it('ignores calls that never connected', () => {
    const s = summarise({ calls: [call(0), call(0), call(120)] })
    expect(s.usage.calls).toBe(1)
    expect(s.usage.billableMinutes).toBe(2)
  })

  it('never reports negative minutes remaining', () => {
    const s = summarise({ calls: Array.from({ length: 100 }, () => call(3600)) })
    expect(s.usage.remainingMinutes).toBe(0)
  })

  it('prices overage at the plan rate, which falls as the plan grows', () => {
    const over = Array.from({ length: 70 }, () => call(3600))   // 4,200 min
    const rate = (plan) => summariseBilling({
      tenantConfig: { plan }, signupAt: SIGNUP, calls: over, now: new Date('2026-09-23T12:00:00Z'),
    }).charges.overageInrPerMin
    expect(rate('starter')).toBe(4.75)
    expect(rate('growth')).toBe(4.50)
    expect(rate('scale')).toBe(4.25)
  })

  it('bills extra numbers on top', () => {
    const s = summariseBilling({
      tenantConfig: { plan: 'growth', extra_numbers: 2 },
      signupAt: SIGNUP, calls: [], now: new Date('2026-09-23T12:00:00Z'),
    })
    expect(s.charges.extraNumbersInr).toBe(798)
    expect(s.charges.totalInr).toBe(11999 + 798)
  })

  // A tenant with no plan set must still get a page. Silently showing Starter is the
  // safe direction to be wrong in, but it has to be visible or nobody notices the
  // tenant was never put on a plan.
  it('falls back to Starter and says so', () => {
    const s = summariseBilling({ tenantConfig: {}, signupAt: SIGNUP, calls: [], now: new Date('2026-09-23T12:00:00Z') })
    expect(s.plan.id).toBe('starter')
    expect(s.plan.assumed).toBe(true)
    expect(summarise().plan.assumed).toBe(false)
  })

  it('projects from the pace so far, and does not project a negative overage', () => {
    const s = summarise({ calls: [call(600)] })
    expect(s.projection.minutes).toBeGreaterThan(0)
    expect(s.projection.overageMinutes).toBe(0)
    expect(s.projection.totalInr).toBe(PLANS.growth.monthlyInr)
  })
})

describe('the plan ladder', () => {
  it('makes the middle plan the worse deal per minute', () => {
    const per = (p) => PLANS[p].monthlyInr / PLANS[p].includedMinutes
    expect(per('starter')).toBeGreaterThan(per('growth'))
    expect(per('growth')).toBeGreaterThan(per('scale'))
  })

  // The whole point of three plans: the last step has to look like the bargain.
  it('prices the step up to Scale below the step up to Growth', () => {
    const step = (a, b) =>
      (PLANS[b].monthlyInr - PLANS[a].monthlyInr) / (PLANS[b].includedMinutes - PLANS[a].includedMinutes)
    expect(step('growth', 'scale')).toBeLessThan(step('starter', 'growth'))
  })

  it('drops the overage rate as the plan grows', () => {
    expect(PLANS.starter.overageInrPerMin).toBeGreaterThan(PLANS.growth.overageInrPerMin)
    expect(PLANS.growth.overageInrPerMin).toBeGreaterThan(PLANS.scale.overageInrPerMin)
  })

  // Measured COGS is ₹2.12/min. An overage rate below that sells minutes at a loss.
  it('keeps every overage rate above what a minute costs to serve', () => {
    for (const p of Object.values(PLANS)) expect(p.overageInrPerMin).toBeGreaterThan(2.12)
  })

  it('resolves a plan id case-insensitively and ignores stray whitespace', () => {
    expect(planFor({ plan: ' GROWTH ' }).id).toBe('growth')
  })
})
