import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { createGeminiLiveConnection } from './services/gemini-live.js'
import { clearHistory } from './services/llm.js'
import { supabase } from './api/db.js'
import publicRoutes from './api/public.js'
import clientRoutes from './api/client.js'
import adminRoutes from './api/admin.js'
import agentRoutes from './api/agent.js'
import authRoutes from './api/auth-routes.js'
import signupRoutes from './api/signup.js'
import opsRoutes from './api/ops.js'
import dsrRoutes from './api/dsr.js'
import { vobizAnswer, vobizHangup, handleVobizConnection, vobizTransferXml } from './telephony/vobiz.js'
import { handleDemoConnection } from './telephony/demo.js'
import { answerCampaign, handleCampaignConnection } from './telephony/campaign.js'
import campaignRoutes from './api/campaigns.js'
import eventRoutes from './api/events.js'
import instantRoutes from './api/instant.js'
import whatsappRoutes from './api/whatsapp.js'
import teamRoutes from './api/team.js'
import messageRoutes from './api/messages.js'
import notificationRoutes from './api/notifications.js'
import hub from './services/realtime-hub.js'
import telemetry from './services/telemetry.js'
import { requireWebhookSecret, WEBHOOK_SECRET_SET, timingSafeStringEqual } from './api/webhook-auth.js'
import { apiLimiter, authLimiter, instantCallLimiter } from './api/rate-limits.js'
import { logNotifyConfig } from './services/notify.js'
import helmet from 'helmet'
import { mountHealth, installShutdown, installCrashHandlers, reconcileOrphanedCalls, errorHandler } from './api/lifecycle.js'
import 'dotenv/config'

const app = express()
const IS_PROD = process.env.NODE_ENV === 'production'

// Installed before anything else can throw, so a failure during boot is visible
// rather than a silent exit.
installCrashHandlers()

// ─── Boot-time config gate ────────────────────────────────────────────────────
// A missing secret must stop the deploy, not silently downgrade it. Each of these
// fails open in a way that is invisible at runtime — a wildcard CORS header, an
// unauthenticated webhook — so production refuses to start without them.
if (IS_PROD) {
  const missing = []
  if (!process.env.FRONTEND_ORIGIN) missing.push('FRONTEND_ORIGIN (CORS would fall back to a wildcard)')
  if (!WEBHOOK_SECRET_SET) missing.push('WEBHOOK_SECRET (telephony webhooks would be unauthenticated)')
  if (!process.env.PUBLIC_HOST) missing.push('PUBLIC_HOST (media-stream URL would point at an ngrok tunnel)')
  if (missing.length) {
    console.error('[BOOT] refusing to start in production — missing required config:')
    for (const m of missing) console.error('  • ' + m)
    process.exit(1)
  }
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allow-list, never a wildcard: this API accepts an Authorization header, and
// `Access-Control-Allow-Origin: *` alongside credentials lets any site on the
// internet drive the dashboard API with a victim's token.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
    // The response varies per origin, so caches must key on it.
    res.header('Vary', 'Origin')
  } else if (!IS_PROD && origin && !ALLOWED_ORIGINS.length) {
    // Dev convenience only: with no allow-list configured, echo the caller so a
    // local frontend on any port works. Unreachable in production — the boot gate
    // above requires FRONTEND_ORIGIN there.
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Security headers. contentSecurityPolicy is off because this process serves JSON
// and XML, never HTML — a CSP here would protect nothing while risking breakage.
// crossOriginResourcePolicy is relaxed so the separately-hosted dashboard can read
// responses.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

// Rate limiters read req.ip. Behind a proxy or load balancer every request appears
// to come from the proxy, which would put all users in one bucket, so trust the
// first forwarded hop.
app.set('trust proxy', 1)

app.use(express.urlencoded({ extended: false }))
app.use(express.json())
// Salesforce Outbound Messages POST SOAP XML — capture as a raw string so the
// instant-call ingress can parse it (see src/api/events.js).
app.use(express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }))

// ─── Web API routes (for the frontend) ────────────────────────────────────────
// apiLimiter is the backstop for everything under /api; the tighter limiters below
// are layered on top of it for the routes that cost money or guard credentials.
app.use('/api', apiLimiter)

