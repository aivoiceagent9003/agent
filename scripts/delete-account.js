// scripts/delete-account.js — one-off cleanup to fully remove a signed-up account
// so the same email can register again.
//
// Deletes (in FK-safe order): knowledge_base → leads → calls → tenant → profile
// → the Supabase Auth user. Safe to re-run: anything already gone is skipped.
//
// Usage:
//   node scripts/delete-account.js someone@example.com
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env.

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const email = (process.argv[2] || '').trim().toLowerCase()
if (!email) {
  console.error('Usage: node scripts/delete-account.js <email>')
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

// Find the Auth user by email (paginate through the users list).
async function findAuthUser(targetEmail) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    const users = data?.users || []
    const match = users.find(u => (u.email || '').toLowerCase() === targetEmail)
    if (match) return match
    if (users.length < 200) break // last page
  }
  return null
}

async function run() {
  console.log(`\nCleaning up account: ${email}\n`)

  // 1. Resolve tenant_id from the profile (may already be deleted).
  let tenantId = null
  const { data: profile } = await admin
    .from('profiles')
    .select('id, tenant_id')
    .eq('email', email)
    .maybeSingle()
  if (profile?.tenant_id) tenantId = profile.tenant_id

  // 2. Resolve the auth user (the part the dashboard hides under Authentication).
  const authUser = await findAuthUser(email)

  // If we couldn't get tenant_id from the profile, try via the auth user id.
  if (!tenantId && authUser) {
    const { data: p2 } = await admin
      .from('profiles')
      .select('tenant_id')
      .eq('id', authUser.id)
      .maybeSingle()
    if (p2?.tenant_id) tenantId = p2.tenant_id
  }

  // 3. Delete tenant-scoped child rows, then the tenant.
  if (tenantId) {
    for (const table of ['knowledge_base', 'leads', 'calls']) {
      const { error, count } = await admin
        .from(table)
        .delete({ count: 'exact' })
        .eq('tenant_id', tenantId)
      if (error) console.warn(`  ! ${table}: ${error.message}`)
      else console.log(`  - ${table}: removed ${count ?? 0}`)
    }
    const { error: tErr } = await admin.from('tenants').delete().eq('id', tenantId)
    console.log(tErr ? `  ! tenants: ${tErr.message}` : `  - tenants: removed (${tenantId})`)
  } else {
    console.log('  - no tenant found (already deleted)')
  }

  // 4. Delete the profile row (by email, and by id if we have the auth user).
  await admin.from('profiles').delete().eq('email', email)
  if (authUser) await admin.from('profiles').delete().eq('id', authUser.id)
  console.log('  - profiles: removed')

  // 5. Delete the Auth user — the one that blocks re-registration.
  if (authUser) {
    const { error } = await admin.auth.admin.deleteUser(authUser.id)
    console.log(error ? `  ! auth user: ${error.message}` : `  - auth user: removed (${authUser.id})`)
  } else {
    console.log('  - auth user: not found (already deleted)')
  }

  console.log(`\nDone. "${email}" can now register again.\n`)
}

run().catch(e => {
  console.error('\nFailed:', e.message)
  process.exit(1)
})
