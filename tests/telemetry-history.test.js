// Reading call history back out of the database.
//
// Every completed trace has always been WRITTEN to call_traces. Nothing read it
// back: both accessors served only the in-memory ring, which is process-local and
// empty after a restart. The Operations Center therefore showed only the calls
// placed since the last boot, so every average was computed over one or two
// samples while months of history sat unused in Postgres.
//
// These tests pin the read path, and specifically the merge rules — a bug there
// shows up as duplicated or missing calls rather than as an error.
//
// vi.doMock is registered INLINE in each test rather than through a shared helper.
// Via a helper the registration did not reliably apply to telemetry's dynamic
// import and the tests silently hit the REAL database, which returned a hundred
// live rows and made correct code look broken. Inline is repetitive and actually
// deterministic.

import { describe, it, expect, vi } from 'vitest'

// A row shaped as call_traces stores it: `summary` is the whole trace JSON.
const row = (sid, startedAt, extra = {}) => ({
  call_sid: sid,
  summary: { callSid: sid, startedAt, endedAt: startedAt + 60_000, durationMs: 60_000, status: 'completed', ...extra },
})

// Mirrors exactly the chains telemetry calls:
//   from('call_traces').select(...).order(...).limit(n)
//   from('call_traces').select(...).eq(...).maybeSingle()
const mockDb = (rows, { failing = false } = {}) => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: async () => { if (failing) throw new Error('db down'); return { data: rows } },
        }),
        eq: (_col, val) => ({
          maybeSingle: async () => {
            if (failing) throw new Error('db down')
            return { data: rows.find((r) => r.call_sid === val) || null }
          },
        }),
      }),
    }),
  },
})

describe('getRecentTraces', () => {
  it('returns persisted history when this process has seen nothing', async () => {
    // The restart case, which is the entire point: an empty ring must not mean an
    // empty dashboard.
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('a', 3000), row('b', 2000), row('c', 1000)]))
    const t = await import('../src/services/telemetry.js')
    expect((await t.getRecentTraces(100)).map((x) => x.callSid)).toEqual(['a', 'b', 'c'])
  })

  it('returns newest first', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('old', 1000), row('new', 9000), row('mid', 5000)]))
    const t = await import('../src/services/telemetry.js')
    expect((await t.getRecentTraces(100)).map((x) => x.callSid)).toEqual(['new', 'mid', 'old'])
  })

  it('does not duplicate a call held in both memory and the database', async () => {
    // A just-ended call is in the ring AND has been written. Returning it twice
    // would inflate every count computed from this list.
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('dup', 5000), row('older', 1000)]))
    const t = await import('../src/services/telemetry.js')
    // Prime telemetry's db() memo THROUGH the mock before touching endTrace.
    // endTrace fires persistTrace() unawaited, and that dynamic import escapes the
    // mock and memoises the REAL Supabase client — after which the read below hits
    // production and returns a hundred live rows. One mocked call first pins the
    // memo to the mock. Test-only ordering; the production path is unaffected.
    await t.getRecentTraces(1)

    t.startTrace({ callSid: 'dup' })
    t.endTrace('dup', { status: 'completed' })
    const out = await t.getRecentTraces(100)
    expect(out.filter((x) => x.callSid === 'dup')).toHaveLength(1)
    expect(out.map((x) => x.callSid)).toContain('older')
  })

  it('prefers the in-memory copy, which is fresher than the stored row', async () => {
    // persistTrace() may still be in flight when the ring already holds the final
    // object, so memory must win over the older persisted snapshot.
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('dup', 5000, { status: 'stale-from-db' })]))
    const t = await import('../src/services/telemetry.js')
    // Prime telemetry's db() memo THROUGH the mock before touching endTrace.
    // endTrace fires persistTrace() unawaited, and that dynamic import escapes the
    // mock and memoises the REAL Supabase client — after which the read below hits
    // production and returns a hundred live rows. One mocked call first pins the
    // memo to the mock. Test-only ordering; the production path is unaffected.
    await t.getRecentTraces(1)

    t.startTrace({ callSid: 'dup' })
    t.endTrace('dup', { status: 'completed' })
    const out = await t.getRecentTraces(100)
    expect(out.find((x) => x.callSid === 'dup').status).toBe('completed')
  })

  it('honours the limit after merging', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('a', 5000), row('b', 4000), row('c', 3000), row('d', 2000)]))
    const t = await import('../src/services/telemetry.js')
    expect(await t.getRecentTraces(2)).toHaveLength(2)
  })

  it('falls back to memory when the database is unreachable', async () => {
    // A dashboard degraded to this-process-only beats one that 500s.
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([], { failing: true }))
    const t = await import('../src/services/telemetry.js')
    // Prime telemetry's db() memo THROUGH the mock before touching endTrace.
    // endTrace fires persistTrace() unawaited, and that dynamic import escapes the
    // mock and memoises the REAL Supabase client — after which the read below hits
    // production and returns a hundred live rows. One mocked call first pins the
    // memo to the mock. Test-only ordering; the production path is unaffected.
    await t.getRecentTraces(1)

    t.startTrace({ callSid: 'live' })
    t.endTrace('live', { status: 'completed' })
    expect((await t.getRecentTraces(100)).map((x) => x.callSid)).toEqual(['live'])
  })

  it('returns an empty array rather than throwing when there is nothing anywhere', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([]))
    const t = await import('../src/services/telemetry.js')
    await expect(t.getRecentTraces(100)).resolves.toEqual([])
  })
})

