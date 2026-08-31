// Integration tests against a REAL booted server.
//
// The entry point calls server.listen() at import and does not export the app, so
// these spawn it on a spare port rather than importing it. That is slower than
// supertest-against-an-exported-app, but it buys something the faster version
// cannot: this exercises the actual boot path, the real middleware ORDER, and the
// gates as they are genuinely mounted. Middleware bugs are almost always ordering
// bugs, and a hand-assembled test app would have a different order by definition.
//
// Nothing here needs a database. Every assertion is about a request being REFUSED,
// and refusals happen in middleware, before any handler touches Supabase.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'

const PORT = 3097
const BASE = `http://localhost:${PORT}`
const SECRET = 'integration-test-secret'

let child

const get = (path, init) => fetch(BASE + path, init)

// `...init` is spread FIRST and headers merged after. Spreading it last replaced
// the whole headers object, so any call passing a custom header silently lost
// Content-Type, express.json() skipped the body, and the handler 500'd on an
// undefined req.body — which looked exactly like a server bug.
const post = (path, body, init = {}) =>
  fetch(BASE + path, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

beforeAll(async () => {
  child = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      WEBHOOK_SECRET: SECRET,
      CAMPAIGN_RUNNER: 'off',   // no background dialling during tests
      // With NO allow-list configured, dev mode deliberately echoes any origin so a
      // local frontend on any port works. Setting one here is what makes the CORS
      // assertions below meaningful — otherwise they would be testing that dev
      // convenience, not the allow-list.
      FRONTEND_ORIGIN: 'https://app.example.com,https://admin.example.com',
      // Several SDK clients are constructed at MODULE LOAD and throw without a
      // key, so the process cannot even reach listen() without these present.
      // Real values are used when a .env supplies them; otherwise these obvious
      // placeholders let the suite run on a machine (or a CI runner) that has no
      // credentials at all. Nothing here contacts those services — every
      // assertion in this file is about a request being refused in middleware.
      SUPABASE_URL: process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'placeholder-anon-key',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-placeholder',
      GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY || 'placeholder-google-key',
    },
    stdio: 'ignore',
  })
  // Poll rather than sleep a fixed time: a fixed wait is either flaky or slow.
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await get('/health')
      if (r.ok) break
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not come up within 30s')
    await new Promise((r) => setTimeout(r, 250))
  }
}, 40_000)

afterAll(() => {
  if (child && !child.killed) child.kill()
})

describe('health', () => {
  it('reports liveness without touching dependencies', async () => {
    const r = await get('/health')
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(typeof body.uptime_s).toBe('number')
  })
})

describe('telephony webhook gate', () => {
  // These four routes can each start or steer a phone call. Unauthenticated access
  // is somebody spending the tenant's telephony balance.
  const gated = [
    ['POST', '/answer'],
    ['POST', '/hangup'],
    ['POST', '/vobiz/transfer'],
    ['GET', '/vobiz/transfer'],
    ['POST', '/answer-campaign'],
  ]

  for (const [method, path] of gated) {
    it(`${method} ${path} refuses a request with no secret`, async () => {
      const r = method === 'GET' ? await get(path) : await post(path, {})
      expect(r.status).toBe(403)
    })

    it(`${method} ${path} refuses a WRONG secret`, async () => {
      const url = `${path}?k=not-the-secret`
      const r = method === 'GET' ? await get(url) : await post(url, {})
      expect(r.status).toBe(403)
    })
  }

  it('accepts the correct secret in the query string', async () => {
    const r = await post(`/answer?k=${encodeURIComponent(SECRET)}`, {
      From: '+919876543210',
      To: '+918888888888',
      CallUUID: 'test-uuid-1',
    })
    expect(r.status).toBe(200)
    const xml = await r.text()
    expect(xml).toContain('<Response>')
  })

  it('accepts the correct secret in the X-Webhook-Secret header', async () => {
    const r = await post('/answer', { From: '+919876543210', To: '+918888888888', CallUUID: 'test-uuid-2' }, {
      headers: { 'X-Webhook-Secret': SECRET },
    })
    expect(r.status).toBe(200)
  })

  it('does not leak the secret in a rejection body', async () => {
    const body = await (await post('/answer', {})).text()
    expect(body).not.toContain(SECRET)
  })
})

