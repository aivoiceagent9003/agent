// services/campaigns/execute.js — per-contact dial/broadcast execution (worker side).
//
// Runs INSIDE the worker process. For one contact it: re-checks compliance, builds
// the merged AI config (tenant.config + campaign.config, exactly like the browser
// test-stream merge in src/index.js), creates the OUTBOUND calls row, stashes the
// call context in the cross-process registry (Redis), and originates via the dialer.
// The answer webhook + campaign WS (API process) then bind the media stream to this
// context by correlation_id and run the conversation.

import { randomUUID } from 'node:crypto'
import { webhookQuery } from '../../api/webhook-auth.js'
import { supabase } from '../../api/db.js'
import { originate } from './dialer.js'
import { canDial } from './compliance.js'
import { renderTemplate } from './broadcast.js'
import { setPending } from '../../telephony/campaign-registry.js'
import { enqueueRetry, enqueueAnalytics } from '../../queue/queues.js'

const ANSWER_URL = () => `https://${process.env.PUBLIC_HOST || process.env.NGROK_URL}/answer-campaign`

async function loadJobContext({ tenantId, campaignId, contactId }) {
  const [{ data: campaign }, { data: contact }, { data: tenant }] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', campaignId).single(),
    supabase.from('campaign_contacts').select('*').eq('id', contactId).single(),
    supabase.from('tenants').select('id, name, config, phone_number').eq('id', tenantId).single(),
  ])
  return { campaign, contact, tenant }
}

// Merge tenant + campaign config into the tenantConfig the voice engine expects.
export function buildAiConfig(tenant, campaign, contact) {
  const cfg = campaign.config || {}
  return {
    ...(tenant.config || {}),
    ...cfg,                                   // campaign overrides (prompt/voice/language/kb/temperature/goal/...)
    tenant_id: tenant.id,
    is_outbound: true,                        // we dialed them → outbound opening line
    // Pass campaign context so prompts/tools can personalize.
    campaign_id: campaign.id,
    contact_name: contact.name || null,
    contact_fields: contact.custom_fields || {},
  }
}

async function bumpAttempt(contactId, status) {
  const { data } = await supabase.from('campaign_contacts').select('attempts').eq('id', contactId).single()
  await supabase.from('campaign_contacts')
    .update({ attempts: (data?.attempts || 0) + 1, status, last_contacted_at: new Date().toISOString() })
    .eq('id', contactId)
}

async function log(ctx, event, detail = {}) {
  try {
    await supabase.from('campaign_logs').insert({
      tenant_id: ctx.tenantId, campaign_id: ctx.campaignId, run_id: ctx.runId, contact_id: ctx.contactId, event, detail,
    })
  } catch {}
}

// Shared origination path for AI + broadcast.
async function dialContact(job, type) {
  const { campaign, contact, tenant } = await loadJobContext(job)
  if (!campaign || !contact || !tenant) throw new Error('missing campaign/contact/tenant')
  if (contact.status === 'completed' || contact.status === 'dnc') return { skipped: contact.status }

  // Pre-dial compliance re-check (windows can close between enqueue and dial).
  const gate = await canDial(tenant.id, contact, campaign)
  if (!gate.ok) {
    await log(job, 'skipped', { reason: gate.reason })
    if (gate.reason === 'suppressed') await supabase.from('campaign_contacts').update({ status: 'dnc' }).eq('id', contact.id)
    return { skipped: gate.reason }
  }

  const fromNumber = campaign.from_number || tenant.phone_number
  const correlationId = randomUUID()

  // Create the OUTBOUND call row up front (mirrors inbound /answer creating the row).
  const { data: call } = await supabase.from('calls').insert({
    tenant_id: tenant.id, caller_number: contact.phone, status: 'active',
    direction: 'outbound', campaign_id: campaign.id, campaign_contact_id: contact.id, campaign_run_id: job.runId,
  }).select().single()

  // Stash context for the answer webhook + WS (cross-process via Redis).
  await setPending(correlationId, {
    type, tenantId: tenant.id, tenantName: tenant.name,
    campaignId: campaign.id, contactId: contact.id, runId: job.runId,
    callId: call?.id || null, phone: contact.phone, fromNumber,
    config: type === 'broadcast' ? null : buildAiConfig(tenant, campaign, contact),
    message: type === 'broadcast' ? renderTemplate(campaign.config?.message || campaign.config?.template, contact) : null,
  })

  await bumpAttempt(contact.id, 'dialing')
  await log(job, 'dialing', { phone: contact.phone, correlationId })

  try {
    const { providerId } = await originate({ to: contact.phone, from: fromNumber, correlationId, answerUrl: `${ANSWER_URL()}?${webhookQuery()}&cid=${correlationId}` })
    await log(job, 'originated', { providerId })
    return { originated: true, providerId, correlationId }
  } catch (e) {
    // Originate failed → mark + schedule a retry per policy.
    await supabase.from('campaign_contacts').update({ status: 'failed', disposition: 'failed' }).eq('id', contact.id)
    await log(job, 'failed', { error: e.message })
    await scheduleRetry(job, campaign, contact, 'originate_failed')
    throw e
  }
}

