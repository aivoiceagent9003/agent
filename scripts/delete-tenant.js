// scripts/delete-tenant.js — remove a tenant (and everything under it) by ID.
//
// The counterpart to delete-account.js (which is keyed by email). Use this when
// you have the tenant's UUID — e.g. from the admin dashboard or a DB row.
//
// Deletes (in FK-safe order): knowledge_base → lookup_rows → leads → calls →
// tenant → its profile(s) → the linked Supabase Auth user(s). Safe to re-run.
//
// Usage:
//   node scripts/delete-tenant.js <tenant_id>
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env.

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const tenantId = (process.argv[2] || '').trim()
if (!tenantId) {
  console.error('Usage: node scripts/delete-tenant.js <tenant_id>')
  process.exit(1)
}

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function run() {
  console.log(`\nDeleting tenant: ${tenantId}\n`)

  // 1. Confirm the tenant exists (and show its name so you don't nuke the wrong one).
  const { data: tenant, error: tLookup } = await admin
    .from('tenants')
    .select('id, name, phone_number')
    .eq('id', tenantId)
    .maybeSingle()
  if (tLookup) { console.error(`Lookup failed: ${tLookup.message}`); process.exit(1) }
  if (!tenant) { console.log('No tenant with that ID (already deleted?). Nothing to do.\n'); return }
  console.log(`  Found: "${tenant.name}" (${tenant.phone_number || 'no number'})`)

  // 2. Resolve linked profiles + their auth user ids BEFORE deleting the tenant.
  const { data: profiles } = await admin
    .from('profiles')
    .select('id, email')
    .eq('tenant_id', tenantId)
  const authIds = (profiles || []).map(p => p.id).filter(Boolean)

  // 3. Delete tenant-scoped child rows, then the tenant.
  for (const table of ['knowledge_base', 'lookup_rows', 'leads', 'calls']) {
    const { error, count } = await admin
      .from(table)
      .delete({ count: 'exact' })
      .eq('tenant_id', tenantId)
    if (error) console.warn(`  ! ${table}: ${error.message}`)
    else console.log(`  - ${table}: removed ${count ?? 0}`)
  }
  const { error: tErr } = await admin.from('tenants').delete().eq('id', tenantId)
  console.log(tErr ? `  ! tenants: ${tErr.message}` : `  - tenants: removed (${tenantId})`)

  // 4. Delete the profile row(s).
  const { error: pErr } = await admin.from('profiles').delete().eq('tenant_id', tenantId)
  console.log(pErr ? `  ! profiles: ${pErr.message}` : `  - profiles: removed ${authIds.length}`)

  // 5. Delete the linked Auth user(s) — the part that blocks re-registration.
  for (const id of authIds) {
    const { error } = await admin.auth.admin.deleteUser(id)
    console.log(error ? `  ! auth user ${id}: ${error.message}` : `  - auth user: removed (${id})`)
  }
  if (!authIds.length) console.log('  - auth user: none linked')

  console.log(`\nDone. Tenant "${tenant.name}" fully removed.\n`)
}

run().catch(e => {
  console.error('\nFailed:', e.message)
  process.exit(1)
})
