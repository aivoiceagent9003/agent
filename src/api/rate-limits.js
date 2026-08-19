// api/rate-limits.js — tiered rate limiters.
//
// Limits are keyed by what actually bounds the abuse, which is not always the IP:
//   • credential endpoints  → per IP (the attacker has no account yet)
//   • spend endpoints       → per TENANT (one compromised account shouldn't be able
//                             to burn the embedding budget from a thousand IPs)
//
// Tenant-keyed limiters MUST be mounted after requireClient(), because they read
// req.auth.tenantId. Mounted before it they would see undefined and collapse every
// tenant onto one shared bucket.

import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

const MIN = 60 * 1000
const json = (message) => (req, res) => res.status(429).json({ error: message })

// Falls back to the IP when there is no tenant, so a misordered mount degrades to
// per-IP limiting rather than to one global bucket for everyone.
//
// The fallback goes through ipKeyGenerator rather than using req.ip directly:
// a single IPv6 allocation is typically a /64, so keying on the full address lets
// one attacker rotate through billions of addresses and never hit a limit.
// ipKeyGenerator collapses the address to its subnet.
const byTenant = (req) => req.auth?.tenantId || ipKeyGenerator(req.ip)

const base = {
  standardHeaders: true,   // RateLimit-* headers so clients can back off
  legacyHeaders: false,
}

// Credential stuffing and signup spam. Deliberately tight: a real person does not
// attempt eleven logins in a quarter hour.
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * MIN,
  limit: 10,
  skipSuccessfulRequests: true,   // only failed attempts count toward the limit
  handler: json('Too many attempts. Try again in a few minutes.'),
})

// Knowledge ingest — every upload costs embedding tokens.
export const ingestLimiter = rateLimit({
  ...base,
  windowMs: 60 * MIN,
  limit: 20,
  keyGenerator: byTenant,
  handler: json('Upload limit reached for this hour. Please try again later.'),
})

// Campaign creation — every campaign can originate calls.
export const campaignWriteLimiter = rateLimit({
  ...base,
  windowMs: 60 * MIN,
  limit: 30,
  keyGenerator: byTenant,
  handler: json('Campaign limit reached for this hour. Please try again later.'),
})

// Outbound calls placed one at a time from the dashboard.
export const instantCallLimiter = rateLimit({
  ...base,
  windowMs: 60 * MIN,
  limit: 60,
  keyGenerator: byTenant,
  handler: json('Call limit reached for this hour. Please try again later.'),
})

// Everything else under /api. Generous — this is a backstop against scraping and
// runaway clients, not a business rule.
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * MIN,
  limit: 300,
  handler: json('Too many requests. Please slow down.'),
})