// Schedule a retry if the policy allows another attempt.
// attemptsMade = attempts already spent. Defaults to contact.attempts + 1 for the
// originate-failure path (contact was loaded before bumpAttempt ran); callers that
// hold a post-bump row (finalize, sweep) pass contact.attempts as-is.
export async function scheduleRetry(job, campaign, contact, reason, attemptsMade = (contact.attempts || 0) + 1) {
  const policy = campaign.retry_policy || {}
  const maxAttempts = policy.max_attempts ?? 3
  const attempts = attemptsMade
  if (attempts >= maxAttempts) { await log(job, 'exhausted', { reason, attempts }); return false }
  const delayMs = (policy.delay_minutes ?? 60) * 60_000
  await supabase.from('retry_queue').insert({
    tenant_id: job.tenantId, campaign_id: job.campaignId, contact_id: job.contactId,
    attempt: attempts, reason, run_after: new Date(Date.now() + delayMs).toISOString(),
  })
  await enqueueRetry(job, delayMs)
  await log(job, 'retry_scheduled', { reason, attempt: attempts, delayMs })
  return true
}

export const executeDial = (job) => dialContact(job, 'ai_sales')
export const executeBroadcast = (job) => dialContact(job, 'broadcast')

// Sweep contacts stuck in 'dialing': if the callee never answers, no media stream
// ever opens, so nothing finalizes the contact — without this they'd hang forever
// (and block campaign auto-completion). Treated as no_answer + retried per policy.
const STALE_DIAL_MS = Number(process.env.DIAL_STALE_MINUTES || 3) * 60_000

export async function sweepStaleDialing() {
  const cutoff = new Date(Date.now() - STALE_DIAL_MS).toISOString()
  const { data: stale } = await supabase.from('campaign_contacts')
    .select('id, tenant_id, campaign_id, phone, attempts')
    .eq('status', 'dialing').lt('last_contacted_at', cutoff).limit(500)
  if (!stale?.length) return 0

  const campaigns = new Map()
  for (const c of stale) {
    if (!campaigns.has(c.campaign_id)) {
      const { data } = await supabase.from('campaigns').select('id, type, retry_policy').eq('id', c.campaign_id).single()
      campaigns.set(c.campaign_id, data || null)
    }
    const campaign = campaigns.get(c.campaign_id)
    if (!campaign) continue

    const job = { tenantId: c.tenant_id, campaignId: c.campaign_id, contactId: c.id, runId: null }
    const retried = await scheduleRetry(job, campaign, c, 'no_answer', c.attempts || 0)
    // Guard on status so we never clobber a finalize that raced us.
    await supabase.from('campaign_contacts')
      .update({ status: retried ? 'no_answer' : 'completed', disposition: 'no_answer' })
      .eq('id', c.id).eq('status', 'dialing')
    await enqueueAnalytics(c.campaign_id)
  }
  return stale.length
}

// Retry job → reset the contact to pending and re-dial.
export async function executeRetry(job) {
  const { data: contact } = await supabase.from('campaign_contacts').select('*').eq('id', job.contactId).single()
  if (!contact || contact.status === 'completed' || contact.status === 'dnc') return { skipped: true }
  const { data: campaign } = await supabase.from('campaigns').select('type').eq('id', job.campaignId).single()
  return dialContact(job, campaign?.type === 'broadcast' ? 'broadcast' : 'ai_sales')
}
