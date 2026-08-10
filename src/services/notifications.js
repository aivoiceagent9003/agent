// services/notifications.js — the bell feed.
//
// One row per person per event, so "read" is per-user. Creating a notification
// also pushes it over the realtime hub, which is what makes the browser play the
// alert sound without waiting for a poll.

import { supabase } from '../api/db.js'
import hub from './realtime-hub.js'

// Create notifications for several people at once and push them live.
// NEVER throws: a failed notification must not roll back the action that caused it
// (assigning a lead should still succeed if the bell feed write fails).
export async function notify(profileIds, { tenantId, kind, title, body, link }) {
  const ids = [...new Set((profileIds || []).filter(Boolean))]
  if (!ids.length) return []

  try {
    const { data, error } = await supabase.from('notifications').insert(
      ids.map(profile_id => ({
        profile_id, tenant_id: tenantId, kind, title, body: body || null, link: link || null,
      }))
    ).select('id, profile_id, kind, title, body, link, created_at, read_at')
    if (error) throw error

    for (const row of data || []) {
      hub.publish(row.profile_id, { type: 'notification', notification: row })
    }
    return data || []
  } catch (e) {
    console.error('[NOTIFY] failed:', e.message)
    return []
  }
}

export async function listNotifications(profileId, { limit = 30 } = {}) {
  const { data } = await supabase
    .from('notifications')
    .select('id, kind, title, body, link, read_at, created_at')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(Math.min(100, limit))
  return data || []
}

export async function unreadCount(profileId) {
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId)
    .is('read_at', null)
  return count || 0
}

export async function markRead(profileId, ids) {
  const now = new Date().toISOString()
  let q = supabase.from('notifications').update({ read_at: now }).eq('profile_id', profileId).is('read_at', null)
  if (Array.isArray(ids) && ids.length) q = q.in('id', ids)
  await q
}

export default { notify, listNotifications, unreadCount, markRead }
