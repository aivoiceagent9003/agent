// api/signup.js — Self-serve client signup
// Creates: auth user → tenant → profile (linking user to the tenant as 'client').
// This is the convergence point in the flow: signing up provisions the tenant.
//
// IMPORTANT: this uses the Supabase SERVICE ROLE key (admin) to create the auth
// user and bypass RLS for provisioning. Keep SUPABASE_SERVICE_ROLE_KEY server-side
// only — never expose it to the frontend.

import { Router } from 'express'
import { supabaseAdmin } from './db.js'
import { sendWelcomeEmail } from '../services/email.js'
import 'dotenv/config'

// Service-role client (full access) — used ONLY for provisioning new accounts.
const admin = supabaseAdmin

const router = Router()

// POST /api/signup
// body: { email, password, business_name }
// Creates the account + tenant + profile, returns the tenant id.
router.post('/', async (req, res) => {
  const { email, password, business_name } = req.body || {}
  if (!email || !password || !business_name) {
    return res.status(400).json({ error: 'email, password, and business_name are required' })
  }
  if (!admin) {
    console.error('[SIGNUP] SUPABASE_SERVICE_ROLE_KEY not set — signup disabled')
    return res.status(500).json({ error: 'Signup is not configured. Contact support.' })
  }

  let userId = null
  let tenantId = null

  try {
    // 1. Create the auth user (email confirmed so they can log in immediately)
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (userErr || !created?.user) {
      return res.status(400).json({ error: userErr?.message || 'Could not create account' })
    }
    userId = created.user.id

    // 2. Create the tenant (their agent starts as a draft, no phone number yet)
    const { data: tenant, error: tErr } = await admin
      .from('tenants')
      .insert({
        name: business_name,
        phone_number: null,           // they'll set this in the builder
        config: { status: 'draft', business_name },
      })
      .select('id')
      .single()
    if (tErr || !tenant) throw new Error(tErr?.message || 'Could not create tenant')
    tenantId = tenant.id

    // 3. Link the user to the tenant as a client
    const { error: pErr } = await admin
      .from('profiles')
      .insert({ id: userId, role: 'client', tenant_id: tenantId, email })
    if (pErr) throw new Error(pErr.message)

    // Welcome email — fire-and-forget (never throws, never delays the response).
    sendWelcomeEmail({ to: email })

    res.status(201).json({
      success: true,
      tenant_id: tenantId,
      message: 'Account created. You can now log in and configure your agent.',
    })
  } catch (e) {
    console.error('[SIGNUP] error:', e.message)
    // Best-effort cleanup so a half-created account doesn't linger
    if (tenantId) await admin.from('tenants').delete().eq('id', tenantId)
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {})
    res.status(500).json({ error: 'Signup failed. Please try again.' })
  }
})

export default router