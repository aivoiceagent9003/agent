// api/team.js — Team management (owner invites employees into their business).
//
// Mounted at /api/client/team. The tenant ALWAYS comes from req.auth.tenantId,
// never the request — same rule as the rest of the client API.
//
// INVITE SECURITY MODEL
//   • The raw token is generated here, emailed once, and never stored. Only its
//     SHA-256 hash goes in the database, so a DB leak cannot be replayed.
//   • Single use + 7-day expiry, both checked at acceptance time.
//   • Acceptance is bound to the invited email address (see api/public.js) — the
//     link is an invitation for ONE person, not a public signup coupon.
//
// Acceptance itself lives in api/public.js because the invitee is, by definition,
// not authenticated yet.

import { Router } from 'express'
import crypto from 'node:crypto'
import { supabase, supabaseAdmin } from './db.js'
import { requireClient } from './auth.js'
import { requirePermission, requireOwner, isValidRole, canAssignRole } from './permissions.js'
import { sendInviteEmail, emailReady } from '../services/email.js'
import 'dotenv/config'

const router = Router()
router.use(requireClient())

const INVITE_TTL_DAYS = 7
const EMAIL_SEND_TIMEOUT_MS = 8000

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

// The token goes in the URL FRAGMENT, not the query string.
//
// A fragment is never sent to any server, so the token stays out of our own access
// logs, any CDN/proxy in front of us, and the Referer header. That last one is not
// theoretical: /join loads Google Identity Services, and with `?token=` the full
// invite link would be handed to accounts.google.com on every page view.
//
// /join still reads the old `?token=` form so links mailed before this change keep
// working.
function inviteUrl(rawToken) {
  const base = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '')
  return `${base}/join#token=${rawToken}`
}

// Try to deliver the invite, but never let email decide whether inviting works.
// Returns a definite true/false so the UI can tell the owner "we emailed them" vs
// "copy this link and send it yourself" — the difference between a feature that
// works and one that silently does nothing when SMTP isn't set up.
async function deliverInvite(payload) {
  if (!emailReady()) return false
  try {
    return await Promise.race([
      sendInviteEmail(payload),
      new Promise((resolve) => setTimeout(() => resolve(false), EMAIL_SEND_TIMEOUT_MS)),
    ])
  } catch {
    return false
  }
}

// Seat limits arrive with billing (REMEDIATION_PLAN.md Phase 3). The hook exists
// now so the enforcement point is already in the right place.
async function seatsAvailable(_tenantId) {
  return { ok: true }
}

// ─── GET / — members + pending invites ───────────────────────────────────────
router.get('/', requirePermission('team:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const [{ data: members }, { data: invites }] = await Promise.all([
      supabase.from('profiles')
        .select('id, email, full_name, tenant_role, status, last_seen_at, created_at')
        .eq('tenant_id', t)
        .order('created_at', { ascending: true }),
      supabase.from('invitations')
        .select('id, email, tenant_role, expires_at, created_at')
        .eq('tenant_id', t)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .order('created_at', { ascending: false }),
    ])

    const now = Date.now()
    res.json({
      members: members || [],
      invites: (invites || []).map(i => ({ ...i, expired: new Date(i.expires_at).getTime() < now })),
      // Lets the UI disable controls it would only get a 403 from.
      can_manage: req.auth.tenantRole === 'owner',
      // False when SMTP isn't configured — the UI then tells the owner up front to
      // expect a copyable link instead of silently promising an email.
      email_delivery: emailReady(),
    })
  } catch (e) {
    console.error('[TEAM] list error:', e.message)
    res.status(500).json({ error: 'Could not load your team' })
  }
})

