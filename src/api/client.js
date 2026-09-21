// api/client.js — Client (tenant-scoped) endpoints
// The tenant is always taken from req.auth.tenantId (never from the request),
// so a client can only ever see their own data.

import { Router } from 'express'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { requirePermission, permissionsFor } from './permissions.js'
import { notify } from '../services/notifications.js'
import { getRecordingUrl } from '../services/recording.js'
const router = Router()

router.use(requireClient())

// ─── Who am I? ───────────────────────────────────────────────────────────────
// The one endpoint every signed-in user can call regardless of role. The dashboard
// shell needs the business name and the caller's permissions before it can render
// navigation — it previously called GET /api/client/agent for this, which employees
// have no business reading.
router.get('/me', async (req, res) => {
  try {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, name, phone_number, config')
      .eq('id', req.auth.tenantId)
      .single()

    // Best-effort: powers "last active" on the Team page. Never block the response.
    supabase.from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', req.auth.userId)
      .then(() => {}, () => {})

    const { data: profile } = await supabase
      .from('profiles').select('phone').eq('id', req.auth.userId).maybeSingle()

    res.json({
      user_id: req.auth.userId,
      email: req.auth.email,
      full_name: req.auth.fullName,
      phone: profile?.phone || null,
      role: req.auth.role,
      tenant_role: req.auth.tenantRole,
      permissions: permissionsFor(req.auth.tenantRole),
      tenant: {
        id: tenant?.id || null,
        name: tenant?.name || null,
        business_name: tenant?.config?.business_name || tenant?.name || null,
        // Onboarding is the OWNER's job — the shell uses this to decide whether to
        // redirect (owner) or show a "setup in progress" state (employee).
        phone_number: tenant?.phone_number || null,
        status: tenant?.config?.status || 'draft',
      },
    })
  } catch (e) {
    console.error('[CLIENT] me error:', e.message)
    res.status(500).json({ error: 'Could not load your profile' })
  }
})

// ─── PATCH /me — update your own profile ─────────────────────────────────────
// Name and phone only. Email is deliberately NOT editable here: changing the login
// address needs a verification round-trip to the new address, otherwise a typo
// locks you out of your own account.
router.patch('/me', async (req, res) => {
  const { full_name: fullName, phone } = req.body || {}
  const patch = {}

  if (fullName !== undefined) {
    const name = String(fullName).trim()
    if (name.length > 120) return res.status(400).json({ error: 'Name is too long' })
    patch.full_name = name || null
  }
  if (phone !== undefined) {
    const p = String(phone).trim()
    if (p && !/^[+0-9 ()-]{6,20}$/.test(p)) {
      return res.status(400).json({ error: 'That does not look like a phone number' })
    }
    patch.phone = p || null
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' })

  try {
    const { data, error } = await supabase
      .from('profiles').update(patch).eq('id', req.auth.userId)
      .select('id, email, full_name, phone, tenant_role').single()
    if (error) throw error
    res.json({ profile: data })
  } catch (e) {
    console.error('[CLIENT] profile update error:', e.message)
    res.status(500).json({ error: 'Could not save your profile' })
  }
})

// ─── Overview (dashboard summary) ─────────────────────────────────────────────
router.get('/overview', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const [{ data: stats }, { data: chart }] = await Promise.all([
      supabase.rpc('tenant_stats', { t_id: t }),
      supabase.rpc('tenant_calls_last_7_days', { t_id: t }),
    ])
    const s = stats?.[0] || {}
    res.json({
      total_calls: Number(s.total_calls || 0),
      total_minutes: Number(s.total_minutes || 0),
      total_leads: Number(s.total_leads || 0),
      handoff_count: Number(s.handoff_count || 0),
      avg_call_duration_seconds: Number(s.avg_call_duration_seconds || 0),
      calls_last_7_days: (chart || []).map(r => ({ date: r.date, count: Number(r.count) })),
    })
  } catch (e) {
    console.error('[CLIENT] overview error:', e.message)
    res.status(500).json({ error: 'Could not load overview' })
  }
})

// ─── Home (the client portal's front door) ───────────────────────────────────
// An executive command centre, deliberately NOT a second analytics page.
// Analytics answers "how are we performing over time" — trends, rates, charts.
// This answers five questions, in this order:
//
//   1. What is my AI doing right now?
//   2. What happened while I was away?
//   3. Does anything need me?
//   4. Is the agent healthy?
//   5. What should I do next?
//
// One endpoint, because a landing page that fires eight requests feels slow no
// matter how fast each one is. Everything below is derived from rows this tenant
// already owns — no counts are invented, and a section with no data says so.

const STALE_LEAD_HOURS = 48
const SILENT_ALERT_HOURS = 24
const HIGH_INTENT = 70          // interest_score 0-100 from the lead extractor
const KNOWLEDGE_STALE_DAYS = 90

// The extractor emits snake_case categories (booking_request, product_inquiry…).
// Known ones get proper wording; anything new degrades to Title Case rather than
// being dropped, so a prompt change can't silently empty the signals panel.
const INTENT_LABELS = {
  booking_request: 'Booking request',
  site_visit: 'Site visit',
  product_inquiry: 'Product inquiry',
  pricing_inquiry: 'Pricing',
  pricing: 'Pricing',
  availability: 'Availability',
  order_complaint: 'Complaint',
  complaint: 'Complaint',
  support: 'Support',
  billing: 'Billing',
  general_inquiry: 'General inquiry',
  appointment: 'Appointment',
}

