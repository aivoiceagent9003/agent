// api/auth-routes.js — Login endpoint for the dashboard frontend.
// The rest of the API validates a Supabase JWT (see auth.js). This route is the
// one place that mints that JWT: it signs the user in with Supabase using the
// anon client and hands the access token back to the browser, along with the
// user's role + tenant so the frontend knows where to route them.

import { Router } from 'express'
import { supabase, supabaseAuth, supabaseAdmin } from './db.js'
import { sendWelcomeEmail } from '../services/email.js'
import 'dotenv/config'

const router = Router()

// Every session-issuing route returns this same shape. The access token expires
// in about an hour; refresh_token is what keeps the session alive past that, and
// expires_at (unix seconds) lets the client renew BEFORE a request fails rather
// than after one already has.
function sessionPayload(session) {
  return {
    token: session.access_token,
    refresh_token: session.refresh_token || null,
    expires_at: session.expires_at || null,
  }
}

// ─── Password reset ──────────────────────────────────────────────────────────
// Supabase sends the recovery email and hosts the token verification; we only
// kick it off and then apply the new password. Two endpoints:
//   POST /forgot { email }                    → email a recovery link
//   POST /reset  { access_token, password }   → set the new password
//
// The recovery link lands on APP_URL/reset-password with the session in the URL
// hash (implicit flow), which the frontend posts back here. Doing the update
// server-side keeps supabase-js out of the browser bundle entirely.