describe('API auth matrix', () => {
  // Every one of these reads or writes tenant data. Anonymous access must be
  // refused by middleware, before a handler ever runs.
  const clientRoutes = [
    '/api/client/me',
    '/api/client/agent',
    '/api/client/campaigns',
    '/api/client/team',
    '/api/client/messages',
    '/api/client/notifications',
    '/api/client/whatsapp',
  ]
  const adminRoutes = ['/api/admin/clients', '/api/admin/ops/live', '/api/admin/dsr/lookup?phone=%2B919876543210']

  for (const path of [...clientRoutes, ...adminRoutes]) {
    it(`${path} refuses an anonymous request`, async () => {
      expect((await get(path)).status).toBe(401)
    })

    it(`${path} refuses a forged bearer token`, async () => {
      const r = await get(path, { headers: { Authorization: 'Bearer not.a.real.jwt' } })
      expect(r.status).toBe(401)
    })
  }

  it('refuses a structurally valid but unsigned JWT', async () => {
    // Anyone can base64 a header and payload. Only the signature makes it a token,
    // so a hand-rolled one with the right SHAPE must still be rejected.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const forged = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: '00000000-0000-0000-0000-000000000000',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.notarealsignature`
    const r = await get('/api/client/me', { headers: { Authorization: `Bearer ${forged}` } })
    expect(r.status).toBe(401)
  })
})

describe('signup gate', () => {
  it('refuses password signup unless explicitly enabled', async () => {
    const r = await post('/api/signup', {
      email: 'integration@vocera-test.invalid',
      password: 'Password123!',
      business_name: 'Integration Test',
    })
    expect(r.status).toBe(403)
  })
})

describe('rate limiting', () => {
  it('returns 429 once failed auth attempts exceed the window limit', async () => {
    // authLimiter: 10 per 15 min, counting only FAILED attempts. Credential
    // stuffing is the thing being stopped, so the failures are the point.
    const codes = []
    for (let i = 0; i < 14; i++) {
      const r = await post('/api/auth/login', {
        email: `ratelimit-${i}@vocera-test.invalid`,
        password: 'definitely-wrong',
      })
      codes.push(r.status)
    }
    expect(codes).toContain(429)
    // …and it must not trip so early that a person mistyping twice is locked out.
    expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true)
  }, 30_000)

  it('says why it refused without exposing internals', async () => {
    const r = await post('/api/auth/login', { email: 'x@vocera-test.invalid', password: 'wrong' })
    if (r.status === 429) {
      const body = await r.json()
      expect(body.error).toMatch(/too many/i)
    }
  })
})

describe('CORS', () => {
  it('reflects an allow-listed origin', async () => {
    const r = await get('/health', { headers: { Origin: 'https://app.example.com' } })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
  })

  it('reflects each entry of a comma-separated allow-list', async () => {
    const r = await get('/health', { headers: { Origin: 'https://admin.example.com' } })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://admin.example.com')
  })

  it('does NOT reflect an origin outside the allow-list', async () => {
    // This API accepts an Authorization header. Reflecting an arbitrary origin
    // would let any site on the internet drive it with a victim's token.
    const r = await get('/health', { headers: { Origin: 'https://evil.example' } })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never answers with a wildcard', async () => {
    const r = await get('/health', { headers: { Origin: 'https://evil.example' } })
    expect(r.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('sets Vary: Origin so a cache cannot cross-serve the header', async () => {
    const r = await get('/health', { headers: { Origin: 'https://app.example.com' } })
    expect(String(r.headers.get('vary') || '')).toContain('Origin')
  })
})