function intentLabel(intent) {
  if (!intent) return 'General inquiry'
  return INTENT_LABELS[intent] || intent.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

/** 0-100 interest score → the three bands the UI colours by. */
function tone(lead) {
  const score = Number(lead?.raw_data?.interest_score)
  if (Number.isFinite(score) && score >= HIGH_INTENT) return 'high'
  if (lead?.intent && lead.intent !== 'general_inquiry') return 'warm'
  return 'cool'
}

const displayName = lead => lead?.name || null

router.get('/home', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  const now = Date.now()
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
  const dayAgo = new Date(now - 86400_000).toISOString()
  const weekAgo = new Date(now - 7 * 86400_000).toISOString()
  const staleBefore = new Date(now - STALE_LEAD_HOURS * 3600_000).toISOString()

  try {
    const [
      tenant, todayCalls, todayLeads, openLeads,
      lastCall, failedToday, knowledge, gaps, runningCampaigns, teamSize,
    ] = await Promise.all([
      supabase.from('tenants').select('name, phone_number, config').eq('id', t).single()
        .then(r => r.data || {}),

      // Today's calls, bounded: this is a landing page, not an export.
      supabase.from('calls').select('id, caller_number, duration_seconds, status, created_at')
        .eq('tenant_id', t).gte('created_at', startOfToday)
        .order('created_at', { ascending: false }).limit(200)
        .then(r => r.data || []),

      supabase.from('leads')
        .select('id, call_id, name, intent, summary, status, follow_up_needed, handed_off, created_at, raw_data')
        .eq('tenant_id', t).gte('created_at', startOfToday)
        .order('created_at', { ascending: false }).limit(200)
        .then(r => r.data || []),

      // Still-open leads drive the attention queue. One fetch, sliced several
      // ways below — separate counts for the same rows would be extra trips.
      supabase.from('leads')
        .select('id, call_id, name, caller_number, intent, summary, status, assigned_to, follow_up_needed, handed_off, updated_at, created_at, raw_data')
        .eq('tenant_id', t).in('status', ['new', 'contacted'])
        .order('created_at', { ascending: false }).limit(200)
        .then(r => r.data || []),

      supabase.from('calls').select('created_at')
        .eq('tenant_id', t).order('created_at', { ascending: false }).limit(1)
        .then(r => r.data?.[0]?.created_at || null),

      supabase.from('calls').select('id', { count: 'exact', head: true })
        .eq('tenant_id', t).eq('status', 'failed').gte('created_at', dayAgo)
        .then(r => r.count || 0),

      // Only the newest row and the total — the content itself is the Knowledge
      // page's business, not Home's.
      Promise.all([
        supabase.from('knowledge_base').select('id', { count: 'exact', head: true })
          .eq('tenant_id', t).then(r => r.count || 0),
        supabase.from('knowledge_base').select('created_at')
          .eq('tenant_id', t).order('created_at', { ascending: false }).limit(1)
          .then(r => r.data?.[0]?.created_at || null),
      ]).then(([count, updated_at]) => ({ count, updated_at })),

      supabase.from('knowledge_gaps').select('question, created_at')
        .eq('tenant_id', t).is('resolved_at', null).gte('created_at', weekAgo)
        .order('created_at', { ascending: false }).limit(200)
        .then(r => r.data || []),

      supabase.from('campaigns').select('id, name, type')
        .eq('tenant_id', t).eq('status', 'running').limit(5)
        .then(r => r.data || []),

      supabase.from('profiles').select('id', { count: 'exact', head: true })
        .eq('tenant_id', t).eq('status', 'active').then(r => r.count || 0),
    ])

    const config = tenant.config || {}
    const answeredToday = todayCalls.filter(c => c.status !== 'failed')
    const lastCallAgeHours = lastCall ? (now - new Date(lastCall).getTime()) / 3600_000 : null

    // A live number that has gone quiet for a day is almost always call
    // forwarding — the one thing only the client can check.
    const isLive = !!tenant.phone_number && config.status === 'published'
    const forwardingSuspect = isLive && (lastCallAgeHours === null || lastCallAgeHours > SILENT_ALERT_HOURS)

    // ── 1. Your AI today ──────────────────────────────────────────────────────
    const today = {
      conversations: answeredToday.length,
      high_intent: todayLeads.filter(l => tone(l) === 'high').length,
      follow_ups: todayLeads.filter(l => l.follow_up_needed).length,
      handoffs: todayLeads.filter(l => l.handed_off).length,
      leads: todayLeads.length,
      last_call_at: lastCall,
    }

    // ── 2. Needs your attention ───────────────────────────────────────────────
    // Ranked, not dumped. Genuine system faults first (nothing else matters if
    // the phone isn't ringing), then people waiting on a human, then money.
    const attention = []

    if (forwardingSuspect) {
      attention.push({
        id: 'agent:silent',
        rank: 0,
        kind: 'issue',
        // Lead with the observed fact, not a guessed cause. Forwarding is the
        // usual culprit, but the only thing we actually know is the silence.
        title: `Your number hasn't received a call in over ${SILENT_ALERT_HOURS} hours`,
        subtitle: lastCall
          ? `Nothing has reached ${tenant.phone_number} since then. Worth checking your number setup.`
          : `No call has ever reached ${tenant.phone_number}. Worth checking your number setup.`,
        to: '/onboarding',
        cta: 'Check setup',
        at: lastCall,
      })
    }

    if (failedToday > 0) {
      attention.push({
        id: 'agent:failed',
        rank: 1,
        kind: 'issue',
        title: `${failedToday} ${failedToday === 1 ? 'call' : 'calls'} failed in the last 24 hours`,
        subtitle: 'The caller reached your number but the agent could not pick up.',
        to: '/app/calls',
        cta: 'Open call log',
        at: null,
      })
    }

    // Handoff is on but there is nobody to hand off to.
    if (config.handoff_number && teamSize < 2) {
      attention.push({
        id: 'agent:team',
        rank: 5,
        kind: 'issue',
        title: "Handoff is on, but you're the only person here",
        subtitle: 'When a caller asks for a human, nobody but you can take it.',
        to: '/app/team',
        cta: 'Invite your team',
        at: null,
      })
    }

    for (const l of openLeads) {
      const who = displayName(l) || l.caller_number || 'A caller'
      const when = l.updated_at || l.created_at

      if (l.handed_off && l.status === 'new') {
        attention.push({
          id: `lead:handoff:${l.id}`,
          rank: 2,
          kind: 'handoff',
          title: who,
          subtitle: 'Asked to speak with a person — nobody has called back yet.',
          detail: l.summary,
          badge: intentLabel(l.intent),
          to: l.call_id ? `/app/calls/${l.call_id}` : '/app/leads',
          cta: 'Call back',
          at: when,
        })
      } else if (tone(l) === 'high' && l.status === 'new') {
        attention.push({
          id: `lead:hot:${l.id}`,
          rank: 3,
          kind: 'high_intent',
          title: who,
          subtitle: l.raw_data?.interest_reason || 'Showed strong buying interest.',
          detail: l.summary,
          badge: intentLabel(l.intent),
          to: l.call_id ? `/app/calls/${l.call_id}` : '/app/leads',
          cta: 'View conversation',
          at: when,
        })
      } else if (l.follow_up_needed) {
        attention.push({
          id: `lead:followup:${l.id}`,
          rank: 4,
          kind: 'follow_up',
          title: who,
          subtitle: 'Flagged for follow-up during the call.',
          detail: l.summary,
          badge: intentLabel(l.intent),
          to: l.call_id ? `/app/calls/${l.call_id}` : '/app/leads',
          cta: 'View conversation',
          at: when,
        })
      } else if (l.assigned_to && when < staleBefore) {
        attention.push({
          id: `lead:stale:${l.id}`,
          rank: 6,
          kind: 'stale',
          title: who,
          subtitle: `Assigned, then untouched for over ${STALE_LEAD_HOURS} hours.`,
          detail: l.summary,
          badge: intentLabel(l.intent),
          to: '/app/leads',
          cta: 'Open lead',
          at: when,
        })
      }
    }

    // Repeated unanswered questions are a real gap, one-offs are noise.
    const gapCounts = new Map()
    for (const g of gaps) {
      const key = g.question.toLowerCase().trim()
      const prev = gapCounts.get(key)
      if (prev) prev.count++
      else gapCounts.set(key, { question: g.question, count: 1, at: g.created_at })
    }
    const repeatedGaps = [...gapCounts.values()].filter(g => g.count >= 2)
      .sort((a, b) => b.count - a.count)
    if (repeatedGaps.length) {
      const top = repeatedGaps[0]
      attention.push({
        id: 'knowledge:gap',
        rank: 5,
        kind: 'knowledge',
        title: 'Your agent could not answer a repeated question',
        subtitle: `“${top.question}” came up ${top.count} times this week.`,
        to: '/app/knowledge',
        cta: 'Teach your agent',
        at: top.at,
      })
    }

    attention.sort((a, b) => a.rank - b.rank || (a.at && b.at ? (a.at < b.at ? 1 : -1) : 0))

    // ── 3. Customer signals ───────────────────────────────────────────────────
    // What people are asking about — a ranked list, not a chart. Today when
    // there's enough to be meaningful, otherwise the week, so a quiet morning
    // doesn't blank the panel.
    const signalSource = todayLeads.length >= 3 ? todayLeads : null
    let signalWindow = 'today'
    let signalLeads = signalSource
    if (!signalLeads) {
      signalWindow = 'this week'
      signalLeads = await supabase.from('leads').select('intent')
        .eq('tenant_id', t).gte('created_at', weekAgo).limit(500)
        .then(r => r.data || [])
    }

    const topicCounts = new Map()
    for (const l of signalLeads) {
      if (!l.intent) continue
      topicCounts.set(l.intent, (topicCounts.get(l.intent) || 0) + 1)
    }
    const topics = [...topicCounts]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([key, count]) => ({ key, label: intentLabel(key), count }))

    const topicTotal = topics.reduce((n, x) => n + x.count, 0)
    const signals = {
      window: signalWindow,
      topics,
      // Only claim a trend when one topic genuinely leads. "Everything is equally
      // popular" is not an insight.
      insight: topics.length && topics[0].count >= 2 && topics[0].count / topicTotal >= 0.4
        ? `${topics[0].label} is what most callers are asking about ${signalWindow}.`
        : null,
    }

    // ── 4. AI briefing ────────────────────────────────────────────────────────
    // Deterministic. An LLM call here would add cost and seconds to every page
    // load to restate numbers we already have exactly.
    const briefWindow = todayCalls.length ? 'today' : 'this week'
    const briefLeads = todayCalls.length
      ? todayLeads
      : await supabase.from('leads')
          .select('name, intent, summary, follow_up_needed, handed_off, raw_data')
          .eq('tenant_id', t).gte('created_at', weekAgo).limit(200)
          .then(r => r.data || [])

    const bullets = []
    const hot = briefLeads.filter(l => tone(l) === 'high')
    if (hot.length === 1) {
      bullets.push(`${displayName(hot[0]) || 'A customer'} showed strong interest — ${intentLabel(hot[0].intent).toLowerCase()}.`)
    } else if (hot.length > 1) {
      bullets.push(`${hot.length} customers showed strong buying interest.`)
    }

    if (topics.length) {
      const top = topics[0]
      bullets.push(`${top.count} ${top.count === 1 ? 'customer' : 'customers'} asked about ${top.label.toLowerCase()}.`)
    }

    const handoffCount = briefLeads.filter(l => l.handed_off).length
    if (handoffCount) {
      bullets.push(`${handoffCount} ${handoffCount === 1 ? 'conversation' : 'conversations'} needed a person.`)
    }

    const followUps = briefLeads.filter(l => l.follow_up_needed).length
    if (followUps) {
      bullets.push(`${followUps} ${followUps === 1 ? 'customer needs' : 'customers need'} a follow-up.`)
    }

    if (repeatedGaps.length) {
      bullets.push(`${repeatedGaps.length} question${repeatedGaps.length === 1 ? '' : 's'} your agent could not answer.`)
    }

    const lead = attention.find(a => a.kind !== 'issue')
    const briefing = {
      window: briefWindow,
      bullets: bullets.slice(0, 4),
      // The recommendation IS the top attention item — one place decides what
      // matters most, so the two panels can never disagree.
      recommendation: attention.length
        ? {
            text: attention[0].kind === 'issue'
              ? attention[0].title
              : `Follow up with ${attention[0].title} first.`,
            to: attention[0].to,
            cta: attention[0].cta,
          }
        : null,
      focus: lead ? lead.title : null,
    }

    // ── 5. Today's timeline ───────────────────────────────────────────────────
    // Calls and the leads they produced, merged. A lead event replaces its call
    // event, so one conversation is one line rather than two.
    const leadByCall = new Map(todayLeads.filter(l => l.call_id).map(l => [l.call_id, l]))
    const timeline = []
    for (const c of answeredToday) {
      const l = leadByCall.get(c.id)
      if (l && l.handed_off) {
        timeline.push({
          at: l.created_at, kind: 'handoff',
          title: 'Human handoff',
          detail: `${displayName(l) || c.caller_number} asked to speak with a person`,
          to: `/app/calls/${c.id}`,
        })
      } else if (l && tone(l) === 'high') {
        timeline.push({
          at: l.created_at, kind: 'high_intent',
          title: 'High-intent lead identified',
          detail: `${displayName(l) || c.caller_number} — ${intentLabel(l.intent).toLowerCase()}`,
          to: `/app/calls/${c.id}`,
        })
      } else if (l) {
        timeline.push({
          at: l.created_at, kind: 'lead',
          title: 'Lead captured',
          detail: l.summary || `${displayName(l) || c.caller_number} — ${intentLabel(l.intent).toLowerCase()}`,
          to: `/app/calls/${c.id}`,
        })
      } else {
        timeline.push({
          at: c.created_at, kind: 'call',
          title: 'AI answered a customer',
          detail: c.caller_number || 'Unknown caller',
          to: `/app/calls/${c.id}`,
        })
      }
    }
    timeline.sort((a, b) => (a.at < b.at ? 1 : -1))

    // ── 7. Agent status ───────────────────────────────────────────────────────
    const knowledgeAgeDays = knowledge.updated_at
      ? (now - new Date(knowledge.updated_at).getTime()) / 86400_000
      : null

    res.json({
      agent: {
        name: config.agent_name || config.business_name || tenant.name || 'Your AI agent',
        business: config.business_name || tenant.name || null,
        live: isLive,
        number: tenant.phone_number || null,
        handoff_number: config.handoff_number || null,
        knowledge: {
          count: knowledge.count,
          updated_at: knowledge.updated_at,
          // "Up to date" is a claim, so it needs a rule: something in there, and
          // touched within the quarter.
          fresh: knowledge.count > 0 && knowledgeAgeDays !== null && knowledgeAgeDays < KNOWLEDGE_STALE_DAYS,
        },
        forwarding_ok: isLive && !forwardingSuspect,
        last_call_at: lastCall,
        team_size: teamSize,
        // Drives the one-line status under the greeting. Never alarmist about a
        // quiet day — only about something actually broken.
        state: !isLive ? 'draft' : forwardingSuspect || failedToday > 0 ? 'attention' : 'ready',
      },
      today,
      attention: attention.slice(0, 5),
      attention_total: attention.length,
      signals,
      briefing,
      timeline: timeline.slice(0, 8),
      campaigns: runningCampaigns,
    })
  } catch (e) {
    console.error('[CLIENT] home error:', e.message)
    res.status(500).json({ error: 'Could not load your dashboard' })
  }
})