app.use('/api/public', publicRoutes)
app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/signup', authLimiter, signupRoutes)
app.use('/api/client/agent', agentRoutes)
app.use('/api/client/campaigns', campaignRoutes)
app.use('/api/client/instant-call', instantCallLimiter, instantRoutes)
app.use('/api/client/whatsapp', whatsappRoutes)
app.use('/api/client/team', teamRoutes)
app.use('/api/client/messages', messageRoutes)
app.use('/api/client/notifications', notificationRoutes)
app.use('/api/events', eventRoutes)   // public, token auth (campaign ingress + tenant instant calls)
app.use('/api/client', clientRoutes)
// Mount the Operations Center BEFORE the general admin router so /api/admin/ops/*
// is handled by opsRoutes and not shadowed by adminRoutes' prefix.
app.use('/api/admin/ops', opsRoutes)
app.use('/api/admin/dsr', dsrRoutes)   // data-subject erasure (DPDP)
app.use('/api/admin', adminRoutes)

// ─── Vobiz telephony (Indian numbers) ─────────────────────────────────────────
// Every provider webhook is gated by the shared secret carried in the URL we
// configure in the Vobiz console (?k=…). Vobiz does not sign its requests, so this
// is the only thing standing between these endpoints and the open internet:
// unauthenticated, they let anyone mint call rows, start billable media sessions,
// and dial arbitrary numbers on our account.
const webhookGate = requireWebhookSecret()

app.post('/answer', webhookGate, vobizAnswer)
app.post('/hangup', webhookGate, vobizHangup)
// Human-handoff transfer XML: Vobiz fetches this for the caller leg when the agent
// hands off to a human (see transferViaVobiz in handoff.js). GET + POST since the
// leg redirect method may be either. The destination is additionally HMAC-signed —
// the secret alone is not enough to choose who gets dialled.
app.post('/vobiz/transfer', webhookGate, vobizTransferXml)
app.get('/vobiz/transfer', webhookGate, vobizTransferXml)

// ─── Outbound campaign answer webhook (provider fetches on answer) ────────────
app.post('/answer-campaign', webhookGate, answerCampaign)

const server = createServer(app)

// WebSocket endpoints sharing one HTTP server: the browser agent tester, inbound
// Vobiz calls, outbound campaign calls, the Ops live feed, and the public demo.
const testWss = new WebSocketServer({ noServer: true })
const vobizWss = new WebSocketServer({ noServer: true })
const campaignWss = new WebSocketServer({ noServer: true })   // outbound campaign calls
const opsWss = new WebSocketServer({ noServer: true })   // Operations Center live feed
const demoWss = new WebSocketServer({ noServer: true })   // public "try it live" demo
const msgWss = new WebSocketServer({ noServer: true })   // team messaging + notifications

