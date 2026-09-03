// api/public.js — Public (no-auth) endpoints
import { Router } from 'express'
import crypto from 'node:crypto'
import { supabase, supabaseAuth, supabaseAdmin } from './db.js'
import { listDemoSectors } from '../telephony/demo.js'
import { sendWelcomeEmail } from '../services/email.js'
const router = Router()

// Sectors offered by the live demo on the marketing site. The visitor picks one,
// then opens /demo-stream to actually talk to that agent.
router.get('/demo/sectors', (_req, res) => res.json(listDemoSectors()))

// Contact / "book a demo" form submission
router.post('/contact', async (req, res) => {
  const { name, email, company, message } = req.body || {}
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' })
  }
  const { error } = await supabase
    .from('contacts')
    .insert({ name, email, company: company || null, message: message || null })
  if (error) {
    console.error('[PUBLIC] contact insert error:', error.message)
    return res.status(500).json({ error: 'Could not submit. Please try again.' })
  }
  res.json({ success: true })
})

// ─── Employee invite acceptance ───────────────────────────────────────────────
// These two endpoints are public because the invitee, by definition, has no
// account yet. The token IS the authorization — so it is single-use, expires in
// 7 days, and is stored only as a SHA-256 hash (see src/api/team.js).

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

// Look up a live invite by its raw token. Returns null for anything unusable —
// unknown, revoked, already accepted, or expired — so callers can't distinguish
// between those cases and probe for valid tokens.
async function liveInvite(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null
  const { data } = await supabase
    .from('invitations')
    .select('id, tenant_id, email, tenant_role, invited_by, expires_at, accepted_at, revoked_at')
    .eq('token_hash', hashToken(rawToken))
    .maybeSingle()
  if (!data) return null
  if (data.accepted_at || data.revoked_at) return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data
}

// GET /api/public/invite/:token — render the join page ("Acme invited you as Agent")
router.get('/invite/:token', async (req, res) => {
  const invite = await liveInvite(req.params.token)
  if (!invite) {
    return res.status(410).json({ error: 'This invite link is no longer valid. Ask your admin to send a new one.' })
  }
  const { data: tenant } = await supabase
    .from('tenants').select('name, config').eq('id', invite.tenant_id).single()

  res.json({
    email: invite.email,
    tenant_role: invite.tenant_role,
    business_name: tenant?.config?.business_name || tenant?.name || 'your team',
    expires_at: invite.expires_at,
  })
})

// POST /api/public/invite/:token/accept
//   body: { credential }            → Google sign-in
//   body: { password, full_name }   → email + password
//
// Creates the auth user, links it to the inviting tenant with the invited role,
// and burns the invite. Returns a session token so the browser lands signed in.
router.post('/invite/:token/accept', async (req, res) => {
  const invite = await liveInvite(req.params.token)
  if (!invite) {
    return res.status(410).json({ error: 'This invite link is no longer valid. Ask your admin to send a new one.' })
  }
  if (!supabaseAdmin) {
    console.error('[INVITE] SUPABASE_SERVICE_ROLE_KEY not set — cannot provision')
    return res.status(500).json({ error: 'Account setup is not configured. Contact support.' })
  }

  const { credential, password, full_name: fullName } = req.body || {}
  let userId = null
  let sessionToken = null
  // Invited teammates get a real session too, so they need the refresh token as
  // much as anyone else — without it they alone would still be signed out hourly.
  let sessionRefresh = null
  let sessionExpires = null
  let createdUser = false

  try {
    if (credential) {
      // Google path. Supabase verifies the ID token with Google and creates-or-
      // returns the auth user.
      const { data, error } = await supabaseAuth.auth.signInWithIdToken({
        provider: 'google', token: credential,
      })
      if (error || !data?.user || !data?.session) {
        return res.status(401).json({ error: 'Google sign-in failed. Please try again.' })
      }

      // CRITICAL: the invite is for ONE person. Without this check the link would
      // be a free account for anyone who obtained it.
      if (String(data.user.email || '').toLowerCase() !== invite.email.toLowerCase()) {
        return res.status(403).json({
          error: `This invite was sent to ${invite.email}. Please sign in with that Google account.`,
        })
      }
      userId = data.user.id
      sessionToken = data.session.access_token
      sessionRefresh = data.session.refresh_token || null
      sessionExpires = data.session.expires_at || null
    } else if (password) {
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' })
      }
      const { data: created, error: userErr } = await supabaseAdmin.auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,   // the invite email already proved they own the address
      })
      if (userErr || !created?.user) {
        return res.status(400).json({ error: userErr?.message || 'Could not create your account' })
      }
      userId = created.user.id
      createdUser = true

      const { data: signedIn } = await supabaseAuth.auth.signInWithPassword({
        email: invite.email, password,
      })
      sessionToken = signedIn?.session?.access_token || null
      sessionRefresh = signedIn?.session?.refresh_token || null
      sessionExpires = signedIn?.session?.expires_at || null
    } else {
      return res.status(400).json({ error: 'Choose a password or sign in with Google' })
    }

    // One user belongs to one business in this model. If they already have a
    // profile elsewhere, say so rather than silently moving them.
    const { data: existingProfile } = await supabase
      .from('profiles').select('id, tenant_id').eq('id', userId).maybeSingle()
    if (existingProfile && existingProfile.tenant_id && existingProfile.tenant_id !== invite.tenant_id) {
      return res.status(409).json({
        error: 'This account already belongs to another business. Use a different email address.',
      })
    }

    const profile = {
      id: userId,
      role: 'client',                 // platform level: a tenant user, not AnswerLabs staff
      tenant_id: invite.tenant_id,
      tenant_role: invite.tenant_role,
      email: invite.email,
      full_name: fullName || null,
      invited_by: invite.invited_by || null,
      status: 'active',
    }
    const { error: pErr } = existingProfile
      ? await supabaseAdmin.from('profiles').update(profile).eq('id', userId)
      : await supabaseAdmin.from('profiles').insert(profile)
    if (pErr) throw new Error(pErr.message)

    // Burn the invite. The `is('accepted_at', null)` guard makes this the single
    // point where a race between two simultaneous accepts is resolved.
    const { data: burned } = await supabaseAdmin.from('invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id).is('accepted_at', null)
      .select('id')
    if (!burned || !burned.length) {
      return res.status(410).json({ error: 'This invite has already been used.' })
    }

    sendWelcomeEmail({ to: invite.email, name: fullName || '' })

    res.status(201).json({
      token: sessionToken,
      refresh_token: sessionRefresh,
      expires_at: sessionExpires,
      role: 'client',
      tenant_role: invite.tenant_role,
      tenant_id: invite.tenant_id,
    })
  } catch (e) {
    console.error('[INVITE] accept error:', e.message)
    // Only clean up a user WE created — never delete a pre-existing Google account.
    if (createdUser && userId) await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {})
    res.status(500).json({ error: 'Could not complete your signup. Please try again.' })
  }
})

export default router