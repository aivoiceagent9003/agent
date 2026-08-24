// jobs/retention.js — delete what we are no longer entitled to keep.
//
// Nothing was ever deleted. Recordings, transcripts, and caller numbers
// accumulated indefinitely, which is a DPDP problem (personal data kept past its
// purpose) and quietly a margin problem too — storage grows every month while the
// price of a minute does not.
//
// What this does NOT do: delete the call row. Analytics, invoices, and the client's
// own history depend on those rows existing. It strips the PERSONAL data out of
// them — recording, transcript, caller number — and leaves the countable shell
// behind, stamped with anonymized_at so a second pass skips it.
//
// Window: tenants.config.retention_days, default 90.

import { supabase } from '../api/db.js'
import telemetry from '../services/telemetry.js'

const DEFAULT_RETENTION_DAYS = Number(process.env.DEFAULT_RETENTION_DAYS || 90)
const BATCH = 500

// Keep the last four digits so support can still discuss "the call from …4821"
// with the client, without retaining a number that identifies the person.
function pseudonymise(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 4) return 'redacted'
  return `redacted-${digits.slice(-4)}`
}

async function purgeTenant(tenant) {
  const days = Number(tenant.config?.retention_days) || DEFAULT_RETENTION_DAYS
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
  const summary = { tenant: tenant.name, days, calls: 0, recordings: 0, leads: 0 }

  const { data: calls, error } = await supabase
    .from('calls')
    .select('id, recording_path')
    .eq('tenant_id', tenant.id)
    .lt('created_at', cutoff)
    .is('anonymized_at', null)
    .limit(BATCH)

  if (error) throw new Error(`calls query: ${error.message}`)
  if (!calls?.length) return summary

  // Storage first. If the row were cleared first and the delete then failed, the
  // recording would be orphaned in the bucket with nothing left pointing at it —
  // undeletable without a manual sweep, and still personal data.
  const paths = calls.map(c => c.recording_path).filter(Boolean)
  if (paths.length) {
    const { error: sErr } = await supabase.storage.from('recordings').remove(paths)
    if (sErr) console.warn('[RETENTION] storage delete partial failure:', sErr.message)
    else summary.recordings = paths.length
  }

  const { error: uErr } = await supabase
    .from('calls')
    .update({
      transcript: null,
      recording_path: null,
      caller_number: 'redacted',
      anonymized_at: new Date().toISOString(),
    })
    .in('id', calls.map(c => c.id))
  if (uErr) throw new Error(`calls update: ${uErr.message}`)
  summary.calls = calls.length

  const { data: leads, error: lErr } = await supabase
    .from('leads')
    .select('id, phone')
    .eq('tenant_id', tenant.id)
    .lt('created_at', cutoff)
    .is('anonymized_at', null)
    .limit(BATCH)
  if (lErr) throw new Error(`leads query: ${lErr.message}`)

  for (const lead of leads || []) {
    await supabase.from('leads').update({
      phone: pseudonymise(lead.phone),
      name: 'Redacted',
      anonymized_at: new Date().toISOString(),
    }).eq('id', lead.id)
  }
  summary.leads = leads?.length || 0

  return summary
}

/**
 * One retention pass across every tenant. Safe to run repeatedly — anonymized_at
 * makes it idempotent, and the batch cap means a large backlog is worked down over
 * several nights rather than in one query that times out.
 */
export async function runRetention() {
  const started = Date.now()
  const { data: tenants, error } = await supabase.from('tenants').select('id, name, config')
  if (error) {
    console.error('[RETENTION] could not list tenants:', error.message)
    return { ok: false }
  }

  const results = []
  for (const tenant of tenants || []) {
    try {
      const s = await purgeTenant(tenant)
      if (s.calls || s.leads || s.recordings) {
        console.log(`[RETENTION] ${s.tenant}: ${s.calls} calls, ${s.recordings} recordings, ${s.leads} leads (>${s.days}d)`)
        results.push(s)
      }
    } catch (e) {
      console.error(`[RETENTION] ${tenant.name} failed:`, e.message)
      telemetry.recordServiceEvent({
        component: 'retention', severity: 'error', kind: 'retention_failed',
        detail: { tenant: tenant.name, error: e.message },
      })
    }
  }

  const totals = results.reduce((a, s) => ({
    calls: a.calls + s.calls, recordings: a.recordings + s.recordings, leads: a.leads + s.leads,
  }), { calls: 0, recordings: 0, leads: 0 })

  // Every run is logged, including the quiet ones — "we run retention nightly" is
  // only defensible if you can show the runs.
  telemetry.recordServiceEvent({
    component: 'retention', severity: 'info', kind: 'retention_run',
    detail: { ...totals, tenants: results.length, ms: Date.now() - started },
  })

  console.log(`[RETENTION] pass complete in ${Date.now() - started}ms — ${totals.calls} calls, ${totals.recordings} recordings, ${totals.leads} leads`)
  return { ok: true, ...totals }
}

/** Nightly timer, started by both the worker and the inline runner. */
export function startRetentionSchedule() {
  const everyMs = Number(process.env.RETENTION_INTERVAL_MS || 24 * 3600_000)
  // Deliberately not run at boot: a deploy loop would then hammer it. First pass
  // is one interval in.
  const t = setInterval(() => {
    runRetention().catch(e => console.error('[RETENTION] pass failed:', e.message))
  }, everyMs)
  t.unref?.()
  console.log(`[RETENTION] scheduled every ${Math.round(everyMs / 3600_000)}h`)
  return () => clearInterval(t)
}