server.on('upgrade', (req, socket, head) => {
  let pathname, query
  try {
    const u = new URL(req.url, `http://${req.headers.host}`)
    pathname = u.pathname
    query = u.searchParams
  } catch {
    pathname = req.url
    query = new URLSearchParams()
  }

  // Media streams carry the webhook secret in the URL we handed the provider.
  // Rejecting here means an unauthenticated socket never reaches a call handler
  // at all — the ticket check inside the handler is the second line, not the first.
  const mediaAuthed = () => {
    if (!WEBHOOK_SECRET_SET) return false
    return timingSafeStringEqual(query.get('k') || '', process.env.WEBHOOK_SECRET || '')
  }
  const rejectUpgrade = (why) => {
    console.error(`[WS] rejected upgrade to ${pathname} — ${why}`)
    telemetry.incr('ws_upgrade_rejected')
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
  }

  if (pathname === '/test-stream') {
    testWss.handleUpgrade(req, socket, head, ws => testWss.emit('connection', ws, req))
  } else if (pathname === '/media-stream-vobiz') {
    if (!mediaAuthed()) return rejectUpgrade('bad or missing webhook secret')
    vobizWss.handleUpgrade(req, socket, head, ws => vobizWss.emit('connection', ws, req))
  } else if (pathname === '/media-stream-campaign') {
    if (!mediaAuthed()) return rejectUpgrade('bad or missing webhook secret')
    campaignWss.handleUpgrade(req, socket, head, ws => campaignWss.emit('connection', ws, req))
  } else if (pathname === '/ops-stream') {
    opsWss.handleUpgrade(req, socket, head, ws => opsWss.emit('connection', ws, req))
  } else if (pathname === '/demo-stream') {
    demoWss.handleUpgrade(req, socket, head, ws => demoWss.emit('connection', ws, req))
  } else if (pathname === '/messages-stream') {
    msgWss.handleUpgrade(req, socket, head, ws => msgWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

// Wrap the Vobiz handler to track active media websockets as a live gauge.
vobizWss.on('connection', (ws, req) => {
  telemetry.gaugeInc('websockets')
  ws.on('close', () => telemetry.gaugeDec('websockets'))
  handleVobizConnection(ws, req)
})

// Outbound campaign media stream (tracked on the same websocket gauge).
campaignWss.on('connection', (ws, req) => {
  telemetry.gaugeInc('websockets')
  ws.on('close', () => telemetry.gaugeDec('websockets'))
  handleCampaignConnection(ws, req)
})

// ─── Operations Center live feed (/ops-stream) ────────────────────────────────
// Admin-only WebSocket that pushes telemetry deltas in real time. The browser
// can't set Authorization headers on a WS handshake, so the admin token is passed
// as ?token=… and validated against Supabase (same check as requireAdmin).
opsWss.on('connection', async (ws, req) => {
  let token = ''
  try { token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token') || '' } catch {}

  let isAdmin = false
  try {
    const { data: { user } } = await supabase.auth.getUser(token)
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
      isAdmin = profile?.role === 'admin'
    }
  } catch { /* fall through to reject */ }

  if (!isAdmin) {
    try { ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' })) } catch {}
    ws.close()
    return
  }

  const safeSend = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)) } catch {} }

  // Initial snapshot so the client renders immediately, then live deltas.
  //
  // getOverviewSnapshot, NOT getSnapshot: this payload lands in the same client
  // cache as GET /overview, so pushing the raw in-memory snapshot here overwrote
  // the database-backed call counts every 5 seconds and the tiles flickered.
  const sendSnapshot = async () => {
    try {
      safeSend({ type: 'snapshot', snapshot: await telemetry.getOverviewSnapshot(), calls: telemetry.getActiveCalls() })
    } catch { /* a heartbeat is never worth throwing over */ }
  }
  sendSnapshot()

  const forward = ({ event, payload }) => safeSend({ type: 'event', event, payload })
  telemetry.bus.on('*', forward)

  // Periodic snapshot heartbeat (covers anything not captured by deltas + keepalive).
  const hb = setInterval(sendSnapshot, 5000)

  ws.on('close', () => { telemetry.bus.off('*', forward); clearInterval(hb) })
  ws.on('error', () => { telemetry.bus.off('*', forward); clearInterval(hb) })
})

// Public demo call from the marketing site (anonymous, rate-limited).
demoWss.on('connection', (ws, req) => handleDemoConnection(ws, req))

// ─── Team messaging + notifications live feed (/messages-stream) ──────────────
// Authenticated the same way as /ops-stream: a browser can't set an Authorization
// header on a WS handshake, so the Supabase token arrives as ?token=… and is
// validated here. The socket is then registered against the user's profile id so
// src/services/realtime-hub.js can push messages and notifications to them.
msgWss.on('connection', async (ws, req) => {
  let token = ''
  try { token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token') || '' } catch {}

  let profileId = null
  try {
    const { data: { user } } = await supabase.auth.getUser(token)
    if (user) {
      const { data: profile } = await supabase
        .from('profiles').select('id, status').eq('id', user.id).single()
      // Suspended employees lose their live feed too, not just their API access.
      if (profile && profile.status !== 'suspended') profileId = profile.id
    }
  } catch { /* fall through to reject */ }

  if (!profileId) {
    try { ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' })) } catch {}
    ws.close()
    return
  }

  const unregister = hub.register(profileId, ws)
  try { ws.send(JSON.stringify({ type: 'ready' })) } catch {}

  // Keepalive: idle WebSockets are dropped by proxies after ~60s, and a silently
  // dead socket means a user stops receiving messages without knowing it.
  const ping = setInterval(() => {
    try { if (ws.readyState === 1) ws.ping() } catch {}
  }, 30000)

  const cleanup = () => { clearInterval(ping); unregister() }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
})

// ─── Browser "web call" test stream ───────────────────────────────────────────
// A client tests their agent from the browser using the SAME Gemini Live engine a
// real phone call uses. The browser sends/receives telephony-format audio frames
// (base64 mulaw 8kHz), so the engine runs exactly as it does on a call. No phone,
// no call/lead rows.
testWss.on('connection', (ws) => {
  console.log('[TEST-STREAM] connected')

  const sid = 'webtest-' + Math.random().toString(36).slice(2, 8)
  let engine = null
  let engineReady = false
  let audioBuffer = []
  let started = false

  ws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }

    // First message authenticates the client and starts the pipeline.
    if (msg.event === 'start' && !started) {
      started = true

      // Resolve the tenant from the bearer token sent in the start payload.
      let tenant = null
      try {
        const { data: { user } } = await supabase.auth.getUser(msg.start?.token || '')
        if (user) {
          const { data: profile } = await supabase
            .from('profiles').select('tenant_id').eq('id', user.id).single()
          if (profile?.tenant_id) {
            const { data: t } = await supabase
              .from('tenants').select('*').eq('id', profile.tenant_id).single()
            tenant = t
          }
        }
      } catch (e) {
        console.error('[TEST-STREAM] auth error:', e.message)
      }

      if (!tenant) {
        try { ws.send(JSON.stringify({ event: 'error', error: 'unauthorized' })) } catch {}
        ws.close()
        return
      }

      // Merge the builder's draft config OVER the saved config (so fields the
      // draft doesn't set — e.g. business_name from signup — are preserved).
      // Always inject tenant_id so RAG searches this tenant's knowledge base.
      const providedConfig =
        msg.start?.config && typeof msg.start.config === 'object' ? msg.start.config : null
      const tenantConfig = {
        ...(tenant.config || {}),
        ...(providedConfig || {}),
        tenant_id: tenant.id,
        audio_io: 'pcm',   // hi-fi browser audio (24kHz PCM out / 16kHz PCM in)
      }
      const streamSid = msg.start?.streamSid || sid

      engine = createGeminiLiveConnection(
        sid,                 // callSid → key for LLM history
        tenantConfig,
        ws,                  // browser ws receives telephony-format media frames
        streamSid,
        () => {},            // onTranscript — not persisted for a test
        () => {              // onReady — flush any audio buffered before the engine was ready
          engineReady = true
          audioBuffer.forEach(c => engine.send(c))
          audioBuffer = []
        },
        'web-test',          // callerNumber (handoff transfer is a no-op here)
      )
      console.log('[TEST-STREAM] Gemini engine started for tenant:', tenant.name)
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      if (!engine) return
      const chunk = Buffer.from(msg.media.payload, 'base64')
      if (!engineReady) audioBuffer.push(chunk)
      else engine.send(chunk)
      return
    }

    if (msg.event === 'stop') {
      if (engine) engine.finish()
      clearHistory(sid)
      engine = null
    }
  })

  ws.on('close', () => {
    if (engine) engine.finish()
    clearHistory(sid)
    console.log('[TEST-STREAM] disconnected')
  })
})

