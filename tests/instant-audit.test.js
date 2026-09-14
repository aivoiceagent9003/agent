// Audit characterizations, not an end-to-end Meta certification. External DB,
// Redis and telephony are mocked: no credentials or real calls are used.
// Tests in "confirmed gaps" document current defects. Replace their assertions
// with the desired contract when fixing the corresponding audit finding.
import express from 'express'
import request from 'supertest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tenant: null, calls: [], insertError: false, suppressionError: false,
  suppressed: false, originate: vi.fn(), pending: vi.fn(),
}))

vi.mock('../src/api/db.js', () => ({
  supabase: {
    from(table) {
      const filters = []
      let operation = 'select', payload, single = false
      const execute = () => {
        if (table === 'tenants') return { data: state.tenant, error: null }
        if (table === 'suppression_list') return {
          data: state.suppressed ? { phone: '+12025550123' } : null,
          error: state.suppressionError ? { message: 'database unavailable' } : null,
        }
        if (table !== 'calls') throw new Error(`Unexpected table: ${table}`)
        if (operation === 'insert') {
          if (state.insertError) return { data: null, error: { message: 'insert failed' } }
          const row = { id: `call-${state.calls.length + 1}`, ...payload }
          state.calls.push(row)
          return { data: row, error: null }
        }
        let rows = state.calls.filter(row => filters.every(([key, value]) => row[key] === value))
        if (operation === 'update') rows.forEach(row => Object.assign(row, payload))
        return { data: single ? rows[0] || null : rows, error: null }
      }
      const chain = {
        select() { return chain },
        eq(key, value) { filters.push([key, value]); return chain },
        gte() { return chain }, // all fixture calls were created during this test
        limit() { return chain },
        insert(value) { operation = 'insert'; payload = value; return chain },
        update(value) { operation = 'update'; payload = value; return chain },
        single() { single = true; return chain },
        maybeSingle() { single = true; return chain },
        then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject) },
      }
      return chain
    },
  },
}))
vi.mock('../src/queue/connection.js', () => ({ REDIS_ENABLED: false }))
vi.mock('../src/queue/queues.js', () => ({ enqueueDial: vi.fn(), enqueueBroadcast: vi.fn() }))
vi.mock('../src/services/campaigns/dialer.js', () => ({ originate: state.originate }))
vi.mock('../src/telephony/campaign-registry.js', () => ({ setPending: state.pending }))
vi.mock('../src/services/lookups.js', () => ({ parseCSV: vi.fn() }))

import events from '../src/api/events.js'
import { requireWebhookSecret } from '../src/api/webhook-auth.js'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.text({ type: 'text/xml' }))
app.use('/api/events', events)
app.post('/answer-campaign', requireWebhookSecret(), (_req, res) => res.sendStatus(200))
const path = '/api/events/instant/audit-tenant'
const phone = '+12025550123' // reserved fictional NANP number, never dialled
const lead = { id: 'test-lead-1', phone, name: 'Audit Lead' }
const send = (body = lead) => request(app).post(path).set('X-Instant-Token', 'audit-token').send(body)