// ─── Analytics (everything the /app/analytics dashboard draws) ────────────────
// One endpoint, one round-trip: four headline rates, two trends and four
// breakdowns. Every number is derived from rows this tenant actually owns. Where
// there is genuinely no data the field is null and the UI shows "—", because a
// zero on a dashboard reads as a measurement rather than an absence.

// Supabase caps a select at 1000 rows. Silently truncating a busy month would not
// error — it would just report a confidently wrong average. Page until it ends.
async function fetchAll(build, { pageSize = 1000, max = 100_000 } = {}) {
  const out = []
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return out
}

// sql/analytics.sql adds the three per-call quality columns. Until it has been
// run they don't exist, and Postgres says so with 42703.
const isMissingColumn = e =>
  e?.code === '42703' || e?.code === 'PGRST204' ||
  /column .* does not exist|schema cache/i.test(e?.message || '')

const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada',
  ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi',
  // Code-mixed Hindi/English is what a great many callers actually speak. The
  // extractor reports it as its own language and clients recognise the name.
  hinglish: 'Hinglish',
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
const dayKey = iso => new Date(iso).toISOString().slice(0, 10)

/** Dense day-by-day series. A quiet day must render as a zero, not vanish — a
 *  chart that skips empty days misrepresents the shape of the week. */
