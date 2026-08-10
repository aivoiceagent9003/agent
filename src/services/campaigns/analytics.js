// services/campaigns/analytics.js — roll campaign activity into campaign_metrics.
//
// Aggregates the durable tables (campaign_contacts dispositions, outbound calls,
// leads) into one metrics row per campaign. Called by the analytics worker after
// call events and on-demand by the API. Cheap and idempotent (recomputes from truth).

import { supabase } from '../../api/db.js'

const COST_PER_MIN = Number(process.env.COST_PER_MIN_USD || 0.08)
const PRICE_PER_MIN = Number(process.env.PRICE_PER_MIN_USD || 0.30)

export async function rollupCampaign(campaignId) {
  const { data: campaign } = await supabase.from('campaigns').select('tenant_id, status, type, schedule').eq('id', campaignId).single()
  if (!campaign) return null
  const tenantId = campaign.tenant_id

  const [{ data: contacts }, { data: calls }, { data: leads }] = await Promise.all([
    supabase.from('campaign_contacts').select('status, disposition').eq('campaign_id', campaignId),
    supabase.from('calls').select('duration_seconds').eq('campaign_id', campaignId),
    supabase.from('leads').select('id, intent, follow_up_needed, handed_off, language')
      .in('call_id', (await supabase.from('calls').select('id').eq('campaign_id', campaignId)).data?.map(c => c.id) || []),
  ])

  const c = contacts || []
  const answered = c.filter(x => x.disposition === 'answered').length
  const noAnswer = c.filter(x => x.disposition === 'no_answer').length
  const failed = c.filter(x => x.status === 'failed').length
  const totalCalls = c.filter(x => ['completed', 'failed', 'no_answer'].includes(x.status)).length

  const aiSeconds = (calls || []).reduce((a, x) => a + (x.duration_seconds || 0), 0)
  const aiMinutes = +(aiSeconds / 60).toFixed(2)

  const leadRows = leads || []
  const qualified = leadRows.filter(l => l.intent && l.intent !== 'general_inquiry').length
  const meetings = leadRows.filter(l => /book|meeting|appointment|schedul/i.test(l.intent || '')).length
  const transfers = leadRows.filter(l => l.handed_off).length
  const langDist = {}
  for (const l of leadRows) if (l.language) langDist[l.language] = (langDist[l.language] || 0) + 1

  const cost = +(aiMinutes * COST_PER_MIN).toFixed(2)
  const revenue = +(aiMinutes * PRICE_PER_MIN).toFixed(2)   // placeholder revenue model

  const metrics = {
    campaign_id: campaignId, tenant_id: tenantId,
    calls: totalCalls, answered, conversations: answered,
    ai_minutes: aiMinutes, human_transfers: transfers,
    qualified_leads: qualified, meetings_booked: meetings,
    no_answer: noAnswer, failed, cost, revenue,
    language_dist: langDist, updated_at: new Date().toISOString(),
  }
  await supabase.from('campaign_metrics').upsert(metrics, { onConflict: 'campaign_id' })

  // Auto-complete: a running batch campaign with no contacts left to work is done.
  // Event-driven and recurring campaigns stay open — they wait for future contacts.
  const ACTIVE_STATUSES = ['pending', 'queued', 'dialing', 'no_answer']
  const activeLeft = c.filter(x => ACTIVE_STATUSES.includes(x.status)).length
  if (campaign.status === 'running' && campaign.type !== 'event' &&
      campaign.schedule?.mode !== 'recurring' && c.length > 0 && activeLeft === 0) {
    await supabase.from('campaigns')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', campaignId).eq('status', 'running')
    await supabase.from('campaign_runs')
      .update({ status: 'completed', ended_at: new Date().toISOString() })
      .eq('campaign_id', campaignId).eq('status', 'running')
    await supabase.from('campaign_logs').insert({
      tenant_id: tenantId, campaign_id: campaignId, event: 'campaign_completed',
      detail: { contacts: c.length, answered, no_answer: noAnswer, failed },
    })
  }
  return metrics
}
