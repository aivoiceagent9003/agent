// services/conversations.js — thread provisioning, membership, and unread counts.
//
// Three kinds of thread (see sql/messaging.sql):
//   team    — one per business, everyone is a member. Created on first visit.
//   direct  — 1:1 between two members of the same business, de-duped by member pair.
//   support — ONE PER PERSON ↔ AnswerLabs staff. Answered from the admin panel.
//
// Threads are provisioned LAZILY (on first open of the Messages screen) rather than
// at signup, so businesses that never message never accumulate empty rows — and so
// this feature needed no backfill for existing tenants.

import { supabase } from '../api/db.js'

// ─── Provisioning ────────────────────────────────────────────────────────────

// The team thread contains every active member of the business. Membership is
// reconciled on each call so people invited later are pulled in automatically.
export async function ensureTeamConversation(tenantId, tenantName) {
  let { data: convo } = await supabase
    .from('conversations').select('*')
    .eq('tenant_id', tenantId).eq('kind', 'team').maybeSingle()

  if (!convo) {
    const { data, error } = await supabase.from('conversations').insert({
      tenant_id: tenantId,
      kind: 'team',
      title: tenantName ? `${tenantName} Team` : 'Team',
    }).select().single()
    // A concurrent first-open can lose the race against the unique index; the
    // other request won, so just read theirs.
    if (error) {
      const { data: existing } = await supabase
        .from('conversations').select('*')
        .eq('tenant_id', tenantId).eq('kind', 'team').maybeSingle()
      if (!existing) throw error
      convo = existing
    } else {
      convo = data
    }
  }

  await syncTeamMembers(convo.id, tenantId)
  return convo
}

// Add any active member of the business who isn't in the team thread yet.
async function syncTeamMembers(conversationId, tenantId) {
  const [{ data: people }, { data: members }] = await Promise.all([
    supabase.from('profiles').select('id').eq('tenant_id', tenantId).eq('status', 'active'),
    supabase.from('conversation_members').select('profile_id').eq('conversation_id', conversationId),
  ])
  const present = new Set((members || []).map(m => m.profile_id))
  const missing = (people || []).filter(p => !present.has(p.id))
  if (!missing.length) return
  await supabase.from('conversation_members').insert(
    missing.map(p => ({ conversation_id: conversationId, profile_id: p.id }))
  )
}

// A support thread belongs to ONE PERSON, identified by conversations.created_by,
// and they are its only member.
//
// It used to be one thread per business with every member joined, which meant an
// employee raising a problem with AnswerLabs did it in front of their employer.
// Support is exactly where someone needs to be able to speak privately, so the
// thread is now per person. AnswerLabs staff still answer from the admin panel, which
// addresses threads by id and never relies on membership.
export async function ensureSupportConversation(tenantId, profileId) {
  let { data: convo } = await supabase
    .from('conversations').select('*')
    .eq('tenant_id', tenantId).eq('kind', 'support').eq('created_by', profileId).maybeSingle()

  if (!convo) {
    const { data, error } = await supabase.from('conversations').insert({
      tenant_id: tenantId, kind: 'support', created_by: profileId, title: 'AnswerLabs Support',
    }).select().single()

    if (error) {
      // Either a concurrent first-open won the race, or sql/support-private.sql
      // has not been run yet and the old one-thread-per-tenant unique index is
      // still rejecting this. Re-read; if there is genuinely nothing, warn and
      // carry on — a missing support thread must not 500 the whole Messages page.
      const { data: existing } = await supabase
        .from('conversations').select('*')
        .eq('tenant_id', tenantId).eq('kind', 'support').eq('created_by', profileId).maybeSingle()
      if (!existing) {
        console.warn(
          '[CONVERSATIONS] could not provision a private support thread ' +
          '(has sql/support-private.sql been run?):', error.message
        )
        return null
      }
      convo = existing
    } else {
      convo = data

      // Opening line so the thread isn't an empty box.
      await supabase.from('messages').insert({
        conversation_id: convo.id,
        tenant_id: tenantId,
        is_system: true,
        body: "Hi! This is AnswerLabs Support. Ask us anything about your agent, your numbers, or your account and we'll get back to you here.",
      })
    }
  }

  // Membership is exactly one person. The delete is the privacy boundary made
  // self-healing: whatever left extra members on this thread — the old shared
  // model, a half-applied migration — they are gone on the next open.
  await supabase.from('conversation_members')
    .upsert({ conversation_id: convo.id, profile_id: profileId }, { ignoreDuplicates: true })
  await supabase.from('conversation_members')
    .delete().eq('conversation_id', convo.id).neq('profile_id', profileId)

  return convo
}

// A 1:1 thread. De-duped by member pair: we look for an existing direct thread
// that both people are already in, rather than relying on a unique index (which
// can't express "same unordered pair" across two rows).
export async function ensureDirectConversation(tenantId, profileA, profileB) {
  if (profileA === profileB) throw new Error('Cannot open a direct thread with yourself')

  const { data: mine } = await supabase
    .from('conversation_members').select('conversation_id').eq('profile_id', profileA)
  const ids = (mine || []).map(m => m.conversation_id)

  if (ids.length) {
    const { data: shared } = await supabase
      .from('conversation_members').select('conversation_id')
      .eq('profile_id', profileB).in('conversation_id', ids)
    const sharedIds = (shared || []).map(s => s.conversation_id)
    if (sharedIds.length) {
      const { data: existing } = await supabase
        .from('conversations').select('*')
        .eq('tenant_id', tenantId).eq('kind', 'direct').in('id', sharedIds).limit(1)
      if (existing?.length) return existing[0]
    }
  }

  const { data: convo, error } = await supabase.from('conversations').insert({
    tenant_id: tenantId, kind: 'direct', created_by: profileA,
  }).select().single()
  if (error) throw error

  await supabase.from('conversation_members').insert([
    { conversation_id: convo.id, profile_id: profileA },
    { conversation_id: convo.id, profile_id: profileB },
  ])
  return convo
}