function daySeries(rows, days, reduce) {
  const buckets = new Map()
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), [])
  }
  for (const r of rows) {
    const b = buckets.get(dayKey(r.created_at))
    if (b) b.push(r)
  }
  return [...buckets].map(([date, items]) => ({ date, ...reduce(items) }))
}

/** Count by field, biggest first, with the long tail folded into "Other". */
function breakdown(rows, field, { top = 0, label = v => v } = {}) {
  const counts = new Map()
  for (const r of rows) {
    const v = r[field]
    if (!v) continue
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  let list = [...counts].sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: label(key), count, pct: pct(count, total) }))
  if (top && list.length > top) {
    const rest = list.slice(top)
    list = list.slice(0, top)
    const count = rest.reduce((a, r) => a + r.count, 0)
    list.push({ key: 'other', label: 'Other', count, pct: pct(count, total) })
  }
  return list
}

router.get('/analytics', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30))
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString()

  const CALL_COLS = 'created_at, status, duration_seconds, avg_reply_ms, knowledge_asks, knowledge_hits'
  const BASE_COLS = 'created_at, status, duration_seconds'

  try {
    const callsFrom = cols => () => supabase.from('calls').select(cols)
      .eq('tenant_id', t).gte('created_at', sinceIso).order('created_at')

    // The quality columns are optional: without the migration the page still
    // draws, minus the two tiles that depend on them.
    let calls, hasQuality = true
    try {
      calls = await fetchAll(callsFrom(CALL_COLS))
    } catch (e) {
      if (!isMissingColumn(e)) throw e
      hasQuality = false
      calls = await fetchAll(callsFrom(BASE_COLS))
    }

    const leads = await fetchAll(() => supabase.from('leads')
      .select('created_at, language, sentiment, intent, follow_up_needed, handed_off')
      .eq('tenant_id', t).gte('created_at', sinceIso).order('created_at'))

    const total = calls.length
    const answered = calls.filter(c => c.status === 'completed').length
    // A call still ringing has neither succeeded nor failed. Leaving it in the
    // denominator makes a busy afternoon look like an outage.
    const settled = calls.filter(c => c.status !== 'active').length

    const sum = (rows, f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0)
    const asks = hasQuality ? sum(calls, 'knowledge_asks') : 0
    const hits = hasQuality ? sum(calls, 'knowledge_hits') : 0
    const replied = hasQuality ? calls.filter(c => Number(c.avg_reply_ms) > 0) : []

    const withDuration = calls.filter(c => Number(c.duration_seconds) > 0)

    res.json({
      range_days: days,
      total_calls: total,
      // Null, not zero: "no calls yet" and "nobody picked up" are different facts.
      kpis: {
        pickup_rate: settled ? pct(answered, settled) : null,
        handoff_rate: settled ? pct(leads.filter(l => l.handed_off).length, settled) : null,
        info_hit_rate: asks ? pct(hits, asks) : null,
        avg_reply_ms: replied.length ? Math.round(sum(replied, 'avg_reply_ms') / replied.length) : null,
      },
      call_volume: daySeries(calls, days, items => ({ calls: items.length })),
      duration_trend: daySeries(calls, Math.min(days, 15), items => {
        const real = items.filter(c => Number(c.duration_seconds) > 0)
        return {
          avg_seconds: real.length
            ? Math.round(real.reduce((a, c) => a + c.duration_seconds, 0) / real.length)
            : null,   // a day with no calls breaks the line rather than dropping to 0
        }
      }),
      avg_duration_seconds: withDuration.length
        ? Math.round(withDuration.reduce((a, c) => a + c.duration_seconds, 0) / withDuration.length)
        : 0,
      languages: breakdown(leads, 'language', { label: c => LANGUAGE_NAMES[c] || c }),
      sentiment: breakdown(leads, 'sentiment', { label: s => s[0].toUpperCase() + s.slice(1) }),
      intents: breakdown(leads, 'intent', { top: 5 }),
      funnel: {
        calls_handled: total,
        conversations: answered,
        leads_captured: leads.length,
        follow_ups: leads.filter(l => l.follow_up_needed).length,
      },
    })
  } catch (e) {
    console.error('[CLIENT] analytics error:', e.message)
    res.status(500).json({ error: 'Could not load analytics' })
  }
})

