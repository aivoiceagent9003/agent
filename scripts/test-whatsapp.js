// scripts/test-whatsapp.js — send a test WhatsApp, or list your approved templates.
// Much faster than dialing to debug setup (env, template name, language, token).
//
// Usage:
//   node scripts/test-whatsapp.js list                             → list templates (needs WHATSAPP_WABA_ID)
//   node scripts/test-whatsapp.js +919003503664                    → confirmation template
//   node scripts/test-whatsapp.js +919003503664 document <docId>   → document template
//
// <docId> is a row id from whatsapp_documents (the WhatsApp page's own document
// store — NOT a knowledge-base document). Needs TEST_TENANT_ID set in .env.
//
// Prints the resolved platform config first, then the provider's raw error on failure.

import 'dotenv/config'
import { platformCfg, sendConfirmation, sendDocument } from '../src/services/whatsapp.js'

const arg1 = process.argv[2]
const kind = (process.argv[3] || 'confirmation').toLowerCase()
const docId = process.argv[4]

const cfg = platformCfg()
const mask = (s) => (s ? `${String(s).slice(0, 6)}…(${String(s).length} chars)` : '(EMPTY)')
console.log('─── platform WhatsApp config ───')
console.log('provider          :', cfg.provider)
console.log('phone_number_id   :', cfg.phone_number_id || '(EMPTY)')
console.log('token             :', mask(cfg.token))
console.log('default_language  :', cfg.default_language)
console.log('template document :', cfg.templates.document || '(EMPTY)')
console.log('template confirm  :', cfg.templates.confirmation || '(EMPTY)')
console.log('params document   :', cfg.params.document.join(','))
console.log('params confirm    :', cfg.params.confirmation.join(','))
console.log('────────────────────────────────')

// ─── list mode: show the exact template names + languages Meta has ───────────
async function listTemplates() {
  const waba = process.env.WHATSAPP_WABA_ID
  if (!waba) {
    console.error('\n❌ Set WHATSAPP_WABA_ID in .env to list templates.')
    console.error('   Find it in Meta: WhatsApp → API Setup (WhatsApp Business Account ID).')
    process.exitCode = 1
    return
  }
  const base = (cfg.api_base || 'https://graph.facebook.com/v21.0').replace(/\/$/, '')
  const url = `${base}/${waba}/message_templates?limit=100&access_token=${encodeURIComponent(cfg.token)}`
  const res = await fetch(url)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error('\n❌ Could not list templates:', JSON.stringify(json.error || json, null, 2))
    process.exitCode = 1
    return
  }
  const rows = json.data || []
  if (!rows.length) { console.log('\n(no templates found)'); return }
  console.log('\nname                            language   status      body vars')
  console.log('─────────────────────────────────────────────────────────────────')
  for (const t of rows) {
    const body = (t.components || []).find((c) => c.type === 'BODY')
    const vars = body?.text ? (body.text.match(/\{\{\d+\}\}/g) || []).length : 0
    const hasHeaderDoc = (t.components || []).some((c) => c.type === 'HEADER' && c.format === 'DOCUMENT')
    console.log(
      `${String(t.name).padEnd(31)} ${String(t.language).padEnd(10)} ${String(t.status).padEnd(11)} ${vars}${hasHeaderDoc ? '  + doc header' : ''}`
    )
  }
  console.log('\nUse the exact name + language above in WHATSAPP_TEMPLATE_* and WHATSAPP_DEFAULT_LANG.')

  // Templates are scoped to a WABA. If our sending number lives in a DIFFERENT WABA,
  // Meta reports "template does not exist" even though you can see it in the UI.
  const pnRes = await fetch(`${base}/${waba}/phone_numbers?access_token=${encodeURIComponent(cfg.token)}`)
  const pnJson = await pnRes.json().catch(() => ({}))
  if (!pnRes.ok) {
    console.error('\n⚠️  Could not list phone numbers:', JSON.stringify(pnJson.error || pnJson, null, 2))
    return
  }
  const nums = pnJson.data || []
  console.log('\nPhone numbers in THIS WhatsApp Business Account:')
  for (const n of nums) console.log(`  ${String(n.id).padEnd(20)} ${n.display_phone_number || ''}  ${n.verified_name || ''}`)
  const match = nums.some((n) => String(n.id) === String(cfg.phone_number_id))
  console.log(
    match
      ? `\n✅ WHATSAPP_PHONE_NUMBER_ID (${cfg.phone_number_id}) IS in this WABA — templates should resolve.`
      : `\n❌ MISMATCH: WHATSAPP_PHONE_NUMBER_ID (${cfg.phone_number_id}) is NOT in this WABA.\n   That's why the template "does not exist" — use one of the IDs listed above.`
  )
}

async function sendTest() {
  const to = arg1
  const missing = []
  if (!cfg.phone_number_id) missing.push('WHATSAPP_PHONE_NUMBER_ID')
  if (!cfg.token) missing.push('WHATSAPP_TOKEN')
  if (kind === 'confirmation' && !cfg.templates.confirmation) missing.push('WHATSAPP_TEMPLATE_CONFIRMATION')
  if (kind === 'document' && !cfg.templates.document) missing.push('WHATSAPP_TEMPLATE_DOCUMENT')
  if (missing.length) {
    console.error('\n❌ Missing env:', missing.join(', '))
    process.exitCode = 1
    return
  }

  const who = { customerName: 'Madhusudhan', businessName: 'My Home Projects', businessPhone: '+919003503664' }
  try {
    let res
    if (kind === 'document') {
      if (!docId) { console.error('document test needs a docId: node scripts/test-whatsapp.js <phone> document <docId>'); process.exitCode = 1; return }
      res = await sendDocument({ tenantId: process.env.TEST_TENANT_ID, cfg, to, docId, who, about: 'brochure for My Home Apas', topic: 'My Home Apas' })
    } else {
      res = await sendConfirmation({ cfg, to, who, about: 'site visit to My Home Akara', topic: 'My Home Akara', date: '10/12/2026', time: '12:00 PM' })
    }
    console.log('\n✅ Sent. message id:', res.id)
  } catch (e) {
    console.error('\n❌ Send failed:\n', e.message)
    console.error('\nTip: error 132001 = the template name or LANGUAGE does not match.')
    console.error('     Run `node scripts/test-whatsapp.js list` to see the exact names + languages.')
    process.exitCode = 1
  }
}

if (arg1 === 'list') await listTemplates()
else if (!arg1) {
  console.error('\nUsage: node scripts/test-whatsapp.js <+phone> [confirmation|document] [docId]')
  console.error('       node scripts/test-whatsapp.js list')
  process.exitCode = 1
} else await sendTest()