describe('getTraceDetail', () => {
  it('serves an in-flight call from memory', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([]))
    const t = await import('../src/services/telemetry.js')
    t.startTrace({ callSid: 'active-one' })
    expect((await t.getTraceDetail('active-one'))?.callSid).toBe('active-one')
  })

  it('falls back to the database for a call this process never saw', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([row('wanted', 1000)]))
    const t = await import('../src/services/telemetry.js')
    expect((await t.getTraceDetail('wanted'))?.callSid).toBe('wanted')
  })

  it('returns null for an unknown call sid', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([]))
    const t = await import('../src/services/telemetry.js')
    expect(await t.getTraceDetail('never-existed')).toBeNull()
  })

  it('returns null rather than throwing when the database is down', async () => {
    vi.resetModules()
    vi.doMock('../src/api/db.js', () => mockDb([], { failing: true }))
    const t = await import('../src/services/telemetry.js')
    await expect(t.getTraceDetail('anything')).resolves.toBeNull()
  })
})

describe('flushRollups', () => {
  // The live database never had sql/observability.sql's min/max migration applied, so
  // an insert naming those columns is refused as a whole — returned as { error }, not
  // thrown. From 2026-08-27 that silently dropped every latency rollup.
  const dbWithoutMinMax = (inserted) => ({
    supabase: {
      from: () => ({
        insert: async (rows) => {
          if (rows.some((r) => 'min' in r || 'max' in r)) {
            return { error: { message: "Could not find the 'max' column of 'metric_rollups'" } }
          }
          inserted.push(...rows)
          return { error: null }
        },
      }),
    },
  })

  it('still persists latency percentiles when the table has no min/max columns', async () => {
    vi.resetModules()
    const inserted = []
    vi.doMock('../src/api/db.js', () => dbWithoutMinMax(inserted))
    const t = await import('../src/services/telemetry.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t.recordLatency('stt_endpoint', 830)
    t.recordLatency('stt_endpoint', 1200)
    await t.flushRollups()
    warn.mockRestore()
    const row = inserted.find((r) => r.metric === 'latency' && r.op === 'stt_endpoint')
    expect(row).toMatchObject({ count: 2, p50: 1200 })
    expect(inserted.some((r) => r.metric === 'infra')).toBe(true)
  })
})
