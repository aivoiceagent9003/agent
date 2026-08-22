// services/dnd.js — the callee's own opt-out.
//
// suppression_list already existed and compliance.js already honoured it, but the
// only writer was a tenant-facing API. So the list encoded who the BUSINESS chose
// not to call, and the person actually receiving the calls had no way in. Under
// the TRAI commercial-communication rules the recipient's request is the one that
// matters, and it has to be actionable at the moment they make it — on the call.
//
// This is the writer for that path: the agent calls add_to_dnd when someone asks
// not to be contacted again.

import { supabase } from '../api/db.js'
import { normalizePhone as normalizeContactPhone } from './campaigns/contacts.js'
import telemetry from './telemetry.js'

// Reuses the contact importer's normaliser rather than reimplementing it. These
// two MUST agree exactly: suppression is an exact string comparison, so an
// opt-out recorded in a different format than the stored contact would silently
// fail and the person would be called again — the worst possible outcome for this
// feature. Sharing the function makes them agree by construction instead of by
// two developers remembering to keep them in sync.
export function normalizePhone(raw) {
  return normalizeContactPhone(raw) || ''
}

/**
 * Record an opt-out. Idempotent — asking twice is not an error, and the second
 * ask must not fail in a way the agent then reports as "sorry, that didn't work".
 *
 * @returns {Promise<{ok: boolean, phone: string, alreadyListed?: boolean}>}
 */
export async function addToDnd({ tenantId, phone, source = 'caller_request', reason = null }) {
  const normalized = normalizePhone(phone)
  if (!tenantId || !normalized) return { ok: false, phone: normalized }

  const { data: existing } = await supabase
    .from('suppression_list')
    .select('phone')
    .eq('tenant_id', tenantId)
    .eq('phone', normalized)
    .maybeSingle()

  if (existing) {
    return { ok: true, phone: normalized, alreadyListed: true }
  }

  const { error } = await supabase.from('suppression_list').insert({
    tenant_id: tenantId,
    phone: normalized,
    source,
    reason,
  })

  if (error) {
    // A unique-constraint collision means a concurrent write already listed them,
    // which is success from the caller's point of view.
    if (/duplicate|unique/i.test(error.message)) {
      return { ok: true, phone: normalized, alreadyListed: true }
    }
    console.error('[DND] could not record opt-out:', error.message)
    telemetry.recordServiceEvent({
      component: 'compliance', severity: 'error', kind: 'dnd_write_failed',
      detail: { error: error.message },
    })
    return { ok: false, phone: normalized }
  }

  console.log(`[DND] 🚫 ${normalized} opted out (${source})`)
  telemetry.incr('dnd_opt_outs')
  telemetry.recordServiceEvent({
    component: 'compliance', severity: 'info', kind: 'dnd_opt_out',
    detail: { tenantId, source, reason },
  })
  return { ok: true, phone: normalized }
}
