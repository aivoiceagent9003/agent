
// api/db.js — Shared Supabase clients (created once, reused everywhere).
// Avoids creating a new client + process listeners in every module, which
// triggered the MaxListenersExceededWarning.

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

// Primary server-side DB client for ALL table queries.
//
// It uses the SERVICE ROLE key when available so the backend acts as the single
// trusted gateway: this lets us enable Row-Level Security to DENY all direct
// anon/public access without breaking the API (the service role bypasses RLS).
// Falls back to the anon key if the service key isn't set — but RLS must NOT be
// enabled in that case or the backend loses DB access (see sql/rls.sql).
//
// Tenant isolation is still enforced in application code (requireClient /
// requireAdmin + explicit tenant_id filters); RLS is defense-in-depth.
const DB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

export const supabase = createClient(
  process.env.SUPABASE_URL,
  DB_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// Anon client — used ONLY for the user password sign-in (the gotrue password
// grant is conventionally performed with the anon key). Never used for queries.
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// Explicit service-role client — for provisioning (signup) and Storage. Same
// privileges as `supabase` when the service key is set; null otherwise so callers
// can detect that provisioning isn't available (signup checks for it).
export const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )
  : null