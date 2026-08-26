// Webhook authentication and the signed transfer destination.
//
// This is the boundary where an unauthenticated caller could otherwise make the
// platform place a phone call. The transfer endpoint is the sharp end: it takes a
// destination number and dials it, so an unsigned or forgeable destination is a
// stranger using your Vobiz balance to ring any number they like.
//
// WEBHOOK_SECRET is read once at import, so these tests set it before importing.

import { describe, it, expect, beforeAll } from 'vitest'

let signDestination, verifyDestination, isE164, xmlEscape, webhookQuery, timingSafeStringEqual

beforeAll(async () => {
  process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret-for-vitest-only'
  const m = await import('../src/api/webhook-auth.js')
  ;({ signDestination, verifyDestination, isE164, xmlEscape, webhookQuery, timingSafeStringEqual } = m)
})

describe('destination signing', () => {
  it('is deterministic for the same inputs', () => {
    expect(signDestination('+919876543210', '+918888888888'))
      .toBe(signDestination('+919876543210', '+918888888888'))
  })

  it('verifies a signature it produced', () => {
    const sig = signDestination('+919876543210', '+918888888888')
    expect(verifyDestination('+919876543210', '+918888888888', sig)).toBe(true)
  })

  it('rejects a signature bound to a DIFFERENT destination', () => {
    // The attack this stops: capture a legitimate transfer URL, swap the number,
    // and have the platform dial a premium-rate line on the tenant's account.
    const sig = signDestination('+919876543210', '+918888888888')
    expect(verifyDestination('+919999999999', '+918888888888', sig)).toBe(false)
  })

  it('rejects a signature bound to a different caller id', () => {
    const sig = signDestination('+919876543210', '+918888888888')
    expect(verifyDestination('+919876543210', '+917777777777', sig)).toBe(false)
  })

  it('rejects an absent, empty, or malformed signature', () => {
    for (const bad of [undefined, null, '', 'deadbeef', '0'.repeat(32)]) {
      expect(verifyDestination('+919876543210', '+918888888888', bad)).toBe(false)
    }
  })

  it('treats a missing caller id consistently', () => {
    const a = signDestination('+919876543210', null)
    expect(verifyDestination('+919876543210', null, a)).toBe(true)
    expect(verifyDestination('+919876543210', undefined, a)).toBe(true)
    expect(verifyDestination('+919876543210', '', a)).toBe(true)
    // …but an absent caller id must not verify against a present one.
    expect(verifyDestination('+919876543210', '+918888888888', a)).toBe(false)
  })

  it('produces a 32-character hex signature', () => {
    expect(signDestination('+919876543210', '+918888888888')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('cannot be confused by moving the delimiter between fields', () => {
    // The payload joins fields with "|". If a value could contain the delimiter,
    // ("a", "b|c") and ("a|b", "c") would sign identically and a signature for one
    // would authorise the other.
    const a = signDestination('+9198765', '43210|+91888')
    const b = signDestination('+9198765|43210', '+91888')
    expect(a).not.toBe(b)
  })
})

describe('isE164', () => {
  it('accepts plausible dialable numbers', () => {
    for (const n of ['+919876543210', '919876543210', '+14155552671', '12345678']) {
      expect(isE164(n)).toBe(true)
    }
  })

  it('rejects anything carrying characters that could break out of XML', () => {
    // isE164 is the real defence for the transfer XML; xmlEscape is the backstop.
    const hostile = [
      '+91987"/><Dial>+1900</Dial><X y="',
      "+91987'><Hangup/>",
      '+91 987 654',      // spaces
      '+91-9876543210',   // punctuation
      '<script>',
      '',
      null,
      undefined,
      '+9199999999999999999', // too long
      '+919',                 // too short
    ]
    for (const n of hostile) expect(isE164(n)).toBe(false)
  })
})

describe('xmlEscape', () => {
  it('escapes all five XML metacharacters', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;')
  })

  it('escapes the ampersand first so escapes are not double-encoded', () => {
    // Replacing < before & would turn "<" into "&lt;" and then "&amp;lt;".
    expect(xmlEscape('<')).toBe('&lt;')
    expect(xmlEscape('&lt;')).toBe('&amp;lt;')
  })

  it('neutralises an attempted tag injection', () => {
    const out = xmlEscape('"/><Dial>+1900123</Dial><Response x="')
    expect(out).not.toContain('<Dial>')
    expect(out).not.toContain('"')
  })

  it('renders null and undefined as empty rather than as text', () => {
    expect(xmlEscape(null)).toBe('')
    expect(xmlEscape(undefined)).toBe('')
  })
})

describe('webhookQuery', () => {
  it('produces a k= parameter with the secret percent-encoded', () => {
    const q = webhookQuery()
    expect(q.startsWith('k=')).toBe(true)
    expect(q).toBe(`k=${encodeURIComponent(process.env.WEBHOOK_SECRET)}`)
  })
})

describe('timingSafeStringEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeStringEqual('abc123', 'abc123')).toBe(true)
  })

  it('rejects different strings, including differing lengths', () => {
    // Length mismatch must return false rather than throw — the throw in
    // crypto.timingSafeEqual is itself a length oracle, which is why both sides
    // are hashed to a fixed width first.
    expect(timingSafeStringEqual('abc123', 'abc124')).toBe(false)
    expect(() => timingSafeStringEqual('short', 'a much longer value')).not.toThrow()
    expect(timingSafeStringEqual('short', 'a much longer value')).toBe(false)
  })

  it('rejects empty or missing operands instead of matching them', () => {
    for (const [a, b] of [['', ''], ['x', ''], ['', 'x'], [null, null], [undefined, 'x']]) {
      expect(timingSafeStringEqual(a, b)).toBe(false)
    }
  })
})
