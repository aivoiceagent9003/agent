// The outbound compliance gate: when a campaign may legally dial someone.
//
// Getting this wrong is not a bug report, it is a regulatory one — calls placed at
// 3am, or on a date the tenant declared off-limits. All the time arithmetic runs
// through Intl in an explicit timezone rather than the server's local clock, which
// is the part most worth pinning: the same code has to behave identically on a
// laptop in Hyderabad and a container running UTC.

import { describe, it, expect } from 'vitest'
import {
  withinWorkingHours,
  isBlackoutDate,
  filterContacts,
} from '../src/services/campaigns/compliance.js'

// A precise instant, expressed in IST, as a UTC Date. IST is UTC+5:30.
const ist = (dateStr, hour, minute = 0) => new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`)

describe('withinWorkingHours', () => {
  // 2026-08-26 is a Wednesday (day 3).
  const weekdays = { working_hours: { start: 9, end: 21, days: [1, 2, 3, 4, 5] } }

  it('allows a time inside the window', () => {
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-26', 11))).toBe(true)
  })

  it('blocks before opening', () => {
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-26', 8, 59))).toBe(false)
  })

  it('includes the opening hour and excludes the closing hour', () => {
    // end is exclusive: 21 means "until 21:00", so 21:00 itself is out.
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-26', 9))).toBe(true)
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-26', 20, 59))).toBe(true)
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-26', 21))).toBe(false)
  })

  it('blocks a day not in the allowed list', () => {
    // 2026-08-30 is a Sunday (day 0), absent from [1..5].
    expect(withinWorkingHours(weekdays, {}, ist('2026-08-30', 11))).toBe(false)
  })

  it('allows any day when no day list is given', () => {
    const anyDay = { working_hours: { start: 9, end: 21 } }
    expect(withinWorkingHours(anyDay, {}, ist('2026-08-30', 11))).toBe(true)
  })

  it('defaults to permitting the call when no hours are configured', () => {
    // A tenant who never set hours should not have every campaign silently blocked.
    expect(withinWorkingHours({}, {}, ist('2026-08-26', 3))).toBe(true)
  })

  it('judges the hour in the configured timezone, not the server clock', () => {
    // 2026-08-26T02:00Z is 07:30 IST — before a 09:00 opening. The same instant is
    // well inside working hours in UTC. Reading the server's local clock instead of
    // the tenant's timezone is exactly how 3am calls get placed.
    const at0200Z = new Date('2026-08-26T02:00:00Z')
    expect(withinWorkingHours(weekdays, { timezone: 'Asia/Kolkata' }, at0200Z)).toBe(false)
    expect(withinWorkingHours(weekdays, { timezone: 'UTC' }, at0200Z)).toBe(false)
    const at0700Z = new Date('2026-08-26T07:00:00Z') // 12:30 IST, 07:00 UTC
    expect(withinWorkingHours(weekdays, { timezone: 'Asia/Kolkata' }, at0700Z)).toBe(true)
    expect(withinWorkingHours(weekdays, { timezone: 'UTC' }, at0700Z)).toBe(false)
  })

  it('defaults to Asia/Kolkata when no timezone is given', () => {
    const at0200Z = new Date('2026-08-26T02:00:00Z') // 07:30 IST
    expect(withinWorkingHours(weekdays, {}, at0200Z)).toBe(false)
  })

  it('handles a timezone that observes DST correctly on both sides', () => {
    // America/New_York is UTC-4 in August (EDT) and UTC-5 in January (EST). The
    // same 13:00Z is 09:00 local in summer and 08:00 local in winter, so a 09:00
    // opening includes one and excludes the other. Hard-coding an offset — or
    // testing only in one season — hides this entirely.
    const hours = { working_hours: { start: 9, end: 17 } }
    const tz = { timezone: 'America/New_York' }
    expect(withinWorkingHours(hours, tz, new Date('2026-08-26T13:00:00Z'))).toBe(true)
    expect(withinWorkingHours(hours, tz, new Date('2026-01-26T13:00:00Z'))).toBe(false)
    expect(withinWorkingHours(hours, tz, new Date('2026-01-26T14:00:00Z'))).toBe(true)
  })

  it('reads hours from the schedule when compliance does not carry them', () => {
    const viaSchedule = { business_hours: { start: 10, end: 18 } }
    expect(withinWorkingHours({}, { ...viaSchedule, timezone: 'Asia/Kolkata' }, ist('2026-08-26', 11))).toBe(true)
    expect(withinWorkingHours({}, { ...viaSchedule, timezone: 'Asia/Kolkata' }, ist('2026-08-26', 9))).toBe(false)
  })
})

describe('isBlackoutDate', () => {
  it('is false when none are configured', () => {
    expect(isBlackoutDate({}, new Date('2026-08-26T06:00:00Z'))).toBe(false)
    expect(isBlackoutDate({ blackout_dates: [] }, new Date('2026-08-26T06:00:00Z'))).toBe(false)
  })

  it('matches a listed date', () => {
    const s = { blackout_dates: ['2026-08-26', '2026-10-02'] }
    expect(isBlackoutDate(s, new Date('2026-08-26T06:00:00Z'))).toBe(true)
    expect(isBlackoutDate(s, new Date('2026-10-02T06:00:00Z'))).toBe(true)
  })

  it('does not match a neighbouring date', () => {
    const s = { blackout_dates: ['2026-08-26'] }
    expect(isBlackoutDate(s, new Date('2026-08-25T06:00:00Z'))).toBe(false)
    expect(isBlackoutDate(s, new Date('2026-08-27T06:00:00Z'))).toBe(false)
  })

  it('compares in UTC, so a late-evening IST instant can fall on the next date', () => {
    // Documented rather than asserted as desirable: blackout dates are compared
    // against the UTC date, while working hours are compared in the tenant's
    // timezone. 2026-08-26 23:30 IST is already 2026-08-26 18:00Z, same date; but
    // 2026-08-27 04:00 IST is 2026-08-26 22:30Z — still the 26th in UTC.
    const s = { blackout_dates: ['2026-08-26'] }
    expect(isBlackoutDate(s, ist('2026-08-27', 4))).toBe(true)
  })
})

describe('filterContacts', () => {
  // respect_dnd:false keeps the suppression lookup out of the database, so these
  // exercise attempt caps and time windows in isolation. Suppression itself is
  // covered against a real row elsewhere.
  const open = { respect_dnd: false, working_hours: { start: 0, end: 24 } }

  it('allows contacts under the attempt cap and blocks those at it', async () => {
    const contacts = [
      { id: 'a', phone: '+919000000001', attempts: 0 },
      { id: 'b', phone: '+919000000002', attempts: 4 },
      { id: 'c', phone: '+919000000003', attempts: 5 },
      { id: 'd', phone: '+919000000004', attempts: 9 },
    ]
    const { allowed, blocked } = await filterContacts('t1', contacts, { compliance: open, maxAttempts: 5 })
    expect(allowed.map((c) => c.id)).toEqual(['a', 'b'])
    expect(blocked).toEqual([
      { id: 'c', reason: 'max_attempts' },
      { id: 'd', reason: 'max_attempts' },
    ])
  })

  it('treats a missing attempts field as zero', async () => {
    const { allowed } = await filterContacts('t1', [{ id: 'a', phone: '+919000000001' }], { compliance: open })
    expect(allowed).toHaveLength(1)
  })

  it('blocks everything outside working hours and says why', async () => {
    const shut = { respect_dnd: false, working_hours: { start: 9, end: 10 }, timezone: 'Asia/Kolkata' }
    const contacts = [{ id: 'a', phone: '+919000000001', attempts: 0 }]
    const { allowed, blocked, timeOk } = await filterContacts('t1', contacts, {
      compliance: shut,
      schedule: { timezone: 'Asia/Kolkata' },
    })
    // 09:00-10:00 IST is a one-hour window; outside it everything is blocked.
    if (!timeOk) {
      expect(allowed).toHaveLength(0)
      expect(blocked).toEqual([{ id: 'a', reason: 'outside_hours' }])
    } else {
      expect(allowed).toHaveLength(1)
    }
  })

  it('reports the attempt cap ahead of the time window', async () => {
    // Ordering matters for the reason a client is shown: "they have been called
    // five times" is more actionable than "it is currently out of hours".
    const shut = { respect_dnd: false, working_hours: { start: 9, end: 9 } }
    const { blocked } = await filterContacts('t1', [{ id: 'a', phone: '+91900', attempts: 99 }], {
      compliance: shut,
      maxAttempts: 5,
    })
    expect(blocked).toEqual([{ id: 'a', reason: 'max_attempts' }])
  })

  it('returns empty lists for an empty batch', async () => {
    const { allowed, blocked } = await filterContacts('t1', [], { compliance: open })
    expect(allowed).toEqual([])
    expect(blocked).toEqual([])
  })
})
