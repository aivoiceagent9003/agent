// invoices.js — turning a closed billing cycle into a document somebody pays.
//
// MONEY IS IN PAISE, as integers, everywhere in this file. Rupees as floats put
// 1234.5600000000001 on an invoice, and a one-paisa difference between what was shown,
// what was charged and what was filed is a reconciliation problem that takes longer to
// explain than it did to create. Convert at the edges, never in the middle.
//
// GST IS NOT DECORATION. An Indian tax invoice needs a place of supply and the right
// split: same state as us means CGST + SGST, anywhere else means IGST, and the total is
// identical either way. Getting the split wrong does not change what the customer pays;
// it makes the return wrong, which is the department's problem with you rather than
// theirs with the invoice.

import { PLANS, planFor } from '../config/plans.js'

/** 18% on SaaS. Held as basis points so the halves divide exactly. */
export const GST_BASIS_POINTS = Number(process.env.GST_BASIS_POINTS) || 1800

/**
 * Our own GST state code — the place of supply is compared against it.
 *
 * There is no sensible default: guessing puts the wrong split on every invoice, and it
 * is wrong silently. Unset means "we cannot issue a tax invoice yet", which is the
 * honest state for a company that has not told the software where it is registered.
 */
export const SUPPLIER_STATE_CODE = String(process.env.COMPANY_GST_STATE_CODE || '').trim()

export const rupeesToPaise = (r) => Math.round(Number(r || 0) * 100)
export const paiseToRupees = (p) => +(Number(p || 0) / 100).toFixed(2)

/**
 * The Indian financial year a date falls in: April to March.
 * 15 Jan 2027 is FY 2026-27, which prints as "2627".
 */