// ─── Calls (paginated list) ───────────────────────────────────────────────────
router.get('/calls', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, parseInt(req.query.limit) || 20)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    let q = supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, created_at, direction, campaign_id', { count: 'exact' })
      .eq('tenant_id', t)
      .order('created_at', { ascending: false })

    // Optional direction filter so the dashboard can show separate Inbound /
    // Outbound tabs. Anything not explicitly 'outbound' (incl. legacy NULL rows)
    // counts as inbound.
    if (req.query.direction === 'outbound') q = q.eq('direction', 'outbound')
    else if (req.query.direction === 'inbound') q = q.or('direction.is.null,direction.neq.outbound')

    const { data, count, error } = await q.range(from, to)
    if (error) throw error

    // Mark which calls have a lead
    const ids = (data || []).map(c => c.id)
    let leadCallIds = new Set()
    if (ids.length) {
      const { data: leadRows } = await supabase
        .from('leads').select('call_id').in('call_id', ids)
      leadCallIds = new Set((leadRows || []).map(l => l.call_id))
    }

    res.json({
      calls: (data || []).map(c => ({ ...c, has_lead: leadCallIds.has(c.id) })),
      total: count || 0, page, limit,
    })
  } catch (e) {
    console.error('[CLIENT] calls error:', e.message)
    res.status(500).json({ error: 'Could not load calls' })
  }
})

