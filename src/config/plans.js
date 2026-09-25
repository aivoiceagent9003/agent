// config/plans.js — what a tenant is on, and what their minutes cost.
//
// The catalogue lives here rather than in the database because a plan is a product
// decision, not tenant data: every tenant on "growth" must get the same allowance, and
// a per-tenant copy is how two customers end up on quietly different terms. What the
// DATABASE holds is which plan id a tenant is on (`config.plan`), and nothing else.
//
// Priced off measured unit economics, not a guess. From this repo's own cost lines,
// a call costs roughly:
//
//   AI (Soniox STT + LLM + Soniox TTS)   ~ Rs 1.47 / min   (calls over 2 min)
//     ⚠️ measured on the previous voice stack. Sarvam STT + Telnyx TTS cost more
//     (Telnyx alone was ~Rs 0.9/min above Soniox on the same call) — re-measure.
//   carrier (Plivo Zentrunk, India)      ~ Rs 0.25 / min
//   AWS + Supabase, amortised at launch  ~ Rs 0.40 / min
//   ----------------------------------------------------
//   fully loaded                         ~ Rs 2.12 / min
//
// plus Rs 200 per Indian number per month, which is fixed per tenant rather than
// per call and so is counted in the plan maths and not in a call's cost line.
//
// THE LADDER IS DELIBERATE. Starter is the worst per-minute deal on purpose; it exists
// to make Growth look reasonable and to price out tyre-kickers. Growth to Scale is
// Rs 2,000 for 1,000 more minutes — Rs 2.00 a minute at the margin against Rs 4.67
// from Starter to Growth — so Scale reads as the obvious pick. That asymmetry is the
// whole point of having three.

/** @typedef {{id:string,name:string,setupInr:number,monthlyInr:number,includedMinutes:number,overageInrPerMin:number,includedNumbers:number,blurb:string}} Plan */

/** @type {Record<string, Plan>} */
export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    setupInr: 9999,
    monthlyInr: 4999,
    includedMinutes: 1000,
    overageInrPerMin: 4.75,
    includedNumbers: 1,
    blurb: 'One agent, one number. For a single line that should never ring out.',
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    setupInr: 7499,
    monthlyInr: 11999,
    includedMinutes: 2500,
    overageInrPerMin: 4.50,
    includedNumbers: 1,
    blurb: 'For a team already taking more calls than it can answer.',
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    setupInr: 4999,
    monthlyInr: 13999,
    includedMinutes: 3500,
    overageInrPerMin: 4.25,
    includedNumbers: 2,
    blurb: 'Outbound campaigns and inbound on the same agent, two numbers included.',
  },
}

export const PLAN_ORDER = ['starter', 'growth', 'scale']

/** Minutes given away in a tenant's FIRST billing cycle, on every plan. */
export const TRIAL_MINUTES = 1000

/** What an extra number costs the customer. It costs us Rs 200. */
export const EXTRA_NUMBER_INR = 399

/**
 * How a call's seconds become billable minutes.
 *
 * SIX SECONDS, not a whole minute. Measured against 58 real calls on this account:
 * rounding each call up to the next full minute inflates billable time by 19.8%,
 * because 17% of calls are under a minute — wrong numbers, hang-ups, and people who
 * got their answer in one turn. That turns an advertised Rs 4.50 into Rs 5.39 actually
 * charged, which a customer notices on their second invoice and does not forgive.
 * Six-second increments add 1.7% and the advertised rate stays true.
 *
 * Set BILLING_INCREMENT_SECONDS=60 to bill whole minutes instead.
 */
export const BILLING_INCREMENT_SECONDS = Number(process.env.BILLING_INCREMENT_SECONDS) || 6

/**
 * Billable minutes for one call, rounded UP to the increment.
 * @param {number} seconds
 */
export function billableMinutes(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return 0
  const inc = BILLING_INCREMENT_SECONDS
  return (Math.ceil(s / inc) * inc) / 60
}

/**
 * The plan a tenant is on. An unrecognised or missing id falls back to Starter rather
 * than throwing — a billing page that will not render is worse than one showing the
 * smallest plan, and the fallback is visible in the response so it can be spotted.
 * @param {object} tenantConfig
 */
export function planFor(tenantConfig = {}) {
  const id = String(tenantConfig.plan || '').trim().toLowerCase()
  return PLANS[id] || PLANS.starter
}

/** Is this tenant on a real plan, or defaulted into one? */
export function hasExplicitPlan(tenantConfig = {}) {
  return !!PLANS[String(tenantConfig.plan || '').trim().toLowerCase()]
}
