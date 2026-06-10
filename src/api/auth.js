// api/auth.js — Authentication middleware
// Validates the Supabase Auth JWT from the Authorization header, looks up the
// user's profile (role + tenant_id), and attaches it to req.auth.

import { supabase } from './db.js'

// Pull the bearer token, validate it with Supabase, load the profile.
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
    .select('role, tenant_id, email')
    .eq('id', user.id)
    .single()

  return {
    userId: user.id,
    email: user.email,
    role: profile?.role || 'client',
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