// ─── Single call (transcript + lead) ──────────────────────────────────────────
router.get('/calls/:id', requirePermission('calls:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: call, error } = await supabase
      .from('calls')
      .select('id, caller_number, status, duration_seconds, transcript, recording_path, created_at')
      .eq('id', req.params.id)
      .eq('tenant_id', t)   // scope guard
      .single()
    if (error || !call) return res.status(404).json({ error: 'Call not found' })

    const { data: lead } = await supabase
      .from('leads').select('*').eq('call_id', call.id).maybeSingle()

    // Mint a short-lived signed URL for in-dashboard playback (bucket is private).
    const recording_url = await getRecordingUrl(call.recording_path)

    res.json({ ...call, recording_url, lead: lead || null })
  } catch (e) {
    console.error('[CLIENT] call detail error:', e.message)
    res.status(500).json({ error: 'Could not load call' })
  }
})

// ─── Leads (paginated, filterable) ────────────────────────────────────────────
router.get('/leads', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(100, parseInt(req.query.limit) || 20)
  const from = (page - 1) * limit
  const to = from + limit - 1

  try {
    let q = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('tenant_id', t)
      .order('created_at', { ascending: false })

    if (req.query.intent) q = q.eq('intent', req.query.intent)
    if (req.query.sentiment) q = q.eq('sentiment', req.query.sentiment)
    if (req.query.follow_up === 'true') q = q.eq('follow_up_needed', true)
    if (req.query.status) q = q.eq('status', req.query.status)
    // 'me' powers an agent's default view without the frontend knowing its own id.
    if (req.query.assigned_to === 'me') q = q.eq('assigned_to', req.auth.userId)
    else if (req.query.assigned_to === 'unassigned') q = q.is('assigned_to', null)
    else if (req.query.assigned_to) q = q.eq('assigned_to', req.query.assigned_to)

    const { data, count, error } = await q.range(from, to)
    if (error) throw error

    // Attach each lead's call transcript (lives on the calls table, linked by
    // call_id) so the Leads UI can show it without a second round-trip per row.
    const leads = data || []
    const callIds = [...new Set(leads.map(l => l.call_id).filter(Boolean))]
    if (callIds.length) {
      const { data: calls } = await supabase
        .from('calls').select('id, transcript').in('id', callIds)
      const byId = new Map((calls || []).map(c => [c.id, c.transcript]))
      for (const l of leads) l.transcript = byId.get(l.call_id) || null
    }

    res.json({ leads, total: count || 0, page, limit })
  } catch (e) {
    console.error('[CLIENT] leads error:', e.message)
    res.status(500).json({ error: 'Could not load leads' })
  }
})

// ─── Export leads as CSV ──────────────────────────────────────────────────────
router.get('/leads/export', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase
      .from('leads').select('*').eq('tenant_id', t)
      .order('created_at', { ascending: false })
    if (error) throw error

    const cols = ['created_at', 'name', 'intent', 'summary', 'sentiment',
      'language', 'follow_up_needed', 'handed_off', 'contact_info', 'caller_number']
    const esc = v => {
      if (v == null) return ''
      const s = Array.isArray(v) ? v.join('; ') : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = cols.join(',')
    const rows = (data || []).map(r => cols.map(c => esc(r[c])).join(','))
    const csv = [header, ...rows].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"')
    res.send(csv)
  } catch (e) {
    console.error('[CLIENT] export error:', e.message)
    res.status(500).json({ error: 'Could not export leads' })
  }
})

// ─── Single lead (everything the detail page needs in one round-trip) ─────────
// Declared AFTER /leads/export so Express can't match "export" as an :id.
router.get('/leads/:id', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: lead, error } = await supabase
      .from('leads').select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', t)   // scope guard: business A can never read business B's lead
      .maybeSingle()
    if (error) throw error
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    // The recording, its length and the transcript live on the call, not the lead.
    let recording_url = null
    let duration_seconds = null
    let transcript = null
    if (lead.call_id) {
      const { data: call } = await supabase
        .from('calls').select('duration_seconds, recording_path, transcript')
        .eq('id', lead.call_id).eq('tenant_id', t).maybeSingle()
      if (call) {
        duration_seconds = call.duration_seconds ?? null
        recording_url = await getRecordingUrl(call.recording_path)  // signed, expiring
        // Verbatim, in whatever language was spoken. The lead's `summary` is the AI's
        // reading of the call; this is the call. Someone chasing the lead needs to be
        // able to check one against the other without downloading the audio.
        transcript = call.transcript ?? null
      }
    }

    // Resolve the assignee here — the page shows a name, not a uuid.
    let assignee = null
    if (lead.assigned_to) {
      const { data: p } = await supabase
        .from('profiles').select('id, full_name, email')
        .eq('id', lead.assigned_to).eq('tenant_id', t).maybeSingle()
      if (p) assignee = { id: p.id, name: p.full_name || p.email }
    }

    res.json({
      lead: {
        ...lead,
        recording_url,
        duration_seconds,
        transcript,
        assignee,
        ...contactFields(lead),
        ...priorityFields(lead),
      },
    })
  } catch (e) {
    console.error('[CLIENT] lead detail error:', e.message)
    res.status(500).json({ error: 'Could not load the lead' })
  }
})

// The extractor captures ONE alternate contact in `contact_info` ("a phone number
// OR an email"). The detail page has separate Email / Alt number rows, so resolve
// the ambiguity here rather than teaching the UI about it.
const looksLikeEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

function contactFields(lead) {
  const raw = lead.raw_data || {}
  const value = (lead.contact_info || '').trim()
  return {
    email: raw.email || (looksLikeEmail(value) ? value : null),
    alt_phone: raw.alt_phone || (value && !looksLikeEmail(value) ? value : null),
  }
}

