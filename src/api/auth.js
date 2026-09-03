// api/auth.js — Authentication middleware
// Validates the Supabase Auth JWT from the Authorization header, looks up the
// user's profile (role + tenant_id + tenant_role), and attaches it to req.auth.
//
// TWO SEPARATE ROLE FIELDS, deliberately:
//   role        — platform level: 'admin' (AnswerLabs staff) vs 'client' (a tenant user)
//   tenantRole  — inside a business: 'owner' | 'manager' | 'agent'
// Authorization for tenant features lives in permissions.js and reads tenantRole.

import { supabase } from './db.js'

// Pull the bearer token, validate it with Supabase, load the profile.
// Returns null for anonymous OR suspended users — a suspended employee's existing
// JWT stops working on their very next request, which is what makes off-boarding
// immediate instead of "whenever their token expires".
async function resolveUser(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  // Validate the token and get the auth user
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null

  // Load role + tenant_id from the profiles table
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, tenant_id, tenant_role, email, full_name, status')
    .eq('id', user.id)
    .single()

  if (profile?.status === 'suspended') return null

  return {
    userId: user.id,
    email: user.email,
    fullName: profile?.full_name || null,
    role: profile?.role || 'client',
    // Default to 'owner' so any profile predating the team feature (and the
    // signup path, which creates the business owner) behaves exactly as before.
    tenantRole: profile?.tenant_role || 'owner',
    tenantId: profile?.tenant_id || null,
  }
}

// Require a valid logged-in user (any role)
export function requireAuth() {
  return async (req, res, next) => {
    const auth = await resolveUser(req)
    if (!auth) return res.status(401).json({ error: 'Unauthorized' })
    req.auth = auth
    next()
  }
}

// Require admin role
export function requireAdmin() {
  return async (req, res, next) => {
    const auth = await resolveUser(req)
    if (!auth) return res.status(401).json({ error: 'Unauthorized' })
    if (auth.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    req.auth = auth
    next()
  }
}

// Require a client (must have a tenant_id). Admins are also allowed but should
// use admin routes; here we enforce a tenant scope is present.
export function requireClient() {
  return async (req, res, next) => {
    const auth = await resolveUser(req)
    if (!auth) return res.status(401).json({ error: 'Unauthorized' })
    if (!auth.tenantId) return res.status(403).json({ error: 'No tenant associated with this account' })
    req.auth = auth
    next()
  }
}