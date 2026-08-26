// End-to-end smoke test: real server, real Supabase, real Gemini session.
//
// This is the one test that would catch the class of break nothing else does — a
// bad model id, a changed SDK signature, an expired key, a malformed audio frame.
// Every one of those kills every call at once while leaving the unit tests green,
// because none of them is reachable without actually talking to the model.
//
// OPT-IN, and deliberately so. It spends real tokens on every run, needs network,
// and depends on a live Supabase. Putting that in the default suite would make
// `npm test` slow, flaky, and billable — and a suite people learn to ignore is
// worse than no suite. Run it before a deploy, not on every save:
//
//     RUN_SMOKE=1 npm test
//
// It provisions its own throwaway user and tenant and deletes both afterwards, so
// it does not depend on any particular account existing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

const ENABLED = process.env.RUN_SMOKE === '1'
const PORT = 3096
const BASE = `http://localhost:${PORT}`

let child
let supabaseAdmin
let userId = null
let tenantId = null
let token = null

const describeSmoke = ENABLED ? describe : describe.skip

describeSmoke('end-to-end voice pipeline', () => {
  beforeAll(async () => {
    ;({ supabaseAdmin } = await import('../src/api/db.js'))
    if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the smoke test')

    child = spawn(process.execPath, ['src/index.js'], {
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', CAMPAIGN_RUNNER: 'off' },
      stdio: 'ignore',
    })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { if ((await fetch(`${BASE}/health`)).ok) break } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('server did not start')
      await new Promise((r) => setTimeout(r, 250))
    }

    // Throwaway tenant + user, so the test owns everything it touches.
    const { data: t } = await supabaseAdmin
      .from('tenants')
      .insert({
        name: 'Smoke Test Co',
        config: { status: 'draft', business_name: 'Smoke Test Co', agent_name: 'Priya', enable_kb: false },
      })
      .select('id').single()
    tenantId = t.id

    const email = `smoke-${Date.now()}@vocera-test.invalid`
    const password = `Smoke!${Date.now()}`
    const { data: created } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })
    userId = created.user.id
    await supabaseAdmin.from('profiles').insert({ id: userId, role: 'client', tenant_id: tenantId, email })

    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    token = (await res.json()).token
    expect(token).toBeTruthy()
  }, 60_000)

  afterAll(async () => {
    if (userId) await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {})
    if (tenantId) {
      await supabaseAdmin.from('profiles').delete().eq('id', userId).catch(() => {})
      await supabaseAdmin.from('tenants').delete().eq('id', tenantId).catch(() => {})
    }
    if (child && !child.killed) child.kill()
  }, 30_000)

  it('rejects a stream that presents no valid token', async () => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/test-stream`)
    const result = await new Promise((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ event: 'start', start: { token: 'not-a-token' } })))
      ws.on('message', (d) => {
        try { resolve(JSON.parse(d)) } catch { /* not JSON */ }
      })
      ws.on('close', () => resolve({ event: 'closed' }))
      setTimeout(() => resolve({ event: 'timeout' }), 15_000)
    })
    ws.close()
    expect(['error', 'closed']).toContain(result.event)
    if (result.event === 'error') expect(result.error).toBe('unauthorized')
  }, 30_000)

  it('produces audio frames when fed a real μ-law capture', async () => {
    // The actual assertion of life: bytes in, bytes out. If the model, the SDK,
    // or the audio path is broken, no media frame ever arrives and every call in
    // production would be silent.
    const mulaw = readFileSync(new URL('../test_output.mulaw', import.meta.url))
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/test-stream`)

    const gotAudio = await new Promise((resolve) => {
      let frames = 0
      let bytes = 0
      const done = (v) => resolve(v)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          event: 'start',
          start: { token, streamSid: 'smoke', config: { greeting_message: 'Hello, this is a test.' } },
        }))
        // Feed the capture in 20ms frames (160 bytes at 8kHz μ-law), pacing it
        // roughly like a real call rather than dumping the file at once.
        let offset = 0
        const pump = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN || offset >= mulaw.length) return clearInterval(pump)
          const frame = mulaw.subarray(offset, offset + 160)
          offset += 160
          ws.send(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } }))
        }, 20)
      })

      ws.on('message', (d) => {
        let msg
        try { msg = JSON.parse(d) } catch { return }
        if (msg.event === 'error') return done({ ok: false, reason: msg.error })
        if (msg.event === 'media' && msg.media?.payload) {
          frames += 1
          bytes += Buffer.from(msg.media.payload, 'base64').length
          if (frames >= 3) done({ ok: true, frames, bytes })
        }
      })

      ws.on('error', (e) => done({ ok: false, reason: e.message }))
      setTimeout(() => done({ ok: false, reason: `timed out after ${frames} frames` }), 45_000)
    })

    try { ws.close() } catch { /* already closing */ }
    expect(gotAudio.ok, `no audio from the engine: ${gotAudio.reason || ''}`).toBe(true)
    expect(gotAudio.bytes).toBeGreaterThan(0)
  }, 60_000)
})

// Always-visible reminder when the suite runs without the flag, so the smoke test
// cannot quietly rot unnoticed behind a skip.
describe('smoke test availability', () => {
  it(ENABLED ? 'is enabled for this run' : 'is skipped unless RUN_SMOKE=1 (costs real tokens)', () => {
    expect(typeof ENABLED).toBe('boolean')
  })
})