// ─── Lifecycle: drain, health, error handling ─────────────────────────────────
// installShutdown owns the drain flag, and mountHealth reads it — a draining
// process must fail its health check so the load balancer stops routing new calls
// to it while it finishes the ones it already has.
const { isDraining } = installShutdown({
  server,
  socketServers: [vobizWss, campaignWss, demoWss, testWss, opsWss, msgWss],
  graceMs: Number(process.env.SHUTDOWN_GRACE_MS || 15000),
})

mountHealth(app, { draining: isDraining })

// LAST middleware, after every route: without it a thrown handler returns
// Express default HTML with a stack trace.
app.use(errorHandler)

const PORT = process.env.PORT || 3000
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`)
  // Say, at boot, whether alerts can actually reach anyone. A deployment that
  // detects every problem correctly and can report none of them looks identical
  // to a healthy one until the night it matters.
  logNotifyConfig()
  // Calls stranded by a previous hard kill are cleaned up here rather than left
  // to inflate the live-call count forever.
  await reconcileOrphanedCalls({ olderThanHours: Number(process.env.ORPHAN_CALL_HOURS || 2) })
})

// ─── Campaign runner ──────────────────────────────────────────────────────────
// Without Redis, campaigns run in-process via the inline runner. That runner is
// SINGLE-PROCESS ONLY by construction: it holds the dial queue in memory, so two
// replicas would each work the full contact list and every contact would be
// called twice. inline.js documents this constraint; nothing enforced it.
//
// The first time you scale to two replicas for availability, that becomes a
// double-dial incident with real people on the other end — so production refuses
// the in-process path outright and requires Redis plus the separate worker.
import('./queue/inline.js')
  .then(({ INLINE_ENABLED, startInlineRunner }) => {
    if (!INLINE_ENABLED) return
    if (IS_PROD) {
      console.error(
        '[INLINE] refusing to start the in-process campaign runner in production. ' +
        'It cannot run on more than one replica without double-dialling every ' +
        'contact. Set REDIS_URL and run the worker, or set CAMPAIGN_RUNNER=off.'
      )
      telemetry.recordServiceEvent({
        component: 'campaigns', severity: 'critical', kind: 'inline_runner_refused',
        detail: { reason: 'production requires REDIS_URL + worker process' },
      })
      return
    }
    return startInlineRunner()
  })
  .catch((e) => console.error('[INLINE] failed to start:', e.message))
