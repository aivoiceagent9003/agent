// api/webhook-auth.js — authentication for provider webhooks and signed callbacks.
//
// Plivo's request signature (X-Plivo-Signature-V3) is not verified here. What we
// can control is the URL we hand the provider, so the secret rides in the URL and
// every webhook mount checks it. That is weaker than real request signing — anyone
// who can read the URL can replay it — which is exactly why the transfer endpoint
// ALSO signs its destination (see signDestination below) instead of trusting the
// query string it receives back.
//
// Config: WEBHOOK_SECRET must be set. When it is missing every gated route returns
// 503 rather than falling open, so a misconfigured deploy fails loudly instead of
// quietly serving an unauthenticated telephony surface.

import crypto from 'crypto'
import 'dotenv/config'

const SECRET = process.env.WEBHOOK_SECRET || ''

export const WEBHOOK_SECRET_SET = Boolean(SECRET)

// Constant-time compare that tolerates length mismatch. timingSafeEqual throws
// when the buffers differ in length, and that throw is itself a length oracle, so
// hash both sides to a fixed width first and compare those.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// Express gate for provider webhooks. The secret may arrive as ?k= (what we put in
// the URLs configured in the Plivo console) or as an X-Webhook-Secret header.
export function requireWebhookSecret() {
  return (req, res, next) => {
    if (!SECRET) {
      console.error('[WEBHOOK-AUTH] WEBHOOK_SECRET is not set — refusing webhook')
      return res.status(503).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>'
      )
    }
    const got = String(req.query.k || req.headers['x-webhook-secret'] || '')
    if (!got || !safeEqual(got, SECRET)) {
      console.error(`[WEBHOOK-AUTH] rejected ${req.method} ${req.path} from ${req.ip}`)
      return res.status(403).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>'
      )
    }
    next()
  }
}

// ─── Signed transfer destinations ─────────────────────────────────────────────
// The handoff flow hands Plivo a URL and Plivo fetches it back to get <Dial> XML.
// The destination number therefore makes a round trip through a third party and
// returns as a query string, so it cannot be trusted on the way back: without a
// signature, anyone who can reach the endpoint dials any number they like on our
// account.
//
// We sign (to, callerId) when building the URL and re-verify on receipt. The
// signature is bound to both values together, so neither can be swapped
// independently, and it is scoped with a label so a signature minted here cannot
// be replayed against some other endpoint that happens to use the same secret.

// The payload is JSON-encoded rather than joined with a delimiter. Interpolating
// `${to}|${callerId}` made the field boundary ambiguous: ("+9198765", "43210|+918")
// and ("+9198765|43210", "+918") produced the SAME payload and therefore the same
// signature, so a signature issued for one authorised the other.
//
// isE164 rejects "|" today, so nothing could reach this with a delimiter in it —
// this was latent, not exploitable. It is fixed for the same reason xmlEscape is
// kept below: a control that depends on a validator somewhere else staying exactly
// as strict is one refactor away from being no control at all.
//
// v2 because the encoding changed. A signature minted by v1 will not verify here,
// which matters only for a transfer already in flight across a deploy.
export function signDestination(to, callerId) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`vobiz-transfer:v2:${JSON.stringify([String(to ?? ''), String(callerId ?? '')])}`)
    .digest('hex')
    .slice(0, 32)
}

export function verifyDestination(to, callerId, sig) {
  if (!SECRET || !sig) return false
  return safeEqual(sig, signDestination(to, callerId))
}

// ─── Value hygiene for XML interpolation ──────────────────────────────────────

// Plivo dials E.164. Anything else is either a mistake or an attempt to smuggle
// something into the XML, and both should be refused rather than normalised.
export function isE164(n) {
  return /^\+?[0-9]{8,15}$/.test(String(n || ''))
}

// Escape before interpolating into XML. Belt and braces: isE164 already rejects
// every character this would escape, but the escaping stays so that a future
// caller who interpolates a less constrained value does not reintroduce injection.
export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// The `?k=<secret>` suffix to append to URLs we hand the provider.
export function webhookQuery() {
  return SECRET ? `k=${encodeURIComponent(SECRET)}` : ''
}

// Exposed for the WebSocket upgrade path, which has no Express req/res to work
// with and so cannot use requireWebhookSecret().
export function timingSafeStringEqual(a, b) {
  if (!a || !b) return false
  return safeEqual(a, b)
}
