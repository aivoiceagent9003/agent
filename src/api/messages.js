// api/messages.js — internal team messaging (tenant-scoped).
//
// Mounted at /api/client/messages. Every route derives the tenant from
// req.auth.tenantId and verifies thread membership before reading or writing —
// membership is what stops someone reading a direct thread they aren't part of,
// since a valid user of the business would otherwise pass the tenant check.
//
// Realtime delivery goes over /messages-stream (see src/index.js); this router is
// the source of truth and the fallback when a socket isn't connected.

import { Router } from 'express'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import {
  ensureTeamConversation,
  ensureSupportConversation,
  ensureDirectConversation,
  listConversations,
  listMessages,
  isMember,
  markRead,
  recipientsOf,
} from '../services/conversations.js'
import { notify } from '../services/notifications.js'
import hub from '../services/realtime-hub.js'

const router = Router()
router.use(requireClient())

// Messaging is available to EVERY member of a business regardless of role — an
// agent who can't see campaigns still needs to talk to their manager. So there is
// deliberately no requirePermission() here beyond requireClient.

const MAX_BODY = 4000

// ─── GET / — the conversation sidebar ────────────────────────────────────────
// Provisions the team + support threads on first visit, so no backfill was needed
// for businesses that existed before messaging shipped.
router.get('/', async (req, res) => {
  const { tenantId, userId } = req.auth
  try {
    const { data: tenant } = await supabase
      .from('tenants').select('name, config').eq('id', tenantId).single()

    await ensureTeamConversation(tenantId, tenant?.config?.business_name || tenant?.name)
    await ensureSupportConversation(tenantId)

    const conversations = await listConversations(tenantId, userId)
    res.json({
      conversations,
      total_unread: conversations.reduce((n, c) => n + (c.unread || 0), 0),
    })
  } catch (e) {
    console.error('[MESSAGES] list error:', e.message)
    res.status(500).json({ error: 'Could not load your conversations' })
  }
})

// ─── GET /people — who you can start a direct thread with ────────────────────
router.get('/people', async (req, res) => {
  const { tenantId, userId } = req.auth
  try {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, tenant_role')
      .eq('tenant_id', tenantId).eq('status', 'active').neq('id', userId)
      .order('full_name', { ascending: true })

    res.json({
      people: (data || []).map(p => ({
        id: p.id,
        name: p.full_name || p.email,
        email: p.email,
        role: p.tenant_role,
        online: hub.isOnline(p.id),
      })),
    })
  } catch (e) {
    console.error('[MESSAGES] people error:', e.message)
    res.status(500).json({ error: 'Could not load your team' })
  }
})

// ─── POST /direct { profile_id } — open (or reuse) a 1:1 thread ──────────────
router.post('/direct', async (req, res) => {
  const { tenantId, userId } = req.auth
  const other = req.body?.profile_id
  if (!other) return res.status(400).json({ error: 'profile_id is required' })

  try {
    // Confirm the other person is in THIS business before creating anything.
    const { data: target } = await supabase
      .from('profiles').select('id').eq('id', other).eq('tenant_id', tenantId).maybeSingle()
    if (!target) return res.status(404).json({ error: 'That person is not on your team' })

    const convo = await ensureDirectConversation(tenantId, userId, other)
    res.json({ conversation_id: convo.id })
  } catch (e) {
    console.error('[MESSAGES] direct error:', e.message)
    res.status(500).json({ error: 'Could not open that conversation' })
  }
})

// ─── GET /:id — message history ──────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { userId } = req.auth
  try {
    if (!(await isMember(req.params.id, userId))) {
      return res.status(403).json({ error: 'You are not part of this conversation' })
    }
    const messages = await listMessages(req.params.id, {
      limit: Number(req.query.limit) || 100,
      before: req.query.before,
    })
    await markRead(req.params.id, userId)
    res.json({ messages })
  } catch (e) {
    console.error('[MESSAGES] history error:', e.message)
    res.status(500).json({ error: 'Could not load messages' })
  }
})

// ─── POST /:id { body } — send ───────────────────────────────────────────────
router.post('/:id', async (req, res) => {
  const { tenantId, userId, fullName, email } = req.auth
  const body = String(req.body?.body || '').trim()

  if (!body) return res.status(400).json({ error: 'Message cannot be empty' })
  if (body.length > MAX_BODY) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_BODY} characters)` })
  }

  try {
    if (!(await isMember(req.params.id, userId))) {
      return res.status(403).json({ error: 'You are not part of this conversation' })
    }

    const { data: message, error } = await supabase.from('messages').insert({
      conversation_id: req.params.id,
      tenant_id: tenantId,
      sender_id: userId,
      body,
    }).select('id, sender_id, is_system, body, created_at').single()
    if (error) throw error

    const senderName = fullName || email || 'Someone'
    const enriched = { ...message, sender_name: senderName, conversation_id: req.params.id }

    // Sender's own tabs get it too, so a second window stays in sync.
    await markRead(req.params.id, userId)
    hub.publish(userId, { type: 'message', message: enriched })

    const others = await recipientsOf(req.params.id, userId)
    hub.publishMany(others, { type: 'message', message: enriched })

    // Bell entry for anyone not currently connected — people with a live socket
    // already saw it arrive, and double-notifying is noise.
    const offline = others.filter(id => !hub.isOnline(id))
    if (offline.length) {
      const { data: convo } = await supabase
        .from('conversations').select('kind, title').eq('id', req.params.id).single()
      await notify(offline, {
        tenantId,
        kind: 'message',
        title: `${senderName}${convo?.kind === 'direct' ? '' : ` in ${convo?.title || 'Team'}`}`,
        body: body.slice(0, 140),
        link: `/messages?c=${req.params.id}`,
      })
    }

    res.status(201).json({ message: enriched })
  } catch (e) {
    console.error('[MESSAGES] send error:', e.message)
    res.status(500).json({ error: 'Could not send your message' })
  }
})

// ─── POST /:id/read — clear the unread badge ─────────────────────────────────
router.post('/:id/read', async (req, res) => {
  const { userId } = req.auth
  try {
    if (!(await isMember(req.params.id, userId))) {
      return res.status(403).json({ error: 'You are not part of this conversation' })
    }
    await markRead(req.params.id, userId)
    res.json({ ok: true })
  } catch (e) {
    console.error('[MESSAGES] read error:', e.message)
    res.status(500).json({ error: 'Could not update read state' })
  }
})

export default router
