// api/signup.js — Self-serve client signup
// Creates: auth user → tenant → profile (linking user to the tenant as 'client').
// This is the convergence point in the flow: signing up provisions the tenant.
//
// IMPORTANT: this uses the Supabase SERVICE ROLE key (admin) to create the auth
// user and bypass RLS for provisioning. Keep SUPABASE_SERVICE_ROLE_KEY server-side
// only — never expose it to the frontend.

import { Router } from 'express'
import { supabaseAdmin, supabaseAuth } from './db.js'
import { sendWelcomeEmail } from '../services/email.js'
import 'dotenv/config'

// Service-role client (full access) — used ONLY for provisioning new accounts.
const admin = supabaseAdmin

// Self-serve PASSWORD signup is disabled by default.
//
// Signup is Google-only in this product — frontend/src/routes/signup.tsx offers a
// Google button and nothing else, and no UI calls this endpoint. The route stayed
// mounted and public anyway, creating accounts with email_confirm:true: anyone
// could register an address they did not own and have it treated as verified.
// An endpoint no interface uses, handing out pre-confirmed accounts for other
// people's email addresses, should not stay open for nobody.
//
// Set ALLOW_PASSWORD_SIGNUP=true to re-enable it. When enabled, it now requires a
// real email confirmation before the account can be used for anything.
const PASSWORD_SIGNUP_ENABLED = process.env.ALLOW_PASSWORD_SIGNUP === 'true'

const router = Router()

// POST /api/signup
// body: { email, password, business_name }
// Creates the account + tenant + profile, returns the tenant id.
router.post('/', async (req, res) => {
  if (!PASSWORD_SIGNUP_ENABLED) {
    return res.status(403).json({
      error: 'Password signup is disabled. Please sign up with Google.',
    })
  }
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
    // 1. Create the auth user, UNCONFIRMED. Anyone can post any address here, so
    // until they prove they can read that inbox the account must not be usable.
    // Supabase refuses sign-in for an unconfirmed user, which is the enforcement.
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
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

    // 4. Ask Supabase to send its confirmation email. Same mechanism the password
    // reset already uses (resetPasswordForEmail), so it needs no extra setup.
    //
    // A failure here is logged, NOT fatal: the account exists and is correctly
    // unusable, and tearing down a valid signup because one email bounced would
    // be worse than letting them request the link again.
    let appUrl = process.env.APP_URL || 'http://localhost:8080'
    if (appUrl.endsWith('/')) appUrl = appUrl.slice(0, -1)
    try {
      const { error: mailErr } = await supabaseAuth.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${appUrl}/login` },
      })
      if (mailErr) console.error('[SIGNUP] confirmation email failed:', mailErr.message)
    } catch (e) {
      console.error('[SIGNUP] confirmation email failed:', e.message)
    }

    // Welcome email — fire-and-forget (never throws, never delays the response).
    sendWelcomeEmail({ to: email })

    res.status(201).json({
      success: true,
      tenant_id: tenantId,
      message: 'Account created. Check your email to confirm the address, then log in.',
      email_confirmation_required: true,
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