export function financialYear(date = new Date()) {
  const d = new Date(date)
  const y = d.getUTCFullYear()
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1   // month 3 = April
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`
}

/**
 * Invoice numbers must be unique and unbroken within a financial year for GST, and
 * they are read aloud over the phone, so they are formatted rather than a UUID.
 * @param {number} sequence 1-based, within the financial year
 */
export function invoiceNumber(sequence, date = new Date(), prefix = process.env.INVOICE_PREFIX || 'AL') {
  return `${prefix}-${financialYear(date)}-${String(sequence).padStart(4, '0')}`
}

/**
 * Split a subtotal into its tax components.
 *
 * The halves are derived from the TOTAL tax rather than computed separately, so
 * CGST + SGST always equals what IGST would have been. Rounding each half
 * independently loses a paisa on odd amounts and the invoice stops adding up.
 *
 * @param {number} subtotalPaise
 * @param {string} customerStateCode
 * @returns {{cgst:number, sgst:number, igst:number, tax:number, total:number, intraState:boolean|null}}
 */
export function splitGst(subtotalPaise, customerStateCode) {
  const sub = Math.max(0, Math.round(Number(subtotalPaise) || 0))
  const tax = Math.round((sub * GST_BASIS_POINTS) / 10000)
  const customer = String(customerStateCode || '').trim()

  // Without both codes we cannot say where the supply happened. Charging the tax but
  // splitting it arbitrarily would file it wrong, so the caller is told instead.
  if (!SUPPLIER_STATE_CODE || !customer) {
    return { cgst: 0, sgst: 0, igst: 0, tax: 0, total: sub, intraState: null }
  }

  if (customer === SUPPLIER_STATE_CODE) {
    const cgst = Math.floor(tax / 2)
    return { cgst, sgst: tax - cgst, igst: 0, tax, total: sub + tax, intraState: true }
  }
  return { cgst: 0, sgst: 0, igst: tax, tax, total: sub + tax, intraState: false }
}

/**
 * The line items for one cycle. Subscription first, then what was used on top of it —
 * which is the order a reader checks them in.
 *
 * @param {object} opts
 * @param {object} opts.plan
 * @param {number} opts.overageMinutes
 * @param {number} opts.extraNumbers
 * @param {number} [opts.proratedPaise]  a mid-cycle upgrade already charged
 */
export function buildLineItems({ plan, overageMinutes = 0, extraNumbers = 0, proratedPaise = 0, extraNumberInr = 399 }) {
  const items = [{
    description: `${plan.name} plan — ${plan.includedMinutes.toLocaleString('en-IN')} minutes included`,
    quantity: 1,
    unitPaise: rupeesToPaise(plan.monthlyInr),
    amountPaise: rupeesToPaise(plan.monthlyInr),
  }]

  if (overageMinutes > 0) {
    const amount = Math.round(rupeesToPaise(plan.overageInrPerMin) * overageMinutes)
    items.push({
      description: `Additional minutes — ${overageMinutes.toLocaleString('en-IN', { maximumFractionDigits: 1 })} min @ ₹${plan.overageInrPerMin}/min`,
      quantity: +overageMinutes.toFixed(2),
      unitPaise: rupeesToPaise(plan.overageInrPerMin),
      amountPaise: amount,
    })
  }

  if (extraNumbers > 0) {
    items.push({
      description: `Additional phone numbers × ${extraNumbers}`,
      quantity: extraNumbers,
      unitPaise: rupeesToPaise(extraNumberInr),
      amountPaise: rupeesToPaise(extraNumberInr) * extraNumbers,
    })
  }

  // A mid-cycle upgrade was charged when it happened; it appears here so the invoice
  // accounts for every rupee, and negative so the customer is not billed twice.
  if (proratedPaise > 0) {
    items.push({
      description: 'Less: upgrade already charged this cycle',
      quantity: 1,
      unitPaise: -proratedPaise,
      amountPaise: -proratedPaise,
    })
  }

  return items
}

/**
 * Everything an invoice row needs, ready to insert. Does not touch the database —
 * the caller owns the transaction and the sequence number.
 */
export function buildInvoice({ tenantId, number, plan, cycle, overageMinutes = 0, extraNumbers = 0, proratedPaise = 0, profile = {}, dueDays = 7, now = new Date() }) {
  const items = buildLineItems({ plan, overageMinutes, extraNumbers, proratedPaise })
  const subtotal = items.reduce((a, i) => a + i.amountPaise, 0)
  const gst = splitGst(subtotal, profile.state_code)

  return {
    tenant_id: tenantId,
    number,
    status: 'open',
    period_start: new Date(cycle.start).toISOString(),
    period_end: new Date(cycle.end).toISOString(),
    plan_id: plan.id,
    plan_name: plan.name,
    line_items: items,
    subtotal_paise: subtotal,
    cgst_paise: gst.cgst,
    sgst_paise: gst.sgst,
    igst_paise: gst.igst,
    total_paise: gst.total,
    // Frozen. The customer's address changing next month must not rewrite an invoice
    // they have already been sent.
    bill_to: {
      legal_name: profile.legal_name || null,
      gstin: profile.gstin || null,
      address_line1: profile.address_line1 || null,
      address_line2: profile.address_line2 || null,
      city: profile.city || null,
      state: profile.state || null,
      pincode: profile.pincode || null,
      billing_email: profile.billing_email || null,
    },
    place_of_supply: profile.state_code || null,
    issued_at: now.toISOString(),
    due_at: new Date(now.getTime() + dueDays * 86400000).toISOString(),
  }
}

/**
 * What an upgrade costs right now.
 *
 * Only the DIFFERENCE, and only for the days left in the cycle — the customer already
 * paid for this month at the old rate. Charging the full new price mid-cycle bills them
 * twice for the same days, which is the single most common proration bug.
 *
 * Downgrades return 0 and are not charged: they take effect at the next boundary, so
 * there is nothing to settle now (see queueDowngrade in billing.js).
 *
 * @returns {{paise:number, daysRemaining:number, isUpgrade:boolean}}
 */
export function prorateUpgrade({ fromPlan, toPlan, cycle, now = new Date() }) {
  const end = new Date(cycle.end)
  const msLeft = Math.max(0, end - now)
  const daysRemaining = Math.ceil(msLeft / 86400000)
  const daysTotal = cycle.daysTotal || 30

  const diff = rupeesToPaise(toPlan.monthlyInr) - rupeesToPaise(fromPlan.monthlyInr)
  if (diff <= 0) return { paise: 0, daysRemaining, isUpgrade: false }

  return {
    paise: Math.round(diff * (Math.min(daysRemaining, daysTotal) / daysTotal)),
    daysRemaining,
    isUpgrade: true,
  }
}

/** Is `to` a bigger plan than `from`? Ordered by what they cost, not by name. */
export function isUpgrade(fromPlanId, toPlanId) {
  const a = PLANS[fromPlanId] || planFor({})
  const b = PLANS[toPlanId]
  if (!b) return false
  return b.monthlyInr > a.monthlyInr
}

/** Can we legally issue a tax invoice yet? */
export function invoicingReady(profile = {}) {
  const missing = []
  if (!SUPPLIER_STATE_CODE) missing.push('COMPANY_GST_STATE_CODE (our own registration state)')
  if (!profile.legal_name) missing.push('legal name')
  if (!profile.state_code) missing.push('state')
  if (!profile.billing_email) missing.push('billing email')
  return { ready: missing.length === 0, missing }
}