beforeEach(() => {
  vi.stubEnv('PUBLIC_HOST', 'voice.example.test')
  state.tenant = {
    id: 'audit-tenant', name: 'Audit tenant', phone_number: '+12025550124',
    config: { instant_call: { token: 'audit-token', preset: 'meta_lead_ads', enabled: true } },
  }
  state.calls = []
  state.insertError = false
  state.suppressionError = false
  state.suppressed = false
  state.originate.mockReset().mockResolvedValue({ providerId: 'mock-provider-id' })
  state.pending.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('instant ingress: supported paths', () => {
  it('forwards a flattened Meta connector lead to the dialer', async () => {
    const res = await send()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ called: true, provider_id: 'mock-provider-id' })
    expect(state.originate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: phone }))
    expect(state.pending).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      config: expect.objectContaining({ contact_name: 'Audit Lead', is_outbound: true }),
    }))
  })
  it('extracts phone and name from an already retrieved Meta field_data lead', async () => {
    const res = await send({ id: 'test-lead-2', field_data: [
      { name: 'phone_number', values: [phone] },
      { name: 'full_name', values: ['Meta Test'] },
    ] })
    expect(res.body.called).toBe(true)
    expect(state.pending.mock.calls[0][1].config.contact_name).toBe('Meta Test')
  })
  it.each(['zoho', 'salesforce'])('supports %s JSON leads', async preset => {
    state.tenant.config.instant_call.preset = preset
    expect((await send({ Phone: phone, Last_Name: 'Test', LastName: 'Test' })).body.called).toBe(true)
  })
  it('supports Salesforce SOAP and sends its acknowledgement', async () => {
    const res = await request(app).post(`${path}?token=audit-token`).set('Content-Type', 'text/xml')
      .send(`<notifications><sObject type="sf:Lead"><sf:Phone>${phone}</sf:Phone><sf:FirstName>Audit</sf:FirstName></sObject></notifications>`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('<Ack>true</Ack>')
    expect(state.originate).toHaveBeenCalledOnce()
  })
  it('rejects an invalid token without dialing', async () => {
    expect((await request(app).post(path).send(lead)).status).toBe(401)
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('does not dial when disabled', async () => {
    state.tenant.config.instant_call.enabled = false
    expect((await send()).status).toBe(403)
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('rejects leads without a phone', async () => {
    expect((await send({ name: 'No Phone' })).status).toBe(400)
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('honours an explicit do-not-call flag', async () => {
    expect((await send({ ...lead, do_not_call: true })).body.reason).toBe('do_not_call')
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('honours a suppression record', async () => {
    state.suppressed = true
    expect((await send()).body.reason).toBe('suppressed')
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('skips contacted status but accepts not-contacted status', async () => {
    state.tenant.config.instant_call.skip_statuses = ['contacted']
    expect((await send({ ...lead, status: 'Contacted' })).body.reason).toBe('already_contacted')
    expect((await send({ ...lead, status: 'Not Contacted' })).body.called).toBe(true)
    expect(state.originate).toHaveBeenCalledOnce()
  })
  it('skips a sequential repeat when recent-call filtering is enabled', async () => {
    state.tenant.config.instant_call.skip_recent_days = 30
    await send()
    expect((await send()).body.reason).toBe('recently_contacted')
    expect(state.originate).toHaveBeenCalledOnce()
  })
  it('returns 502 and marks the call failed on JSON originate failure', async () => {
    state.originate.mockRejectedValue(new Error('provider unavailable'))
    expect((await send()).status).toBe(502)
    expect(state.calls[0].status).toBe('failed')
  })
})

describe('confirmed gaps (characterization, NOT acceptance criteria)', () => {
  it('cannot resolve a native Meta leadgen_id notification', async () => {
    const res = await send({ object: 'page', entry: [{ id: 'page-1', changes: [{
      field: 'leadgen', value: { leadgen_id: 'lead-1', form_id: 'form-1', page_id: 'page-1', created_time: 1789380000 },
    }] }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('no usable phone in payload')
    expect(state.originate).not.toHaveBeenCalled()
  })
  it('echoes Meta verification challenges without validating the verification token or tenant', async () => {
    const res = await request(app).get('/api/events/instant/nonexistent')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' })
    expect(res.status).toBe(200)
    expect(res.text).toBe('12345')
  })
  it('generates an answer URL that is rejected by the actual webhook gate', async () => {
    await send()
    const url = new URL(state.originate.mock.calls[0][0].answerUrl)
    expect(url.searchParams.has('k')).toBe(false)
    // 403 when configured, 503 when absent: neither permits the call to connect.
    expect([403, 503]).toContain((await request(app).post(url.pathname + url.search)).status)
  })
  it('originates twice for the same lead ID when the optional recent filter is off', async () => {
    await send()
    await send()
    expect(state.originate).toHaveBeenCalledTimes(2)
  })
  it('still dials when the calls insert fails', async () => {
    state.insertError = true
    const res = await send()
    expect(res.body).toMatchObject({ called: true, call_id: null })
    expect(state.originate).toHaveBeenCalledOnce()
  })
  it('still dials when the suppression database query errors', async () => {
    state.suppressionError = true
    expect((await send()).body.called).toBe(true)
    expect(state.originate).toHaveBeenCalledOnce()
  })
  it('acknowledges Salesforce delivery even when the provider rejects the call', async () => {
    state.originate.mockRejectedValue(new Error('provider unavailable'))
    const res = await request(app).post(`${path}?token=audit-token`).set('Content-Type', 'text/xml')
      .send(`<notifications><sObject type="sf:Lead"><sf:Phone>${phone}</sf:Phone></sObject></notifications>`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('<Ack>true</Ack>')
    expect(state.calls[0].status).toBe('failed')
  })
})