// ─── POST /invite — invite someone by email ──────────────────────────────────
router.post('/invite', requireOwner(), async (req, res) => {
  const t = req.auth.tenantId
  const email = String(req.body?.email || '').trim().toLowerCase()
  const tenantRole = String(req.body?.tenant_role || 'agent')

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' })
  }
  if (!isValidRole(tenantRole) || !canAssignRole(req.auth.tenantRole, tenantRole)) {
    return res.status(400).json({ error: 'That role cannot be assigned' })
  }
  if (email === String(req.auth.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'You are already a member of this business' })
  }

  try {
    // Already on THIS team? Say so plainly — it is their own team, so there is no
    // information leak in confirming it.
    const { data: already } = await supabase
      .from('profiles').select('id').eq('tenant_id', t).ilike('email', email).maybeSingle()
    if (already) return res.status(409).json({ error: 'That person is already on your team' })

    const seats = await seatsAvailable(t)
    if (!seats.ok) return res.status(402).json({ error: seats.reason || 'No seats left on your plan' })

    // Re-inviting replaces the old link so only one live token per person exists
    // (also enforced by the partial unique index in sql/team.sql).
    await supabase.from('invitations')
      .update({ revoked_at: new Date().toISOString() })
      .eq('tenant_id', t).ilike('email', email)
      .is('accepted_at', null).is('revoked_at', null)

    const raw = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString()

    const { data: invite, error } = await supabase.from('invitations').insert({
      tenant_id: t,
      email,
      tenant_role: tenantRole,
      token_hash: hashToken(raw),
      invited_by: req.auth.userId,
      expires_at: expiresAt,
    }).select('id, email, tenant_role, expires_at, created_at').single()
    if (error) throw error

    const { data: tenant } = await supabase
      .from('tenants').select('name, config').eq('id', t).single()

    const url = inviteUrl(raw)
    const emailSent = await deliverInvite({
      to: email,
      businessName: tenant?.config?.business_name || tenant?.name || 'your team',
      inviterName: req.auth.fullName || req.auth.email,
      inviterEmail: req.auth.email,
      role: tenantRole,
      url,
    })

    if (!emailSent) {
      console.warn(`[TEAM] invite for ${email} created but NOT emailed — owner must share the link`)
    }

    // The link is returned ONCE, here. The requester is the owner who just created
    // it, so they are entitled to it — and without this, an unconfigured or failing
    // SMTP server makes every invite permanently unusable (the raw token is never
    // stored, only its hash).
    res.status(201).json({ invite, invite_url: url, email_sent: emailSent })
  } catch (e) {
    console.error('[TEAM] invite error:', e.message)
    res.status(500).json({ error: 'Could not create the invite' })
  }
})

// ─── POST /invite/:id/resend ─────────────────────────────────────────────────
// Issues a FRESH token (the old one is unrecoverable — we only kept its hash) and
// resets the clock, so a resend always produces a working link.
router.post('/invite/:id/resend', requireOwner(), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: invite } = await supabase
      .from('invitations').select('*')
      .eq('id', req.params.id).eq('tenant_id', t)
      .is('accepted_at', null).is('revoked_at', null)
      .maybeSingle()
    if (!invite) return res.status(404).json({ error: 'Invite not found' })

    const raw = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString()
    const { error } = await supabase.from('invitations')
      .update({ token_hash: hashToken(raw), expires_at: expiresAt })
      .eq('id', invite.id)
    if (error) throw error

    const { data: tenant } = await supabase
      .from('tenants').select('name, config').eq('id', t).single()

    const url = inviteUrl(raw)
    const emailSent = await deliverInvite({
      to: invite.email,
      businessName: tenant?.config?.business_name || tenant?.name || 'your team',
      inviterName: req.auth.fullName || req.auth.email,
      inviterEmail: req.auth.email,
      role: invite.tenant_role,
      url,
    })

    res.json({ ok: true, expires_at: expiresAt, invite_url: url, email_sent: emailSent })
  } catch (e) {
    console.error('[TEAM] resend error:', e.message)
    res.status(500).json({ error: 'Could not resend the invite' })
  }
})

// ─── DELETE /invite/:id — revoke ─────────────────────────────────────────────
router.delete('/invite/:id', requireOwner(), async (req, res) => {
  try {
    const { error } = await supabase.from('invitations')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', req.auth.tenantId)
      .is('accepted_at', null)
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('[TEAM] revoke error:', e.message)
    res.status(500).json({ error: 'Could not revoke the invite' })
  }
})

