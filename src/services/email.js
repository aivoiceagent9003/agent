// services/email.js — Transactional email (welcome message on signup).
//
// Provider-agnostic by design: everything goes over plain SMTP, so the SAME code
// works with Gmail (app password), Resend, SendGrid, Brevo, Amazon SES, or any
// other host — you only change env vars, never code.
//
// Env:
//   SMTP_HOST     e.g. smtp.gmail.com | smtp.resend.com | smtp-relay.brevo.com
//   SMTP_PORT     587 (STARTTLS, default) or 465 (implicit TLS)
//   SMTP_USER     SMTP username (for Gmail: the full address; for Resend: "resend")
//   SMTP_PASS     SMTP password / API key (for Gmail: a 16-char APP PASSWORD, not
//                 your login password — requires 2-Step Verification enabled)
//   EMAIL_FROM    e.g. "Vocera <hello@yourdomain.com>" (defaults to SMTP_USER)
//   APP_URL       dashboard base URL used for links in the email
//
// If SMTP isn't configured the sender is a NO-OP that logs and returns false —
// signup must never fail just because email is down or unconfigured.

import nodemailer from 'nodemailer'
import 'dotenv/config'

const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '')

export function emailReady() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

// Built once and reused (nodemailer pools connections internally).
let _transport = null
function transport() {
  if (_transport) return _transport
  const port = parseInt(process.env.SMTP_PORT || '587', 10)
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,           // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  return _transport
}

// Pull the bare address out of "Name <addr@host>" (or return it unchanged).
function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/)
  return m ? m[1].trim() : String(from || '').trim()
}

