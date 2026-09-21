// The lead detail endpoint has to hand the page the call's transcript.
//
// This is plumbing, and plumbing is exactly what fails silently here: the transcript
// lives on `calls`, not `leads`, so it only reaches the page if the endpoint remembers
// to select it AND to copy it onto the response. Drop either half and the page renders
// "No transcript for this call" on a call that has a perfectly good one — a wrong
// answer that looks like a legitimately empty one.
//
// Supabase is mocked. No credentials, no network.
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ lead: null, call: null, profile: null }))

// The mock HONOURS the select list. That matters more than it looks: a mock that
// returns the whole fixture row regardless of what was asked for cannot tell a
// correct endpoint from one that forgot to select the column, and a test that cannot
// fail is worse than no test — it reads like coverage.
vi.mock('../src/api/db.js', () => ({
  supabase: {
    from(table) {
      let columns = '*'
      const project = (row) => {
        if (!row) return null
        if (columns.trim() === '*') return row
        const wanted = columns.split(',').map(c => c.trim()).filter(Boolean)
        return Object.fromEntries(wanted.map(c => [c, row[c]]))
      }
      const chain = {
        select(cols = '*') { columns = cols; return chain },
        eq() { return chain },
        maybeSingle() {
          if (table === 'leads') return Promise.resolve({ data: project(state.lead), error: null })
          if (table === 'calls') return Promise.resolve({ data: project(state.call), error: null })
          if (table === 'profiles') return Promise.resolve({ data: project(state.profile), error: null })
          throw new Error(`Unexpected table: ${table}`)
        },
        then(resolve, reject) { return chain.maybeSingle().then(resolve, reject) },
      }
      return chain
    },
  },
  supabaseAdmin: null,
}))

vi.mock('../src/api/auth.js', () => ({
  requireClient: () => (req, _res, next) => {
    req.auth = { tenantId: 't1', userId: 'u1', role: 'owner', email: 'a@b.c' }
    next()
  },
}))
vi.mock('../src/api/permissions.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  permissionsFor: () => [],
}))
vi.mock('../src/services/notifications.js', () => ({ notify: vi.fn() }))
vi.mock('../src/services/recording.js', () => ({
  getRecordingUrl: vi.fn(async (p) => (p ? `https://signed.example/${p}` : null)),
}))

// A real Soniox transcript: Telugu, code-mixed, English prefixes on each line.
const TRANSCRIPT = [
  'Agent: నమస్కారం, AnswerLabs నుండి ప్రియ మాట్లాడుతున్నాను.',
  'Caller: మా దగ్గర రెండు BHK ఉందా?',
  'Agent: అవును గారు, రెండు BHK ఫ్లాట్స్ ఉన్నాయి.',
].join('\n')

async function app() {
  vi.resetModules()
  const { default: router } = await import('../src/api/client.js')
  const a = express()
  a.use(express.json())
  a.use('/api/client', router)
  return a
}

beforeEach(() => {
  state.lead = { id: 'l1', tenant_id: 't1', call_id: 'c1', summary: 'Wants a 2BHK' }
  state.call = { duration_seconds: 94, recording_path: 't1/c1.wav', transcript: TRANSCRIPT }
  state.profile = null
})

describe('a lead carries the call it came from', () => {
  it('returns the transcript alongside the recording', async () => {
    const res = await request(await app()).get('/api/client/leads/l1')
    expect(res.status).toBe(200)
    expect(res.body.lead.transcript).toBe(TRANSCRIPT)
    expect(res.body.lead.recording_url).toBe('https://signed.example/t1/c1.wav')
    expect(res.body.lead.duration_seconds).toBe(94)
  })

  it('keeps the caller\'s own words, not a summary of them', async () => {
    // The summary is the extractor's reading of the call. The transcript is the call.
    // A page that showed a paraphrase in the transcript's place would be worse than
    // showing nothing, because nobody would know to distrust it.
    const res = await request(await app()).get('/api/client/leads/l1')
    expect(res.body.lead.transcript).toContain('మా దగ్గర రెండు BHK ఉందా?')
    expect(res.body.lead.transcript).not.toBe(res.body.lead.summary)
  })

  it('reports no transcript rather than failing when the call has none', async () => {
    state.call = { duration_seconds: 12, recording_path: null, transcript: null }
    const res = await request(await app()).get('/api/client/leads/l1')
    expect(res.status).toBe(200)
    expect(res.body.lead.transcript).toBeNull()
  })

  it('survives a lead with no call attached to it', async () => {
    // Leads can be created by hand from the dashboard; those have no call_id and must
    // not 500 the page.
    state.lead = { id: 'l2', tenant_id: 't1', call_id: null, summary: 'Walk-in' }
    const res = await request(await app()).get('/api/client/leads/l2')
    expect(res.status).toBe(200)
    expect(res.body.lead.transcript).toBeNull()
    expect(res.body.lead.recording_url).toBeNull()
  })
})
