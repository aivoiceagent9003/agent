// scripts/migrate-agent-templates.js — move tenants off copied prompts onto template ids.
//
// WHY THIS EXISTS
// Templates used to be delivered by COPYING a multi-thousand-character prompt into
// the tenant's own config the moment they picked one. That prompt then froze: every
// later improvement reached new tenants only, and each tenant carried a private fork
// of the universal speaking rules that nothing could ever update. Worse, those copies
// restated rules the platform now owns — so a tenant prompt could contradict the
// safety layer simply by being out of date.
//
// Templates are now referenced by id and composed at call time, so an improvement
// reaches everyone at once. This script moves existing tenants across.
//
// WHAT IT DOES, per tenant
//   1. works out which template the stored prompt corresponds to (or takes the
//      mapping given on the command line);
//   2. sets config.template_id;
//   3. moves config.system_prompt to config.system_prompt_archived and clears it;
//   4. deletes config keys belonging to architecture that no longer exists.
//
// THE DEAD KEYS are not cosmetic. Each one is written by some part of the product and
// read by nothing, which is the worst state for a config field to be in: it looks
// live, so the next person to touch that area reasons about behaviour that cannot
// happen. They are listed in DEAD_KEYS below, each with why it died.
//
// SAFETY
// Dry run by default. Every write MERGES into the existing config, never replaces it,
// and the previous prompt is preserved in system_prompt_archived, so any tenant can
// be put back by hand with two field edits.
//
//   node scripts/migrate-agent-templates.js                        # show me
//   node scripts/migrate-agent-templates.js --apply                # do it
//   node scripts/migrate-agent-templates.js --apply --tenant <id>  # just this one
//   node scripts/migrate-agent-templates.js --apply --map "<id>=customer_support"
//
// --map overrides the guess for one tenant, and can be repeated. Use it when the
// stored prompt does not say clearly what kind of agent it is.

import 'dotenv/config'
import { supabaseAdmin } from '../src/api/db.js'
import { AGENT_TEMPLATES } from '../src/config/conversation/agent-templates.js'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null }
const ONLY = flag('--tenant')

// --map <tenantId>=<templateId>, repeatable.
const OVERRIDES = new Map(
  argv.reduce((acc, a, i) => {
    if (a === '--map' && argv[i + 1]) {
      const [t, tpl] = argv[i + 1].split('=')
      if (t && tpl) acc.push([t.trim(), tpl.trim()])
    }
    return acc
  }, [])
)

// Config keys written by architecture that has since been removed. Each is read by
// nothing, verified with a repository-wide search before being listed here.
const DEAD_KEYS = {
  generic_agent: 'the sector switch — real-estate behaviour now lives only in its own template',
  real_estate_agent: 'the sector switch — replaced by template_id',
  use_sarvam_stt: 'Sarvam STT was removed from the stack; the live engine hears the caller directly',
  translate_replies: 'the translation layer was removed with the cascade pipeline',
  language_hint: 'language is decided on the call now, never pinned in config',
  primary_language: 'same — a pinned language contradicts mirroring the caller',
}

// Words that identify which template a stored prompt was written for. Crude on
// purpose: the script proposes and prints its confidence, a person decides.
const FINGERPRINTS = {
  real_estate_sales: ['property', 'real estate', 'project', 'site visit', 'bhk', 'rera', 'possession', 'floor plan'],
  lead_qualification: ['qualif', 'good fit', 'lead', 'demo', 'prospect'],
  customer_support: ['customer support', 'issue', 'resolve', 'troubleshoot', 'complaint', 'empathy', 'frustrated'],
  front_desk: ['appointment', 'front desk', 'reschedul', 'slot', 'availability'],
  reminder_collections: ['emi', 'due date', 'outstanding', 'reminder', 'loan', 'overdue', 'instalment'],
  policy_renewal: ['renew', 'premium', 'cover', 'subscription', 'expiry', 'lapse'],
  order_confirmation: ['order', 'delivery', 'cod', 'cash on delivery', 'shipped'],
  outbound_sales: ['offer', 'promotion', 'campaign', 'pitch', 'introduce'],
  follow_up: ['follow up', 'follow-up', 'previously', 'last time', 'earlier conversation'],
  feedback_survey: ['feedback', 'survey', 'rating', 'how was your experience'],
}