// interest_score is 0-100 from the extractor; the UI shows priority out of 10.
function priorityFields(lead) {
  const raw = lead.raw_data || {}
  const score = Number(raw.interest_score)
  return {
    priority_score: Number.isFinite(score) ? Math.round(score / 10) : null,
    priority_reason: raw.interest_reason || null,
  }
}

// ─── Update a lead (status / assignment / notes / follow-up) ──────────────────
// This is the whole point of employee access: a lead arrives from a call, and a
// person moves it through the pipeline. Every change appends to lead_activity so
// there is an answer to "who marked this won, and when".
const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost']

router.patch('/leads/:id', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  const { status, assigned_to, notes, follow_up_needed } = req.body || {}

  if (status !== undefined && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` })
  }

  try {
    // Scope the read to the tenant FIRST — this is what stops a valid user of
    // business A from editing a lead belonging to business B.
    const { data: existing } = await supabase
      .from('leads').select('id, status, assigned_to, follow_up_needed')
      .eq('id', req.params.id).eq('tenant_id', t).maybeSingle()
    if (!existing) return res.status(404).json({ error: 'Lead not found' })

    // An assignee must be a real member of THIS business. Never trust the id.
    if (assigned_to) {
      const { data: member } = await supabase
        .from('profiles').select('id').eq('id', assigned_to).eq('tenant_id', t).maybeSingle()
      if (!member) return res.status(400).json({ error: 'That person is not a member of this business' })
    }

    const patch = { updated_at: new Date().toISOString() }
    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = notes
    if (assigned_to !== undefined) patch.assigned_to = assigned_to || null
    if (follow_up_needed !== undefined) patch.follow_up_needed = !!follow_up_needed

    const { data: updated, error } = await supabase
      .from('leads').update(patch).eq('id', req.params.id).eq('tenant_id', t).select().single()
    if (error) throw error

    // Audit trail — one row per meaningful change, not per request.
    const events = []
    if (status !== undefined && status !== existing.status) {
      events.push({ action: 'status_changed', detail: { from: existing.status, to: status } })
    }
    if (assigned_to !== undefined && (assigned_to || null) !== existing.assigned_to) {
      events.push(assigned_to
        ? { action: 'assigned', detail: { to: assigned_to, from: existing.assigned_to } }
        : { action: 'unassigned', detail: { from: existing.assigned_to } })
    }
    if (notes !== undefined) {
      events.push({ action: 'note_added', detail: { preview: String(notes || '').slice(0, 80) } })
    }
    if (follow_up_needed !== undefined && !!follow_up_needed !== !!existing.follow_up_needed) {
      events.push({ action: follow_up_needed ? 'follow_up_set' : 'follow_up_cleared', detail: {} })
    }

    if (events.length) {
      await supabase.from('lead_activity').insert(
        events.map(e => ({ ...e, lead_id: req.params.id, tenant_id: t, actor_id: req.auth.userId }))
      )
    }

    // Tell someone a lead landed on their desk — but never notify yourself for
    // claiming your own lead, which is the most common assignment by far.
    if (assigned_to && assigned_to !== existing.assigned_to && assigned_to !== req.auth.userId) {
      await notify([assigned_to], {
        tenantId: t,
        kind: 'lead_assigned',
        title: 'A lead was assigned to you',
        body: updated.name ? `${updated.name} — ${updated.intent || 'new enquiry'}` : (updated.summary || '').slice(0, 140),
        link: '/leads',
      })
    }

    res.json({ lead: updated })
  } catch (e) {
    console.error('[CLIENT] lead update error:', e.message)
    res.status(500).json({ error: 'Could not update the lead' })
  }
})

// ─── Lead activity timeline ───────────────────────────────────────────────────
router.get('/leads/:id/activity', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase
      .from('lead_activity')
      .select('id, action, detail, actor_id, created_at')
      .eq('lead_id', req.params.id).eq('tenant_id', t)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error

    // Resolve ids to names so the timeline reads "Priya assigned this to Ravi" —
    // both the actor and, for assignments, the person it landed on.
    const peopleIds = [...new Set(
      (data || []).flatMap(a => [a.actor_id, a.detail?.to]).filter(Boolean)
    )]
    let byId = new Map()
    if (peopleIds.length) {
      const { data: people } = await supabase
        .from('profiles').select('id, full_name, email').in('id', peopleIds)
      byId = new Map((people || []).map(p => [p.id, p.full_name || p.email]))
    }

    res.json({
      activity: (data || []).map(a => ({
        ...a,
        actor_name: byId.get(a.actor_id) || 'Someone',
        assignee_name: a.detail?.to ? byId.get(a.detail.to) || null : null,
      })),
    })
  } catch (e) {
    console.error('[CLIENT] lead activity error:', e.message)
    res.status(500).json({ error: 'Could not load activity' })
  }
})

// ─── Log a call a person made by hand ─────────────────────────────────────────
// The call happened on their own handset, so there is nothing to record — this is
// purely an activity row, which is what "did anyone actually ring them?" needs.
// Status is deliberately left alone; "Mark contacted" is its own button.
router.post('/leads/:id/log-call', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  const outcome = String((req.body || {}).outcome || 'called').slice(0, 80)
  try {
    const { data: lead } = await supabase
      .from('leads').select('id').eq('id', req.params.id).eq('tenant_id', t).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { error } = await supabase.from('lead_activity').insert({
      lead_id: lead.id, tenant_id: t, actor_id: req.auth.userId,
      action: 'call_logged', detail: { outcome },
    })
    if (error) throw error

    res.json({ ok: true })
  } catch (e) {
    console.error('[CLIENT] log call error:', e.message)
    res.status(500).json({ error: 'Could not log the call' })
  }
})

// ─── Team comments on a lead ──────────────────────────────────────────────────
// Distinct from leads.notes, which is one shared scratchpad anyone overwrites.
// This is a conversation: who said what, when, and replies. Threading is ONE
// level deep — a reply to a reply is normalised onto its root so it can never
// become invisible in a UI that only renders two tiers.
const MAX_COMMENT = 500

// sql/lead_comments.sql may not have been run against this database yet. Reads
// degrade to an empty thread (a missing table shouldn't break the whole page);
// writes say plainly what to run.
const isMissingCommentsTable = e =>
  e?.code === '42P01' || e?.code === 'PGRST205' ||
  /lead_comments/i.test(e?.message || '') && /does not exist|schema cache/i.test(e?.message || '')

/** Attach author names + "can I edit this?" — the UI shows a name and an Edit button. */
async function withAuthors(rows, meId) {
  const list = rows || []
  const ids = [...new Set(list.map(c => c.author_id).filter(Boolean))]
  let byId = new Map()
  if (ids.length) {
    const { data: people } = await supabase
      .from('profiles').select('id, full_name, email').in('id', ids)
    byId = new Map((people || []).map(p => [p.id, p.full_name || p.email]))
  }
  return list.map(c => ({
    ...c,
    author_name: byId.get(c.author_id) || 'Someone',
    is_mine: c.author_id === meId,
  }))
}

router.get('/leads/:id/comments', requirePermission('leads:read'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data, error } = await supabase
      .from('lead_comments')
      .select('id, body, author_id, parent_id, edited_at, created_at')
      .eq('lead_id', req.params.id).eq('tenant_id', t)
      .order('created_at', { ascending: true })
    if (error) throw error

    res.json({ comments: await withAuthors(data, req.auth.userId) })
  } catch (e) {
    if (isMissingCommentsTable(e)) return res.json({ comments: [] })
    console.error('[CLIENT] lead comments error:', e.message)
    res.status(500).json({ error: 'Could not load comments' })
  }
})

router.post('/leads/:id/comments', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  const body = String((req.body || {}).body || '').trim().slice(0, MAX_COMMENT)
  const parentId = (req.body || {}).parent_id || null
  if (!body) return res.status(400).json({ error: 'Write something first' })

  try {
    const { data: lead } = await supabase
      .from('leads').select('id, name, assigned_to')
      .eq('id', req.params.id).eq('tenant_id', t).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    // A reply must point at a comment on THIS lead — never trust the id.
    let rootId = null
    if (parentId) {
      const { data: parent } = await supabase
        .from('lead_comments').select('id, parent_id')
        .eq('id', parentId).eq('lead_id', lead.id).eq('tenant_id', t).maybeSingle()
      if (!parent) return res.status(400).json({ error: 'That comment no longer exists' })
      rootId = parent.parent_id || parent.id
    }

    const { data: created, error } = await supabase.from('lead_comments').insert({
      lead_id: lead.id, tenant_id: t, author_id: req.auth.userId,
      body, parent_id: rootId,
    }).select('id, body, author_id, parent_id, edited_at, created_at').single()
    if (error) throw error

    // Tell whoever owns the lead that someone weighed in — but never yourself.
    if (lead.assigned_to && lead.assigned_to !== req.auth.userId) {
      await notify([lead.assigned_to], {
        tenantId: t,
        kind: 'lead_comment',
        title: 'New comment on your lead',
        body: `${lead.name || 'A lead'} — ${body.slice(0, 120)}`,
        link: '/leads',
      })
    }

    const [comment] = await withAuthors([created], req.auth.userId)
    res.status(201).json({ comment })
  } catch (e) {
    if (isMissingCommentsTable(e)) {
      return res.status(503).json({ error: 'Comments are not set up yet — run sql/lead_comments.sql' })
    }
    console.error('[CLIENT] add comment error:', e.message)
    res.status(500).json({ error: 'Could not post the comment' })
  }
})

// Edit / delete your OWN comment. author_id in the filter IS the authorisation —
// a mismatch returns no row, so there is no separate check to forget.
router.patch('/leads/:id/comments/:commentId', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  const body = String((req.body || {}).body || '').trim().slice(0, MAX_COMMENT)
  if (!body) return res.status(400).json({ error: 'A comment cannot be empty' })

  try {
    const { data: updated, error } = await supabase
      .from('lead_comments')
      .update({ body, edited_at: new Date().toISOString() })
      .eq('id', req.params.commentId).eq('lead_id', req.params.id)
      .eq('tenant_id', t).eq('author_id', req.auth.userId)
      .select('id, body, author_id, parent_id, edited_at, created_at')
      .maybeSingle()
    if (error) throw error
    if (!updated) return res.status(404).json({ error: 'That comment is not yours to edit' })

    const [comment] = await withAuthors([updated], req.auth.userId)
    res.json({ comment })
  } catch (e) {
    console.error('[CLIENT] edit comment error:', e.message)
    res.status(500).json({ error: 'Could not save the comment' })
  }
})

router.delete('/leads/:id/comments/:commentId', requirePermission('leads:write'), async (req, res) => {
  const t = req.auth.tenantId
  try {
    const { data: deleted, error } = await supabase
      .from('lead_comments').delete()
      .eq('id', req.params.commentId).eq('lead_id', req.params.id)
      .eq('tenant_id', t).eq('author_id', req.auth.userId)
      .select('id').maybeSingle()
    if (error) throw error
    if (!deleted) return res.status(404).json({ error: 'That comment is not yours to delete' })

    res.json({ ok: true })
  } catch (e) {
    console.error('[CLIENT] delete comment error:', e.message)
    res.status(500).json({ error: 'Could not delete the comment' })
  }
})

export default router