// ─── PATCH /:profileId — change role or suspend ──────────────────────────────
router.patch('/:profileId', requireOwner(), async (req, res) => {
  const t = req.auth.tenantId
  const { tenant_role: tenantRole, status } = req.body || {}

  if (req.params.profileId === req.auth.userId) {
    return res.status(400).json({ error: 'You cannot change your own role or status' })
  }
  if (tenantRole !== undefined && (!isValidRole(tenantRole) || !canAssignRole(req.auth.tenantRole, tenantRole))) {
    return res.status(400).json({ error: 'That role cannot be assigned' })
  }
  if (status !== undefined && !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or suspended' })
  }

  try {
    const { data: target } = await supabase
      .from('profiles').select('id, tenant_role').eq('id', req.params.profileId).eq('tenant_id', t).maybeSingle()
    if (!target) return res.status(404).json({ error: 'Member not found' })

    // A business must always have at least one active owner, or nobody can ever
    // configure the agent or manage the team again.
    const losingAnOwner = target.tenant_role === 'owner'
      && ((tenantRole !== undefined && tenantRole !== 'owner') || status === 'suspended')
    if (losingAnOwner && !(await hasAnotherActiveOwner(t, target.id))) {
      return res.status(400).json({ error: 'This is the last owner — promote someone else first' })
    }

    const patch = {}
    if (tenantRole !== undefined) patch.tenant_role = tenantRole
    if (status !== undefined) patch.status = status
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' })

    const { data: updated, error } = await supabase
      .from('profiles').update(patch).eq('id', target.id).eq('tenant_id', t)
      .select('id, email, full_name, tenant_role, status').single()
    if (error) throw error

    res.json({ member: updated })
  } catch (e) {
    console.error('[TEAM] update member error:', e.message)
    res.status(500).json({ error: 'Could not update that member' })
  }
})

// ─── DELETE /:profileId — remove from the business ───────────────────────────
// Their leads are reassigned (or unassigned) FIRST, so removing someone can never
// orphan work in progress.
router.delete('/:profileId', requireOwner(), async (req, res) => {
  const t = req.auth.tenantId
  const reassignTo = req.body?.reassign_to || null

  if (req.params.profileId === req.auth.userId) {
    return res.status(400).json({ error: 'You cannot remove yourself' })
  }

  try {
    const { data: target } = await supabase
      .from('profiles').select('id, tenant_role').eq('id', req.params.profileId).eq('tenant_id', t).maybeSingle()
    if (!target) return res.status(404).json({ error: 'Member not found' })

    if (target.tenant_role === 'owner' && !(await hasAnotherActiveOwner(t, target.id))) {
      return res.status(400).json({ error: 'This is the last owner — promote someone else first' })
    }

    if (reassignTo) {
      const { data: member } = await supabase
        .from('profiles').select('id').eq('id', reassignTo).eq('tenant_id', t).maybeSingle()
      if (!member) return res.status(400).json({ error: 'Cannot reassign to someone outside this business' })
    }

    await supabase.from('leads')
      .update({ assigned_to: reassignTo, updated_at: new Date().toISOString() })
      .eq('tenant_id', t).eq('assigned_to', target.id)

    const { error } = await supabase.from('profiles').delete().eq('id', target.id).eq('tenant_id', t)
    if (error) throw error

    // Remove the login itself. Best-effort: the profile is already gone, so they
    // can no longer resolve a tenant even if this fails.
    if (supabaseAdmin) {
      await supabaseAdmin.auth.admin.deleteUser(target.id).catch(() => {})
    }

    res.json({ ok: true, reassigned_to: reassignTo })
  } catch (e) {
    console.error('[TEAM] remove member error:', e.message)
    res.status(500).json({ error: 'Could not remove that member' })
  }
})

// Is there an active owner OTHER than `exceptId`?
async function hasAnotherActiveOwner(tenantId, exceptId) {
  const { data } = await supabase
    .from('profiles').select('id')
    .eq('tenant_id', tenantId).eq('tenant_role', 'owner').eq('status', 'active')
    .neq('id', exceptId).limit(1)
  return !!(data && data.length)
}

export default router
