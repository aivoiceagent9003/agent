
// api/db.js — Shared Supabase clients (created once, reused everywhere).
// Avoids creating a new client + process listeners in every module, which
// triggered the MaxListenersExceededWarning.

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

// Standard client (anon key) — for normal queries.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// Admin client (service role) — for provisioning (signup). May be undefined if
// the key isn't set; signup checks for it.
export const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )
  : null