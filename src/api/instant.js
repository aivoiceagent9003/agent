// api/instant.js — Instant Calls settings (tenant-scoped, requireClient).
//
// Manages the standalone "CRM entry → immediate AI call" webhook: NOT part of
// campaigns. Settings live in tenants.config.instant_call = { token, preset,
// enabled, from_number }. The public ingress itself is /api/events/instant/:tenantId
// (see src/api/events.js) — this router only exposes/rotates its credentials.

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { guardRouter } from './permissions.js'
import { INGRESS_PRESETS } from '../services/campaigns/sources.js'

const router = Router()
router.use(requireClient())
// Instant Calls place real outbound calls, so it sits with campaigns: managers and
// owners only. Rotating the ingress token is a write.
router.use(guardRouter({ read: 'campaigns:read', write: 'campaigns:write' }))

const newToken = () => randomUUID().replace(/-/g, '')

async function loadTenant(tenantId) {
  const { data } = await supabase.from('tenants').select('id, config, phone_number').eq('id', tenantId).single()
  return data || null
}

async function saveSettings(tenant, settings) {
  const config = { ...(tenant.config || {}), instant_call: settings }
  await supabase.from('tenants').update({ config }).eq('id', tenant.id)
  return settings
}

function present(tenantId, settings) {
  const base = process.env.PUBLIC_HOST || process.env.NGROK_URL || ''
  const path = `/api/events/instant/${tenantId}`
  return {
    enabled: settings.enabled !== false,
    url: base ? `https://${base}${path}` : path,
    token: settings.token,
    header: 'X-Instant-Token',
    presets: Object.keys(INGRESS_PRESETS),
    active_preset: settings.preset || 'generic',
    from_number: settings.from_number || '',
    skip_recent_days: Number(settings.skip_recent_days || 0),
    skip_statuses: Array.isArray(settings.skip_statuses) ? settings.skip_statuses : [],
  }
}

// Sensible default statuses that mean "already worked — don't auto-call".
export const DEFAULT_SKIP_STATUSES = ['contacted', 'qualified', 'converted', 'closed', 'lost', 'customer', 'unqualified', 'junk', 'not interested']

router.get('/', async (req, res) => {
  const tenant = await loadTenant(req.auth.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  let settings = tenant.config?.instant_call || {}
  if (!settings.token) settings = await saveSettings(tenant, { ...settings, token: newToken(), enabled: settings.enabled ?? true })
  res.json(present(tenant.id, settings))
})

router.put('/', async (req, res) => {
  const tenant = await loadTenant(req.auth.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const settings = { ...(tenant.config?.instant_call || {}) }
  const { enabled, preset, from_number } = req.body || {}
  if (enabled !== undefined) settings.enabled = !!enabled
  if (preset !== undefined) {
    if (preset && !INGRESS_PRESETS[preset]) return res.status(400).json({ error: 'unknown preset' })
    settings.preset = preset || 'generic'
  }
  if (from_number !== undefined) {
    // Store the caller ID verbatim — providers are picky about format (Vobiz wants
    // full E.164 like +918071583556; a national '08071583556' fails at the carrier).
    // We only trim; the operator is trusted to enter the exact working number.
    settings.from_number = String(from_number).trim() || null
  }
  if (req.body?.skip_recent_days !== undefined) {
    // Don't re-call a number we've spoken to within this many days (0 = off).
    settings.skip_recent_days = Math.max(0, Math.min(365, Number(req.body.skip_recent_days) || 0))
  }
  if (req.body?.skip_statuses !== undefined) {
    // Lead statuses that mean "already worked" — only new leads get called. Accepts
    // an array or a comma-separated string; stored lowercased & de-duped (max 40).
    const raw = Array.isArray(req.body.skip_statuses) ? req.body.skip_statuses : String(req.body.skip_statuses).split(',')
    settings.skip_statuses = [...new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 40)
  }
  if (!settings.token) settings.token = newToken()
  await saveSettings(tenant, settings)
  res.json(present(tenant.id, settings))
})

router.post('/rotate', async (req, res) => {
  const tenant = await loadTenant(req.auth.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const settings = { ...(tenant.config?.instant_call || {}), token: newToken() }
  await saveSettings(tenant, settings)
  res.json(present(tenant.id, settings))
})

export default router