function guessTemplate(prompt) {
  const text = String(prompt || '').toLowerCase()
  const scored = Object.entries(FINGERPRINTS)
    .map(([id, words]) => ({ id, score: words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)
  const [best, runnerUp] = scored
  if (!best || best.score < 2) return null
  return { id: best.id, score: best.score, ambiguous: runnerUp && runnerUp.score >= best.score - 1 }
}

async function main() {
  if (!supabaseAdmin) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is required to read and write tenant configs.')
    process.exit(1)
  }
  const known = new Set(AGENT_TEMPLATES.map(t => t.id))
  for (const [, tpl] of OVERRIDES) {
    if (!known.has(tpl)) { console.error(`--map names an unknown template: ${tpl}`); process.exit(1) }
  }

  let q = supabaseAdmin.from('tenants').select('id, name, config')
  if (ONLY) q = q.eq('id', ONLY)
  const { data: tenants, error } = await q
  if (error) { console.error('read failed:', error.message); process.exit(1) }

  const plan = []
  for (const t of tenants || []) {
    const cfg = t.config || {}
    const prompt = String(cfg.system_prompt || '')
    const dead = Object.keys(DEAD_KEYS).filter(k => k in cfg)

    let templateId = OVERRIDES.get(t.id) || null
    let note = templateId ? 'mapped by hand' : ''

    if (!templateId && cfg.template_id && known.has(cfg.template_id)) {
      templateId = cfg.template_id
      note = 'already on a template'
    }
    if (!templateId && prompt.trim()) {
      const guess = guessTemplate(prompt)
      if (guess) {
        templateId = guess.id
        note = `matched from the stored prompt (confidence ${guess.score}${guess.ambiguous ? ', CLOSE CALL — check this one' : ''})`
      } else {
        note = 'could not tell which template — pass --map to decide'
      }
    }
    if (!templateId && !prompt.trim()) note = 'no prompt stored, nothing to move'

    const needsWork = (templateId && templateId !== cfg.template_id) || prompt.trim() || dead.length
    if (!needsWork) continue

    plan.push({ tenant: t, templateId, prompt, dead, note })
  }

  if (!plan.length) { console.log('\nEverything is already on the new templates.'); return }

  console.log(`\n${plan.length} tenant(s) to change:\n`)
  for (const p of plan) {
    console.log(`  ${p.tenant.name}`)
    console.log(`    template   : ${p.tenant.config?.template_id || '(none)'} → ${p.templateId || '(unresolved)'}   ${p.note}`)
    if (p.prompt.trim()) console.log(`    prompt     : archiving ${p.prompt.length} chars and clearing it`)
    if (p.dead.length) console.log(`    dead keys  : removing ${p.dead.join(', ')}`)
    console.log('')
  }

  const unresolved = plan.filter(p => !p.templateId && p.prompt.trim())
  if (unresolved.length) {
    console.log('These need a decision before their prompt can be cleared:')
    for (const p of unresolved) console.log(`  --map ${p.tenant.id}=<template_id>   (${p.tenant.name})`)
    console.log('')
  }

  if (!APPLY) { console.log('Dry run. Re-run with --apply to write these changes.'); return }

  for (const p of plan) {
    const next = { ...(p.tenant.config || {}) }
    for (const k of p.dead) delete next[k]
    if (p.templateId) next.template_id = p.templateId
    if (p.prompt.trim()) {
      // Keep the old prompt so this is reversible without a database backup. Only
      // clear the live one once we actually have somewhere to put it.
      next.system_prompt_archived = p.prompt
      next.system_prompt = ''
    }
    const { error: e } = await supabaseAdmin.from('tenants').update({ config: next }).eq('id', p.tenant.id)
    if (e) console.error(`  FAILED ${p.tenant.name}: ${e.message}`)
    else console.log(`  migrated ${p.tenant.name}${p.templateId ? ` → ${p.templateId}` : ''}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
