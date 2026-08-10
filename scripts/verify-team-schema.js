// scripts/verify-team-schema.js — confirm sql/team.sql actually applied.
//
// Checks the columns and tables the employee-access feature depends on, so a
// partly-applied migration shows up here instead of as a confusing 500 at sign-in.
//
// Usage: node scripts/verify-team-schema.js

import 'dotenv/config'
import { supabase } from '../src/api/db.js'

let failures = 0

// Selecting a column is the cheapest existence check that works through PostgREST.
async function checkColumns(table, columns) {
  const { error } = await supabase.from(table).select(columns.join(',')).limit(1)
  const ok = !error
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${table} (${columns.join(', ')})`)
  if (!ok) console.log(`       ↳ ${error.message}`)
  return ok
}

async function checkTable(table) {
  const { error } = await supabase.from(table).select('*').limit(1)
  const ok = !error
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} table ${table}`)
  if (!ok) console.log(`       ↳ ${error.message}`)
  return ok
}

console.log('─── sql/team.sql verification ───\n')

console.log('profiles — the columns auth.js selects on every request:')
await checkColumns('profiles', ['id', 'role', 'tenant_id', 'tenant_role', 'email', 'full_name', 'status'])
await checkColumns('profiles', ['invited_by', 'last_seen_at'])

console.log('\ninvitations:')
await checkTable('invitations')
await checkColumns('invitations', ['id', 'tenant_id', 'email', 'tenant_role', 'token_hash', 'expires_at', 'accepted_at', 'revoked_at'])

console.log('\nleads — workflow columns:')
await checkColumns('leads', ['id', 'status', 'assigned_to', 'notes', 'updated_at'])

console.log('\nlead_activity:')
await checkTable('lead_activity')
await checkColumns('lead_activity', ['lead_id', 'tenant_id', 'actor_id', 'action', 'detail'])

// Backfill sanity: every existing user must have a role, or they lose access.
console.log('\nbackfill:')
const { data: profiles, error: pErr } = await supabase
  .from('profiles').select('id, email, tenant_role, status')
if (pErr) {
  failures++
  console.log('  FAIL could not read profiles —', pErr.message)
} else {
  const missing = (profiles || []).filter(p => !p.tenant_role)
  const owners = (profiles || []).filter(p => p.tenant_role === 'owner').length
  console.log(`  ${missing.length === 0 ? 'ok  ' : 'FAIL'} ${profiles.length} profile(s), ${owners} owner(s), ${missing.length} missing tenant_role`)
  if (missing.length) {
    failures++
    console.log('       ↳ these users cannot sign in:', missing.map(p => p.email).join(', '))
  }
  const suspended = (profiles || []).filter(p => p.status === 'suspended')
  if (suspended.length) console.log(`  note  ${suspended.length} suspended account(s) — they are blocked from signing in by design`)
}

console.log()
if (failures) {
  console.error(`❌ ${failures} check(s) failed — re-run sql/team.sql in the Supabase SQL editor.`)
  process.exit(1)
}
console.log('✅ Schema is in place. Employee access is ready to test.')
process.exit(0)
