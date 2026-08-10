// services/campaigns/compliance.js — outbound compliance gate.
//
// Enforced BEFORE a contact is enqueued (and re-checkable pre-dial):
//   • suppression list  (DND / opt-out / blacklist) per tenant
//   • working hours + timezone (don't call outside allowed local hours)
//   • blackout dates
//   • frequency cap (max attempts per contact — enforced via attempts column)
// Returns which contacts may be dialed now vs blocked, with reasons.

import { supabase } from '../../api/db.js'

// Is `now` within the campaign's allowed calling window (tenant/campaign timezone)?
export function withinWorkingHours(compliance = {}, schedule = {}, now = new Date()) {
  const tz = schedule.timezone || compliance.timezone || 'Asia/Kolkata'
  const hours = compliance.working_hours || schedule.business_hours   // { start: 9, end: 21, days: [1..5] }
  if (!hours) return true
  // Resolve local hour/day in the target timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const wd = parts.find(p => p.type === 'weekday')?.value
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const day = dayMap[wd] ?? new Date().getDay()
  if (Array.isArray(hours.days) && hours.days.length && !hours.days.includes(day)) return false
  const start = hours.start ?? 9, end = hours.end ?? 21
  return hour >= start && hour < end
}

export function isBlackoutDate(schedule = {}, now = new Date()) {
  const dates = schedule.blackout_dates
  if (!Array.isArray(dates) || !dates.length) return false
  const today = now.toISOString().slice(0, 10)
  return dates.includes(today)
}

// Load the tenant's suppression set (E.164 phones).
export async function loadSuppression(tenantId) {
  const { data } = await supabase.from('suppression_list').select('phone').eq('tenant_id', tenantId)
  return new Set((data || []).map(r => r.phone))
}

// Filter a batch of contacts. `contacts` = rows from campaign_contacts.
export async function filterContacts(tenantId, contacts, { compliance = {}, schedule = {}, maxAttempts = 5 } = {}) {
  const suppressed = compliance.respect_dnd === false ? new Set() : await loadSuppression(tenantId)
  const timeOk = withinWorkingHours(compliance, schedule) && !isBlackoutDate(schedule)

  const allowed = [], blocked = []
  for (const c of contacts) {
    if (suppressed.has(c.phone)) { blocked.push({ id: c.id, reason: 'suppressed' }); continue }
    if ((c.attempts || 0) >= maxAttempts) { blocked.push({ id: c.id, reason: 'max_attempts' }); continue }
    if (!timeOk) { blocked.push({ id: c.id, reason: 'outside_hours' }); continue }
    allowed.push(c)
  }
  return { allowed, blocked, timeOk }
}

// Single-contact pre-dial check (used by the worker just before originate).
export async function canDial(tenantId, contact, campaign) {
  if (campaign?.compliance?.respect_dnd !== false) {
    const { data } = await supabase.from('suppression_list')
      .select('phone').eq('tenant_id', tenantId).eq('phone', contact.phone).maybeSingle()
    if (data) return { ok: false, reason: 'suppressed' }
  }
  if (!withinWorkingHours(campaign?.compliance || {}, campaign?.schedule || {})) return { ok: false, reason: 'outside_hours' }
  if (isBlackoutDate(campaign?.schedule || {})) return { ok: false, reason: 'blackout' }
  return { ok: true }
}
