// services/notify.js — get a message to a human.
//
// The alert engine has always DETECTED problems correctly. What it has never done
// is tell anyone: alerts landed in an in-memory map and a websocket event, so they
// existed only while somebody happened to be looking at the Operations Center. A
// 3am crash, a Gemini outage, a reconnect storm — all of it fired into an empty
// room. This is the missing half.
//
// Two channels, both optional and independent:
//   ALERT_WEBHOOK_URL  — Slack/Discord/generic incoming webhook (the fast one)
//   ALERT_EMAIL_TO     — comma-separated addresses, via the SMTP already configured
//
// With neither set, notify() logs and returns. That is a legitimate configuration
// for local development, but it is exactly the production state this module exists
// to fix — so the boot-time summary says so out loud rather than staying silent.
//
// Rules this file follows without exception:
//   1. It NEVER throws. It is called from the alert tick and from the crash
//      handler; a notifier that can fail takes the thing it was reporting with it.
//   2. It NEVER blocks the caller for long. Every send has a hard timeout.
//   3. It de-duplicates. A flapping threshold must not send fifty emails, or the
//      next real alert arrives in a mailbox nobody reads any more.

import { sendEmail, emailReady } from './email.js'
import 'dotenv/config'

const WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || '').trim()
const EMAIL_TO = (process.env.ALERT_EMAIL_TO || '')
  .split(',').map(s => s.trim()).filter(Boolean)

// Only notify at or above this severity. Warnings are for the dashboard; waking
// someone for a CPU blip is how a pager gets muted, and a muted pager is worse
// than none because it is believed to be working.
const MIN_SEVERITY = (process.env.ALERT_MIN_SEVERITY || 'critical').toLowerCase()
const SEVERITY_RANK = { info: 1, warning: 2, error: 3, critical: 4 }

// How long the same key stays quiet after a send. A threshold hovering at its
// limit flaps repeatedly; without this each flap is another message.
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 15 * 60 * 1000)
const SEND_TIMEOUT_MS = Number(process.env.ALERT_SEND_TIMEOUT_MS || 5000)

const APP = process.env.APP_NAME || 'Vocera'
const ENVIRONMENT = process.env.NODE_ENV || 'development'

export const notifyConfigured = Boolean(WEBHOOK_URL || EMAIL_TO.length)

const lastSentAt = new Map()   // key -> timestamp

function withinCooldown(key) {
  const prev = lastSentAt.get(key)
  if (prev && Date.now() - prev < COOLDOWN_MS) return true
  lastSentAt.set(key, Date.now())
  return false
}

function meetsSeverity(severity) {
  return (SEVERITY_RANK[String(severity).toLowerCase()] || 0) >= (SEVERITY_RANK[MIN_SEVERITY] || 4)
}

async function postWebhook(payload) {
  // AbortSignal.timeout rather than an unbounded fetch: a webhook host that hangs
  // must not hold the alert tick — or, worse, a dying process — open.
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`webhook responded ${res.status}`)
}

/**
 * Send a notification. Resolves to a summary of what was delivered; never rejects.
 *
 * @param {object}  n
 * @param {string}  n.title      one-line summary — becomes the email subject
 * @param {string}  n.body       detail
 * @param {string} [n.severity]  info | warning | error | critical
 * @param {string} [n.key]       de-duplication key (defaults to the title)
 * @param {boolean}[n.force]     bypass severity filter AND cooldown (crashes)
 */
export async function notify({ title, body = '', severity = 'critical', key, force = false } = {}) {
  const result = { sent: [], skipped: null }
  try {
    if (!title) return { ...result, skipped: 'no_title' }
    if (!force && !meetsSeverity(severity)) return { ...result, skipped: 'below_min_severity' }
    if (!force && withinCooldown(key || title)) return { ...result, skipped: 'cooldown' }

    if (!notifyConfigured) {
      // Loud, because this is the failure mode the module exists to prevent.
      console.warn(`[NOTIFY] ${severity.toUpperCase()}: ${title} — NOT DELIVERED (set ALERT_WEBHOOK_URL or ALERT_EMAIL_TO)`)
      return { ...result, skipped: 'not_configured' }
    }

    const line = `[${APP}/${ENVIRONMENT}] ${title}`
    const jobs = []

    if (WEBHOOK_URL) {
      // `text` is what Slack renders; the extra fields are inert there and useful
      // to any other receiver, so one payload serves both.
      jobs.push(
        postWebhook({ text: `${line}\n${body}`, title, body, severity, app: APP, environment: ENVIRONMENT, ts: new Date().toISOString() })
          .then(() => result.sent.push('webhook'))
          .catch((e) => console.error('[NOTIFY] webhook failed:', e.message))
      )
    }

    if (EMAIL_TO.length && emailReady()) {
      jobs.push(
        sendEmail({
          to: EMAIL_TO.join(','),
          subject: line,
          text: `${body}\n\nSeverity: ${severity}\nEnvironment: ${ENVIRONMENT}\nTime: ${new Date().toISOString()}`,
          html: `<p><strong>${escapeHtml(title)}</strong></p><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(body)}</pre>`
            + `<p style="color:#666;font-size:12px">Severity ${escapeHtml(severity)} · ${escapeHtml(ENVIRONMENT)} · ${new Date().toISOString()}</p>`,
        })
          .then(() => result.sent.push('email'))
          .catch((e) => console.error('[NOTIFY] email failed:', e.message))
      )
    }

    await Promise.all(jobs)
    if (result.sent.length) console.log(`[NOTIFY] ${severity}: ${title} → ${result.sent.join(', ')}`)
    return result
  } catch (e) {
    // Rule 1. Whatever happened here is less important than what we were reporting.
    console.error('[NOTIFY] failed:', e.message)
    return { ...result, skipped: 'error' }
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Called once at boot so a deployment with no delivery configured says so in the
// logs, instead of looking healthy while being unable to report anything.
export function logNotifyConfig() {
  if (!notifyConfigured) {
    console.warn('[NOTIFY] no alert delivery configured — alerts and crashes will reach nobody.')
    console.warn('         Set ALERT_WEBHOOK_URL (Slack-compatible) and/or ALERT_EMAIL_TO.')
    return
  }
  const channels = [WEBHOOK_URL && 'webhook', EMAIL_TO.length && `email(${EMAIL_TO.length})`].filter(Boolean)
  console.log(`[NOTIFY] alert delivery: ${channels.join(' + ')} — min severity ${MIN_SEVERITY}`)
  if (EMAIL_TO.length && !emailReady()) {
    console.warn('[NOTIFY] ALERT_EMAIL_TO is set but SMTP is not configured — email will not send.')
  }
}

export default { notify, notifyConfigured, logNotifyConfig }
