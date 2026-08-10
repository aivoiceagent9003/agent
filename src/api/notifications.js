// api/notifications.js — the bell feed for dashboard users.
//
// Mounted at /api/client/notifications. Available to every role: an agent needs
// "a lead was assigned to you" just as much as an owner does.
//
// New notifications are pushed live over /messages-stream; these endpoints back
// the initial render and the mark-read actions.

import { Router } from 'express'
import { requireClient } from './auth.js'
import { listNotifications, unreadCount, markRead } from '../services/notifications.js'

const router = Router()
router.use(requireClient())

// GET / — recent notifications + unread count
router.get('/', async (req, res) => {
  try {
    const [items, unread] = await Promise.all([
      listNotifications(req.auth.userId, { limit: Number(req.query.limit) || 30 }),
      unreadCount(req.auth.userId),
    ])
    res.json({ notifications: items, unread })
  } catch (e) {
    console.error('[NOTIFICATIONS] list error:', e.message)
    res.status(500).json({ error: 'Could not load notifications' })
  }
})

// POST /read { ids?: string[] } — omit ids to mark everything read
router.post('/read', async (req, res) => {
  try {
    await markRead(req.auth.userId, req.body?.ids)
    res.json({ ok: true, unread: await unreadCount(req.auth.userId) })
  } catch (e) {
    console.error('[NOTIFICATIONS] read error:', e.message)
    res.status(500).json({ error: 'Could not update notifications' })
  }
})

export default router