// ─── Reads ───────────────────────────────────────────────────────────────────

// Every thread this person can see, newest activity first, with the other
// participant's name (for direct threads), a preview, and an unread count.
export async function listConversations(tenantId, profileId) {
  const { data: memberships } = await supabase
    .from('conversation_members')
    .select('conversation_id, last_read_at')
    .eq('profile_id', profileId)

  const ids = (memberships || []).map(m => m.conversation_id)
  if (!ids.length) return []
  const readAt = new Map((memberships || []).map(m => [m.conversation_id, m.last_read_at]))

  const { data: convos } = await supabase
    .from('conversations').select('*')
    .eq('tenant_id', tenantId).in('id', ids)
    .order('last_message_at', { ascending: false })

  if (!convos?.length) return []

  // Everyone in these threads, so direct threads can be labelled with the other
  // person and the team thread can show a member count.
  const [{ data: allMembers }, { data: previews }] = await Promise.all([
    supabase.from('conversation_members').select('conversation_id, profile_id').in('conversation_id', ids),
    supabase.from('messages')
      .select('conversation_id, body, created_at, sender_id, is_system')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .limit(400),
  ])

  const peopleIds = [...new Set((allMembers || []).map(m => m.profile_id))]
  const { data: people } = peopleIds.length
    ? await supabase.from('profiles').select('id, full_name, email, tenant_role').in('id', peopleIds)
    : { data: [] }
  const byId = new Map((people || []).map(p => [p.id, p]))

  // First message seen per conversation is the newest (query is sorted desc).
  const lastByConvo = new Map()
  for (const m of previews || []) {
    if (!lastByConvo.has(m.conversation_id)) lastByConvo.set(m.conversation_id, m)
  }

  const membersByConvo = new Map()
  for (const m of allMembers || []) {
    if (!membersByConvo.has(m.conversation_id)) membersByConvo.set(m.conversation_id, [])
    membersByConvo.get(m.conversation_id).push(m.profile_id)
  }

  const unread = await unreadCounts(ids, readAt, profileId)

  return convos.map(c => {
    const memberIds = membersByConvo.get(c.id) || []
    const others = memberIds.filter(id => id !== profileId).map(id => byId.get(id)).filter(Boolean)
    const last = lastByConvo.get(c.id)
    const title =
      c.kind === 'direct'
        ? (others[0]?.full_name || others[0]?.email || 'Direct message')
        : (c.title || (c.kind === 'support' ? 'AnswerLabs Support' : 'Team'))

    return {
      id: c.id,
      kind: c.kind,
      title,
      member_count: memberIds.length,
      members: others.map(p => ({ id: p.id, name: p.full_name || p.email, role: p.tenant_role })),
      last_message: last
        ? {
            body: last.body,
            created_at: last.created_at,
            from_me: last.sender_id === profileId,
            is_system: last.is_system,
          }
        : null,
      last_message_at: c.last_message_at,
      unread: unread.get(c.id) || 0,
    }
  })
}

// Messages newer than the reader's last_read_at, excluding their own.
async function unreadCounts(conversationIds, readAtMap, profileId) {
  const counts = new Map()
  await Promise.all(conversationIds.map(async (id) => {
    const since = readAtMap.get(id) || new Date(0).toISOString()
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', id)
      .gt('created_at', since)
      .neq('sender_id', profileId)
    if (count) counts.set(id, count)
  }))
  return counts
}

export async function isMember(conversationId, profileId) {
  const { data } = await supabase
    .from('conversation_members').select('profile_id')
    .eq('conversation_id', conversationId).eq('profile_id', profileId).maybeSingle()
  return !!data
}

// Message history, oldest-first for rendering. Sender names resolved here so the
// UI doesn't need a second round-trip per message.
export async function listMessages(conversationId, { limit = 100, before } = {}) {
  let q = supabase
    .from('messages')
    .select('id, sender_id, is_system, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(Math.min(200, limit))
  if (before) q = q.lt('created_at', before)

  const { data } = await q
  const rows = (data || []).reverse()

  const senderIds = [...new Set(rows.map(m => m.sender_id).filter(Boolean))]
  const { data: people } = senderIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', senderIds)
    : { data: [] }
  const byId = new Map((people || []).map(p => [p.id, p.full_name || p.email]))

  return rows.map(m => ({
    ...m,
    sender_name: m.is_system ? 'AnswerLabs Support' : (byId.get(m.sender_id) || 'Someone'),
  }))
}

export async function markRead(conversationId, profileId) {
  await supabase.from('conversation_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId).eq('profile_id', profileId)
}

// Total unread across every thread — the sidebar badge.
export async function totalUnread(tenantId, profileId) {
  const convos = await listConversations(tenantId, profileId)
  return convos.reduce((sum, c) => sum + (c.unread || 0), 0)
}

// Who else should be notified about a new message.
export async function recipientsOf(conversationId, exceptProfileId) {
  const { data } = await supabase
    .from('conversation_members').select('profile_id').eq('conversation_id', conversationId)
  return (data || []).map(m => m.profile_id).filter(id => id && id !== exceptProfileId)
}
