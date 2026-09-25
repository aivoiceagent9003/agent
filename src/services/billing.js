// billing.js — what this tenant owes for this cycle, from calls they actually took.
//
// Read-only and derived. Nothing here writes a row, charges a card or decides whether
// to cut anyone off; it turns `calls.duration_seconds` into the numbers a customer sees
// on the billing page. Anything that eventually takes money should read from here rather
// than recompute, so the invoice and the page can never disagree.
//
// WHY THE CYCLE IS ANCHORED TO SIGNUP and not to the 1st of the month: a customer who
// starts on the 28th would otherwise get three days of allowance for a full month's fee,
// and then be told they are over. The anniversary of their signup day is what a
// subscription actually does, and it is derivable from data we already have.

import { PLANS, TRIAL_MINUTES, EXTRA_NUMBER_INR, billableMinutes, planFor, hasExplicitPlan } from '../config/plans.js'
import { prorateUpgrade, isUpgrade } from './invoices.js'

/**
 * The billing cycle containing `now`, anchored to the day of month a tenant signed up.
 *
 * Months are not all the same length, so a tenant who signed up on the 31st has no
 * anniversary in February. Clamping to the last day of the shorter month is what every
 * billing system does; the alternative is a cycle that silently skips a month.
 *
 * @param {string|Date} signupAt
 * @param {Date} [now]
 * @returns {{start: Date, end: Date, anchorDay: number, daysTotal: number, daysElapsed: number}}
 */
export function billingCycle(signupAt, now = new Date()) {
  const signup = new Date(signupAt)
  const anchorDay = Number.isFinite(signup.getTime()) ? signup.getUTCDate() : 1

  const at = (year, monthIndex) => {
    // Day 0 of the NEXT month is the last day of this one — how many days it actually has.
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
    return new Date(Date.UTC(year, monthIndex, Math.min(anchorDay, lastDay)))
  }

  let start = at(now.getUTCFullYear(), now.getUTCMonth())
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1)
  const end = at(start.getUTCFullYear(), start.getUTCMonth() + 1)

  const day = 86400000
  return {
    start,
    end,
    anchorDay,
    daysTotal: Math.round((end - start) / day),
    // Capped at the cycle length: a clock skew should not report day 32 of 30.
    daysElapsed: Math.min(Math.round((end - start) / day), Math.max(0, Math.floor((now - start) / day) + 1)),
  }
}

/** Is `now` inside the tenant's very first cycle — the one that carries the free minutes? */
export function isFirstCycle(signupAt, now = new Date()) {
  const { start } = billingCycle(signupAt, now)
  const signup = new Date(signupAt)
  if (!Number.isFinite(signup.getTime())) return false
  return start <= signup && signup < new Date(start.getTime() + 86400000 * 40)
}

/**
 * Everything the billing page shows.
 *
 * @param {object} opts
 * @param {object} opts.tenantConfig
 * @param {string|Date} opts.signupAt
 * @param {{duration_seconds:number, created_at:string}[]} opts.calls  calls in this cycle
 * @param {number} [opts.extraNumbers]  numbers beyond what the plan includes; read
 *        from tenantConfig.extra_numbers when not passed, because a caller that forgets
 *        to extract it should under-report nothing rather than silently bill zero
 * @param {Date} [opts.now]
 */
