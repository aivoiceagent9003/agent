// scripts/test-email.js — verify SMTP setup without running a real invite.
//
// Usage:
//   node scripts/test-email.js                      → show resolved config only
//   node scripts/test-email.js you@gmail.com        → send a test invite email
//   node scripts/test-email.js you@gmail.com welcome → send the welcome email instead
//
// Prints the resolved config first (secrets masked), then the transport's raw
// error on failure — which is what you actually need to debug auth problems.

import 'dotenv/config'
import { emailReady, sendInviteEmail, sendWelcomeEmail, renderInviteEmail } from '../src/services/email.js'

const to = process.argv[2]
const kind = (process.argv[3] || 'invite').toLowerCase()

const mask = (s) => (s ? `${String(s).slice(0, 4)}…(${String(s).length} chars)` : '(EMPTY)')
const show = (s) => s || '(EMPTY)'

console.log('─── resolved email config ───')
console.log('SMTP_HOST  :', show(process.env.SMTP_HOST))
console.log('SMTP_PORT  :', process.env.SMTP_PORT || '587 (default)')
console.log('SMTP_USER  :', show(process.env.SMTP_USER))
console.log('SMTP_PASS  :', mask(process.env.SMTP_PASS))
console.log('EMAIL_FROM :', process.env.EMAIL_FROM || `(falls back to SMTP_USER: ${show(process.env.SMTP_USER)})`)
console.log('APP_URL    :', process.env.APP_URL || 'http://localhost:8080 (default)')
console.log('emailReady :', emailReady())
console.log()

if (!emailReady()) {
  console.error('❌ SMTP is NOT configured — SMTP_HOST, SMTP_USER and SMTP_PASS must all be set.')
  console.error('   Until then every email silently no-ops (invites still work via the copy-link.)')
  console.error('   See EMAIL_SENDING.md for setup steps.')
  process.exit(1)
}

if (!to) {
  console.log('✅ Config looks complete. Pass an address to actually send:')
  console.log('   node scripts/test-email.js you@example.com')
  process.exit(0)
}

// Show exactly what the recipient will see before sending.
const sampleUrl = `${(process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '')}/join?token=TEST-TOKEN`
if (kind === 'invite') {
  const { subject } = renderInviteEmail({
    businessName: 'Sunrise Realty',
    inviterName: 'Madhusudhan',
    role: 'agent',
    url: sampleUrl,
  })
  console.log('─── sending ───')
  console.log('to      :', to)
  console.log('subject :', subject)
  console.log('from    : "Sunrise Realty via Vocera" <' + (process.env.EMAIL_FROM || process.env.SMTP_USER) + '>')
  console.log('replyTo : owner@sunriserealty.in')
  console.log('link    :', sampleUrl)
  console.log()
}

const ok = kind === 'welcome'
  ? await sendWelcomeEmail({ to, name: 'Test' })
  : await sendInviteEmail({
      to,
      businessName: 'Sunrise Realty',
      inviterName: 'Madhusudhan',
      inviterEmail: 'owner@sunriserealty.in',
      role: 'agent',
      url: sampleUrl,
    })

if (ok) {
  console.log(`✅ Sent. Check ${to} (including spam).`)
  console.log('   The link above is a fake token — it will say "invite link is no longer valid".')
  console.log('   That is expected: it proves delivery, not the invite flow.')
} else {
  console.error('❌ Send failed. The transport error is logged above by src/services/email.js.')
  console.error('   Most common causes:')
  console.error('     • Gmail: used the account password instead of a 16-char App Password')
  console.error('     • Gmail: 2-Step Verification not enabled (App Passwords need it)')
  console.error('     • Wrong port: 587 = STARTTLS, 465 = implicit TLS')
  console.error('     • Resend: SMTP_USER must be the literal string "resend"')
  process.exit(1)
}
