// api/auth-routes.js — Login endpoint for the dashboard frontend.
// The rest of the API validates a Supabase JWT (see auth.js). This route is the
// one place that mints that JWT: it signs the user in with Supabase using the
// anon client and hands the access token back to the browser, along with the
// user's role + tenant so the frontend knows where to route them.

import { Router } from 'express'
import { supabase } from './db.js'

const router = Router()

// POST /api/auth/login  { email, password } -> { token, role, tenant_id }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  // Sign in against Supabase Auth. On success this returns a session whose
  // access_token is the same JWT the rest of the API expects in the
  // Authorization header.
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
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
    token: data.session.access_token,
    role: profile?.role || 'client',
    tenant_id: profile?.tenant_id || null,
  })
})

export default router