// POST /api/auth/forgot { email }
router.post('/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email) return res.status(400).json({ error: 'Email is required' })

  const appUrl = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '')
  try {
    await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/reset-password`,
    })
  } catch (e) {
    // Deliberately swallowed — see below.
    console.error('[AUTH] reset request failed:', e.message)
  }

  // ALWAYS the same response. Telling the caller whether an address is registered
  // turns this endpoint into an account-enumeration oracle.
  res.json({ ok: true })
})

// POST /api/auth/reset { access_token, password }
router.post('/reset', async (req, res) => {
  const { access_token: accessToken, password } = req.body || {}
  if (!accessToken || !password) {
    return res.status(400).json({ error: 'Missing reset token or password' })
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }
  if (!supabaseAdmin) {
    console.error('[AUTH] SUPABASE_SERVICE_ROLE_KEY not set — cannot reset passwords')
    return res.status(500).json({ error: 'Password reset is not configured. Contact support.' })
  }

  try {
    // The recovery access token IS the proof of identity — it only exists because
    // the user opened a link sent to their address.
    const { data: { user }, error } = await supabase.auth.getUser(accessToken)
    if (error || !user) {
      return res.status(401).json({ error: 'This reset link has expired. Request a new one.' })
    }

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password })
    if (updErr) throw new Error(updErr.message)

    res.json({ ok: true, email: user.email })
  } catch (e) {
    console.error('[AUTH] reset error:', e.message)
    res.status(500).json({ error: 'Could not reset your password. Please try again.' })
  }
})

// POST /api/auth/login  { email, password } -> { token, role, tenant_id }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  // Sign in against Supabase Auth. On success this returns a session whose
  // access_token is the same JWT the rest of the API expects in the
  // Authorization header.
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password })
  if (error || !data?.session) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  // Look up the profile so the frontend can route admins vs clients.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, tenant_id')
    .eq('id', data.user.id)
    .single()

  res.json({
    ...sessionPayload(data.session),
    role: profile?.role || 'client',
    tenant_id: profile?.tenant_id || null,
  })
})

// POST /api/auth/refresh { refresh_token } -> { token, refresh_token, expires_at, role, tenant_id }
//
// Access tokens last about an hour. Without this endpoint every user was signed
// out mid-task: the dashboard 401d and bounced them to /login, losing whatever
// they were in the middle of.
//
// Supabase ROTATES refresh tokens: the response carries a new one, and the old
// one keeps working only for a short reuse window (Supabase default: 10s, which
// exists so a burst of concurrent refreshes does not destroy a live session).
// Measured on this project — an immediate replay of the previous token still
// returns 200.
//
// So the client MUST persist what comes back here; storing only the access token
// leaves it holding a refresh token that dies once the window closes. The
// frontend also funnels refreshes through one shared promise: concurrent
// refreshes are wasteful round-trips that race each other to write localStorage,
// and any that land after the window has closed fail outright.
router.post('/refresh', async (req, res) => {
  const refreshToken = String(req.body?.refresh_token || '')
  if (!refreshToken) return res.status(400).json({ error: 'refresh_token is required' })

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data?.session) {
    // 401 rather than 500: the token is expired, revoked, or already rotated
    // away. That is the one outcome where the client SHOULD stop retrying and
    // send the user to /login, so it has to be distinguishable from a fault.
    return res.status(401).json({ error: 'Session expired. Please sign in again.' })
  }

  // Role and tenant can change between refreshes (a client promoted to admin, an
  // employee moved). Re-reading them here stops the frontend routing on a stale
  // role for as long as the session happens to live.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, tenant_id')
    .eq('id', data.user?.id)
    .maybeSingle()

  res.json({
    ...sessionPayload(data.session),
    role: profile?.role || 'client',
    tenant_id: profile?.tenant_id || null,
  })
})

// POST /api/auth/google  { credential } -> { token, role, tenant_id, is_new }
//
// "Sign in with Google". `credential` is the Google ID token from Google Identity
// Services on the frontend. We hand it to Supabase's signInWithIdToken, which
// verifies it with Google and creates-or-returns a Supabase auth user + session
// (the session's access_token is the same JWT the rest of the API expects).
//
// Google users who are new to us have no profile/tenant yet, so on first login we
// provision one (same shape as /api/signup) using their Google name as a
// placeholder business name — they'll set the real one in onboarding.
router.post('/google', async (req, res) => {
  const { credential } = req.body || {}
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential' })
  }

  // Verify the Google ID token and get/create the Supabase auth user + session.
  const { data, error } = await supabaseAuth.auth.signInWithIdToken({
    provider: 'google',
    token: credential,
  })
  if (error || !data?.session || !data?.user) {
    console.error('[GOOGLE AUTH] signInWithIdToken failed:', error?.message)
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' })
  }

  const user = data.user

  // Does this user already have a profile? If so, just return their token.
  const { data: existing } = await supabase
    .from('profiles')
    .select('role, tenant_id')
    .eq('id', user.id)
    .single()

  if (existing) {
    return res.json({
      ...sessionPayload(data.session),
      role: existing.role || 'client',
      tenant_id: existing.tenant_id || null,
      is_new: false,
    })
  }

  // First Google login for this user — provision a tenant + client profile.
  if (!supabaseAdmin) {
    console.error('[GOOGLE AUTH] SUPABASE_SERVICE_ROLE_KEY not set — cannot provision')
    return res.status(500).json({ error: 'Account provisioning is not configured. Contact support.' })
  }

  // Deliberately DON'T derive the business name from the Google account — the
  // user types their real business name during onboarding. `name` is NOT NULL, so
  // we seed a neutral placeholder that gets overwritten the moment they save
  // their business name (see PATCH /api/client/agent), and we leave
  // config.business_name unset so onboarding shows an empty field to fill in.
  let tenantId = null
  try {
    const { data: tenant, error: tErr } = await supabaseAdmin
      .from('tenants')
      .insert({
        name: 'New Business',
        phone_number: null,
        config: { status: 'draft' },
      })
      .select('id')
      .single()
    if (tErr || !tenant) throw new Error(tErr?.message || 'Could not create tenant')
    tenantId = tenant.id

    const { error: pErr } = await supabaseAdmin
      .from('profiles')
      .insert({ id: user.id, role: 'client', tenant_id: tenantId, email: user.email })
    if (pErr) throw new Error(pErr.message)

    // Welcome email — fire-and-forget. sendWelcomeEmail never throws, and we don't
    // await it so a slow SMTP server can't delay the signup response (or break it).
    const googleName = user.user_metadata?.full_name || user.user_metadata?.name || ''
    sendWelcomeEmail({ to: user.email, name: googleName })

    res.json({
      ...sessionPayload(data.session),
      role: 'client',
      tenant_id: tenantId,
      is_new: true,
    })
  } catch (e) {
    console.error('[GOOGLE AUTH] provisioning error:', e.message)
    if (tenantId) await supabaseAdmin.from('tenants').delete().eq('id', tenantId)
    res.status(500).json({ error: 'Could not finish setting up your account. Please try again.' })
  }
})

export default router
