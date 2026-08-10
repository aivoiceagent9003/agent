// services/campaigns/enqueue.js — expand a campaign into per-contact jobs.
//
// Called when a campaign is started (immediately, or by the scheduler). Creates a
// campaign_run, applies compliance filtering, and enqueues one dial/broadcast job
// per eligible contact. Never dials inline — the API stays fast; the worker pool
// drains the queue with bounded concurrency.

import { supabase } from '../../api/db.js'
import { enqueueDial, enqueueBroadcast } from '../../queue/queues.js'
import { filterContacts } from './compliance.js'

export async function startRun(campaign) {
  const tenantId = campaign.tenant_id
  // Open a run.
  const { data: run } = await supabase.from('campaign_runs')
    .insert({ tenant_id: tenantId, campaign_id: campaign.id, status: 'running' })
    .select().single()
  const runId = run?.id || null

  // Pull contacts still eligible (pending or previously failed no-answer that may retry).
  const { data: contacts } = await supabase.from('campaign_contacts')
    .select('id, phone, name, custom_fields, attempts, status')
    .eq('campaign_id', campaign.id)
    .in('status', ['pending', 'queued', 'no_answer'])
    .limit(100000)

  const maxAttempts = campaign.retry_policy?.max_attempts ?? 3
  const { allowed, blocked } = await filterContacts(tenantId, contacts || [], {
    compliance: campaign.compliance || {}, schedule: campaign.schedule || {}, maxAttempts,
  })

  // Mark blocked contacts (suppressed → dnc; others stay pending for a later window).
  for (const b of blocked) {
    if (b.reason === 'suppressed') {
      await supabase.from('campaign_contacts').update({ status: 'dnc', disposition: 'suppressed' }).eq('id', b.id)
    }
  }

  // Enqueue one job per allowed contact.
  const isBroadcast = campaign.type === 'broadcast'
  let queued = 0
  for (const c of allowed) {
    const payload = { tenantId, campaignId: campaign.id, contactId: c.id, runId }
    const job = isBroadcast ? await enqueueBroadcast(payload) : await enqueueDial(payload)
    if (job) queued++
  }
  await supabase.from('campaign_contacts')
    .update({ status: 'queued' })
    .in('id', allowed.map(c => c.id))

  await supabase.from('campaigns').update({ status: 'running', updated_at: new Date().toISOString() }).eq('id', campaign.id)
  await supabase.from('campaign_logs').insert({
    tenant_id: tenantId, campaign_id: campaign.id, run_id: runId, event: 'run_started',
    detail: { queued, blocked: blocked.length },
  })

  return { runId, queued, blocked: blocked.length }
}