// Display names are built from TENANT-SUPPLIED text (business names), so they must
// be sanitised: a CR/LF in a header value lets an attacker inject arbitrary headers
// (Bcc, Reply-To) — classic email header injection. Quotes would break the
// "Name" <addr> quoting.
function safeDisplayName(name) {
  return String(name || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["\\]/g, '')
    .trim()
    .slice(0, 78)
}

// Low-level send. NEVER throws — returns true/false so callers can fire-and-forget.
//
// `fromName` changes only the DISPLAY name; the actual address always stays the
// platform's, because that is the domain our SPF/DKIM are aligned to. Sending as a
// client's own domain would fail their DMARC policy and get us blacklisted — see
// the per-tenant sending domain note in EMAIL_SENDING.md.
export async function sendEmail({ to, subject, html, text, replyTo, fromName }) {
  if (!to) return false
  if (!emailReady()) {
    console.warn(`[EMAIL] SMTP not configured — skipping "${subject}" to ${to}`)
    return false
  }
  try {
    const configured = process.env.EMAIL_FROM || process.env.SMTP_USER
    const display = safeDisplayName(fromName)
    const from = display ? `"${display}" <${addressOf(configured)}>` : configured

    const info = await transport().sendMail({
      from,
      to,
      subject,
      html,
      text,
      // Replies go to the human who triggered the email, not to a mailbox nobody
      // reads. This is what makes an invite feel like it came from the business.
      ...(replyTo ? { replyTo } : {}),
    })
    console.log(`[EMAIL] ✅ Sent "${subject}" to ${to} (${info.messageId})`)
    return true
  } catch (e) {
    console.error(`[EMAIL] ❌ Failed to send "${subject}" to ${to}:`, e.message)
    return false
  }
}

// ─── Welcome email (sent once, right after a new account is provisioned) ──────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function welcomeHtml(firstName) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,'
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;color:#111827;">Welcome to Vocera 👋</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">${hi}</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
              Your account is ready. Vocera is your AI voice agent — it answers every call,
              speaks your customer's language, and captures every lead so you never miss business.
            </p>
            <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#374151;"><strong>To get started:</strong></p>
            <ol style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:1.7;color:#374151;">
              <li>Tell us about your business and pick a voice</li>
              <li>Add your knowledge so the agent can answer questions</li>
              <li>Connect your number and go live</li>
            </ol>
            <p style="margin:0 0 28px;">
              <a href="${APP_URL}/onboarding"
                 style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">
                Set up your agent
              </a>
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
              Need a hand? Just reply to this email — we're happy to help.
            </p>
          </td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">© Vocera</p>
      </td></tr>
    </table>
  </body>
</html>`
}

function welcomeText(firstName) {
  const hi = firstName ? `Hi ${firstName},` : 'Hi there,'
  return `Welcome to Vocera!

${hi}

Your account is ready. Vocera is your AI voice agent — it answers every call, speaks your customer's language, and captures every lead so you never miss business.

To get started:
  1. Tell us about your business and pick a voice
  2. Add your knowledge so the agent can answer questions
  3. Connect your number and go live

Set up your agent: ${APP_URL}/onboarding

Need a hand? Just reply to this email — we're happy to help.

— Vocera`
}

// Build the welcome email (exported so it can be previewed/tested without sending).
export function renderWelcomeEmail({ name } = {}) {
  // "Madhusudhan Reddy" -> "Madhusudhan"; ignore emails used as names.
  const firstName = String(name || '').trim().split(/\s+/)[0] || ''
  const safeFirst = firstName.includes('@') ? '' : firstName
  return {
    subject: 'Welcome to Vocera 👋',
    html: welcomeHtml(safeFirst),
    text: welcomeText(safeFirst),
  }
}

// Send the welcome email. Fire-and-forget friendly: resolves false on any problem
// instead of throwing, so a failed email can never break signup.
export async function sendWelcomeEmail({ to, name }) {
  return sendEmail({ to, ...renderWelcomeEmail({ name }) })
}

// ─── Team invite (owner invites an employee) ─────────────────────────────────

const ROLE_BLURB = {
  owner: 'full access, including agent settings and team management',
  manager: 'calls, leads, campaigns, WhatsApp and the knowledge base',
  agent: 'calls and leads — view them and keep their status up to date',
}

function inviteHtml({ businessName, inviterName, role, url }) {
  const biz = escapeHtml(businessName)
  const who = inviterName ? escapeHtml(inviterName) : 'Your admin'
  const what = escapeHtml(ROLE_BLURB[role] || ROLE_BLURB.agent)
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;color:#111827;">You've been invited to ${biz}</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
              ${who} has invited you to join <strong>${biz}</strong> on Vocera — the AI voice agent
              that answers their calls and captures every lead.
            </p>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
              You'll have access to ${what}.
            </p>
            <p style="margin:0 0 28px;">
              <a href="${url}"
                 style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">
                Accept your invite
              </a>
            </p>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
              This link works once and expires in 7 days. If it stops working, ask ${who} to send a new one.
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
              Not expecting this? You can safely ignore this email.
            </p>
          </td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">© Vocera</p>
      </td></tr>
    </table>
  </body>
</html>`
}

function inviteText({ businessName, inviterName, role, url }) {
  const who = inviterName || 'Your admin'
  return `You've been invited to ${businessName} on Vocera

${who} has invited you to join ${businessName} on Vocera — the AI voice agent that answers their calls and captures every lead.

You'll have access to ${ROLE_BLURB[role] || ROLE_BLURB.agent}.

Accept your invite: ${url}

This link works once and expires in 7 days. If it stops working, ask ${who} to send a new one.
Not expecting this? You can safely ignore this email.

— Vocera`
}

// Exported so the template can be previewed/tested without sending.
export function renderInviteEmail({ businessName, inviterName, role, url }) {
  const args = { businessName: businessName || 'your team', inviterName, role, url }
  return {
    subject: `${args.inviterName || 'Your admin'} invited you to ${args.businessName} on Vocera`,
    html: inviteHtml(args),
    text: inviteText(args),
  }
}

// `inviterEmail` becomes Reply-To, so when the new employee hits reply they reach
// their own admin rather than Vocera support.
export async function sendInviteEmail({ to, businessName, inviterName, inviterEmail, role, url }) {
  const biz = businessName || 'your team'
  return sendEmail({
    to,
    ...renderInviteEmail({ businessName: biz, inviterName, role, url }),
    // "Sunrise Realty via Vocera" — the business is who they recognise, and "via
    // Vocera" is what stops it reading as a phishing attempt from an unknown domain.
    fromName: `${biz} via Vocera`,
    replyTo: inviterEmail || undefined,
  })
}
