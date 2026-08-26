// scripts/alert-test.js — prove alert delivery works, before you need it to.
//
//   npm run alert:test
//
// The failure this prevents is specific and nasty: a webhook URL that is subtly
// wrong (revoked, wrong workspace, pasted with a trailing character) fails exactly
// like a system with no problems to report. Both are silence. The only way to tell
// them apart is to send something on purpose and go look.
//
// Sends one of each severity plus a resolve, so the channel's formatting, colours
// and threshold are all visible at once. force:true bypasses the cooldown and the
// severity filter — otherwise this script would itself be filtered and you would
// learn nothing.

import { notify, notifyConfigured, logNotifyConfig } from '../src/services/notify.js'
import 'dotenv/config'

const samples = [
  {
    title: 'Test alert — critical',
    body: 'This is a test from `npm run alert:test`. Nothing is wrong.\nIf you can read this, crash notifications will reach you.',
    severity: 'critical',
  },
  {
    title: 'Test alert — warning',
    body: 'Warnings are below the default threshold (ALERT_MIN_SEVERITY=critical),\nso in normal operation this one would NOT be sent.',
    severity: 'warning',
  },
  {
    title: 'RESOLVED: Test alert — critical',
    body: 'Cleared after 42s.',
    severity: 'critical',
  },
]

console.log('')
logNotifyConfig()
console.log('')

if (!notifyConfigured) {
  console.error('Nothing to test — no delivery channel is configured.')
  console.error('')
  console.error('  Slack:  create an Incoming Webhook at https://api.slack.com/messaging/webhooks')
  console.error('          then set ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...')
  console.error('  Email:  set ALERT_EMAIL_TO=you@example.com (needs SMTP_* configured)')
  console.error('')
  process.exit(1)
}

let delivered = 0
for (const s of samples) {
  const r = await notify({ ...s, force: true })
  const where = r.sent.length ? r.sent.join(' + ') : `NOT DELIVERED (${r.skipped || 'send failed'})`
  console.log(`  ${s.severity.padEnd(8)} ${s.title.padEnd(34)} → ${where}`)
  if (r.sent.length) delivered++
}

console.log('')
if (delivered === samples.length) {
  console.log(`✅ ${delivered}/${samples.length} delivered. Check the channel — you should see two alerts and one green resolve.`)
} else {
  console.error(`❌ ${delivered}/${samples.length} delivered. See the errors above.`)
}

// exitCode rather than process.exit(): forcing an exit while a keep-alive socket
// is still closing trips a libuv assertion on Windows, which prints after the
// success line and reads exactly like a failure. Setting the code and letting the
// loop drain gives the same exit status without the noise.
process.exitCode = delivered === samples.length ? 0 : 1