export function summariseBilling({ tenantConfig = {}, signupAt, calls = [], extraNumbers, now = new Date() }) {
  const extras = Math.max(0, Number(extraNumbers ?? tenantConfig.extra_numbers) || 0)
  const plan = planFor(tenantConfig)
  const cycle = billingCycle(signupAt, now)
  const first = isFirstCycle(signupAt, now)

  let billable = 0
  let rawSeconds = 0
  let connected = 0
  for (const c of calls) {
    const s = Number(c.duration_seconds) || 0
    if (s <= 0) continue        // never connected; there is nothing to bill
    connected++
    rawSeconds += s
    billable += billableMinutes(s)
  }
  billable = +billable.toFixed(2)

  // The free minutes sit ON TOP of the plan allowance in cycle one, which is the
  // promise made at signup: "1,000 minutes free in your first month".
  const freeMinutes = first ? TRIAL_MINUTES : 0
  const allowance = plan.includedMinutes + freeMinutes
  const overageMinutes = +Math.max(0, billable - allowance).toFixed(2)
  const overageInr = +(overageMinutes * plan.overageInrPerMin).toFixed(2)
  const numbersInr = extras * EXTRA_NUMBER_INR

  // Straight-line from usage so far. Honest only mid-cycle, which is when anyone looks.
  const pace = cycle.daysElapsed > 0 ? billable / cycle.daysElapsed : 0
  const projectedMinutes = +(pace * cycle.daysTotal).toFixed(0)
  const projectedOverage = +Math.max(0, projectedMinutes - allowance).toFixed(0)

  return {
    plan: { ...plan, assumed: !hasExplicitPlan(tenantConfig) },
    cycle: {
      start: cycle.start.toISOString(),
      end: cycle.end.toISOString(),
      daysTotal: cycle.daysTotal,
      daysElapsed: cycle.daysElapsed,
      isFirstCycle: first,
    },
    usage: {
      calls: connected,
      rawMinutes: +(rawSeconds / 60).toFixed(2),
      billableMinutes: billable,
      averageCallSeconds: connected ? Math.round(rawSeconds / connected) : 0,
      allowanceMinutes: allowance,
      freeMinutes,
      remainingMinutes: +Math.max(0, allowance - billable).toFixed(2),
      percentUsed: allowance > 0 ? Math.min(999, Math.round((billable / allowance) * 100)) : 0,
      overageMinutes,
    },
    charges: {
      monthlyInr: plan.monthlyInr,
      overageInr,
      extraNumbersInr: numbersInr,
      totalInr: +(plan.monthlyInr + overageInr + numbersInr).toFixed(2),
      overageInrPerMin: plan.overageInrPerMin,
    },
    projection: {
      minutes: projectedMinutes,
      overageMinutes: projectedOverage,
      totalInr: +(plan.monthlyInr + projectedOverage * plan.overageInrPerMin + numbersInr).toFixed(2),
    },
  }
}

export { PLANS }

/**
 * What happens if this tenant moves to `toPlanId` right now.
 *
 * Pure: it decides, it does not write. The caller persists the result, which keeps the
 * rule in one testable place instead of spread across a route handler.
 *
 * UPGRADES take effect immediately and are charged pro rata for the days left in the
 * cycle — the customer wants the bigger allowance today, and they have already paid for
 * this month at the old rate, so only the difference is due.
 *
 * DOWNGRADES are QUEUED to the next cycle boundary and charged nothing. They paid for
 * this cycle's allowance; taking it away the moment they click is taking back something
 * already sold. It also removes the obvious abuse — upgrade for a heavy week, downgrade
 * before the bill — because the downgrade never lands early.
 *
 * @param {object} opts
 * @param {object} opts.tenantConfig
 * @param {string} opts.toPlanId
 * @param {string|Date} opts.signupAt
 * @param {Date} [opts.now]
 */
export function planChange({ tenantConfig = {}, toPlanId, signupAt, now = new Date() }) {
  const target = PLANS[String(toPlanId || '').trim().toLowerCase()]
  if (!target) return { ok: false, reason: 'unknown_plan' }

  const current = planFor(tenantConfig)
  if (current.id === target.id && !tenantConfig.pending_plan) {
    return { ok: false, reason: 'already_on_plan' }
  }

  const cycle = billingCycle(signupAt, now)
  const up = isUpgrade(current.id, target.id)

  if (up) {
    const pro = prorateUpgrade({ fromPlan: current, toPlan: target, cycle, now })
    return {
      ok: true,
      kind: 'upgrade',
      from: current,
      to: target,
      effectiveAt: now.toISOString(),
      proratedPaise: pro.paise,
      daysRemaining: pro.daysRemaining,
      // A queued downgrade is cancelled by upgrading — the customer has changed their
      // mind, and leaving it armed would silently undo the upgrade at the boundary.
      clearsPending: !!tenantConfig.pending_plan,
      config: { plan: target.id, plan_since: now.toISOString(), pending_plan: null },
    }
  }

  return {
    ok: true,
    kind: 'downgrade',
    from: current,
    to: target,
    effectiveAt: cycle.end.toISOString(),
    proratedPaise: 0,
    daysRemaining: Math.ceil((cycle.end - now) / 86400000),
    clearsPending: false,
    // The plan itself is untouched until the boundary; only the intent is stored.
    config: { pending_plan: target.id },
  }
}

/**
 * Apply a queued downgrade if its moment has arrived.
 *
 * Called when a cycle is read, not by a scheduler, so it cannot be missed by a job that
 * did not run. Returns null when there is nothing to do.
 */
export function applyPendingPlan(tenantConfig = {}, signupAt, now = new Date()) {
  const pending = PLANS[String(tenantConfig.pending_plan || '').trim().toLowerCase()]
  if (!pending) return null
  const since = tenantConfig.plan_since ? new Date(tenantConfig.plan_since) : null
  const cycle = billingCycle(signupAt, now)
  // The boundary has passed when the CURRENT cycle began after the plan was last set.
  if (since && cycle.start <= since) return null
  return { plan: pending.id, plan_since: cycle.start.toISOString(), pending_plan: null }
}
