import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { createGeminiLiveConnection } from './services/gemini-live.js'
import { clearHistory, streamAIReply } from './services/llm.js'
import { supabase } from './api/db.js'
import publicRoutes from './api/public.js'
import clientRoutes from './api/client.js'
import adminRoutes from './api/admin.js'
import agentRoutes from './api/agent.js'
import authRoutes from './api/auth-routes.js'
import signupRoutes from './api/signup.js'
import opsRoutes from './api/ops.js'
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
import 'dotenv/config'

const app = express()

// CORS — allow the frontend (different origin) to call the API.
// In production, replace '*' with your frontend domain.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.urlencoded({ extended: false }))
app.use(express.json())
// Salesforce Outbound Messages POST SOAP XML — capture as a raw string so the
// instant-call ingress can parse it (see src/api/events.js).
app.use(express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }))

// ─── Web API routes (for the frontend) ────────────────────────────────────────
app.use('/api/public', publicRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/signup', signupRoutes)
app.use('/api/client/agent', agentRoutes)
app.use('/api/client/campaigns', campaignRoutes)
app.use('/api/client/instant-call', instantRoutes)
app.use('/api/client/whatsapp', whatsappRoutes)
app.use('/api/client/team', teamRoutes)
app.use('/api/client/messages', messageRoutes)
app.use('/api/client/notifications', notificationRoutes)
app.use('/api/events', eventRoutes)   // public, token auth (campaign ingress + tenant instant calls)
app.use('/api/client', clientRoutes)
// Mount the Operations Center BEFORE the general admin router so /api/admin/ops/*
// is handled by opsRoutes and not shadowed by adminRoutes' prefix.
app.use('/api/admin/ops', opsRoutes)
app.use('/api/admin', adminRoutes)

// ─── Vobiz telephony (Indian numbers) ─────────────────────────────────────────
app.post('/answer', vobizAnswer)
app.post('/hangup', vobizHangup)
// Human-handoff transfer XML: Vobiz fetches this for the caller leg when the agent
// hands off to a human (see transferViaVobiz in handoff.js). GET + POST since the
// leg redirect method may be either.
app.post('/vobiz/transfer', vobizTransferXml)
app.get('/vobiz/transfer', vobizTransferXml)

// ─── Outbound campaign answer webhook (provider fetches on answer) ────────────
app.post('/answer-campaign', answerCampaign)

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
  let pathname
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname
  } catch {
    pathname = req.url
  }
  if (pathname === '/test-stream') {
    testWss.handleUpgrade(req, socket, head, ws => testWss.emit('connection', ws, req))
  } else if (pathname === '/media-stream-vobiz') {
    vobizWss.handleUpgrade(req, socket, head, ws => vobizWss.emit('connection', ws, req))
  } else if (pathname === '/media-stream-campaign') {
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
  safeSend({ type: 'snapshot', snapshot: telemetry.getSnapshot(), calls: telemetry.getActiveCalls() })

  const forward = ({ event, payload }) => safeSend({ type: 'event', event, payload })
  telemetry.bus.on('*', forward)

  // Periodic snapshot heartbeat (covers anything not captured by deltas + keepalive).
  const hb = setInterval(() => safeSend({ type: 'snapshot', snapshot: telemetry.getSnapshot(), calls: telemetry.getActiveCalls() }), 5000)

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

// ─── Browser test interface ───────────────────────────────────────────────────
app.post('/api/test-turn', async (req, res) => {
  const { message, sessionId = 'browser-test' } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })

  const t0 = Date.now()
  let response = ''
  try {
    for await (const token of streamAIReply(sessionId, message, {})) {
      response += token
    }
    res.json({ response, ms: Date.now() - t0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/test-session/:id', (req, res) => {
  clearHistory(req.params.id)
  res.json({ ok: true })
})

app.get('/test', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice Agent — Browser Test</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; background: #f5f5f5; }
  h2 { margin-bottom: 4px; }
  small { color: #666; }
  #chat { background: white; border-radius: 10px; padding: 16px; min-height: 200px; margin: 16px 0; border: 1px solid #ddd; }
  .msg { margin: 8px 0; padding: 8px 12px; border-radius: 8px; max-width: 90%; }
  .user { background: #0078d4; color: white; margin-left: auto; text-align: right; }
  .agent { background: #e8e8e8; color: #111; }
  .meta { font-size: 11px; opacity: 0.6; margin-top: 2px; }
  #row { display: flex; gap: 8px; }
  #input { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #ccc; font-size: 15px; }
  button { padding: 10px 18px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; }
  #send { background: #0078d4; color: white; }
  #send:disabled { opacity: 0.5; cursor: default; }
  #clear { background: #ddd; }
  #status { font-size: 12px; color: #888; margin-top: 6px; }
</style>
</head>
<body>
<h2>Voice Agent — Browser Test</h2>
<small>Type what you would say. The agent replies with text + speaks it aloud.</small>
<div id="chat"></div>
<div id="row">
  <input id="input" type="text" placeholder="e.g. I need help with my order" autofocus>
  <button id="send" onclick="send()">Send</button>
  <button id="clear" onclick="clearSession()">New call</button>
</div>
<div id="status">Ready</div>

<script>
const SESSION = 'test-' + Math.random().toString(36).slice(2, 8)
const chat = document.getElementById('chat')
const input = document.getElementById('input')
const status = document.getElementById('status')
const sendBtn = document.getElementById('send')

function addMsg(text, role, meta) {
  const d = document.createElement('div')
  d.className = 'msg ' + role
  d.innerHTML = '<div>' + text + '</div>' + (meta ? '<div class="meta">' + meta + '</div>' : '')
  chat.appendChild(d)
  chat.scrollTop = chat.scrollHeight
}

input.addEventListener('keydown', e => { if (e.key === 'Enter') send() })

async function send() {
  const msg = input.value.trim()
  if (!msg) return
  input.value = ''
  sendBtn.disabled = true
  status.textContent = 'Thinking...'
  addMsg(msg, 'user')

  const t0 = Date.now()
  try {
    const r = await fetch('/api/test-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, sessionId: SESSION })
    })
    const { response, ms, error } = await r.json()
    if (error) throw new Error(error)
    addMsg(response, 'agent', ms + 'ms')
    status.textContent = 'LLM: ' + ms + 'ms'
    const utt = new SpeechSynthesisUtterance(response)
    utt.lang = 'en-IN'
    speechSynthesis.speak(utt)
  } catch (err) {
    addMsg('Error: ' + err.message, 'agent')
    status.textContent = 'Error'
  }
  sendBtn.disabled = false
  input.focus()
}

async function clearSession() {
  await fetch('/api/test-session/' + SESSION, { method: 'DELETE' })
  chat.innerHTML = ''
  status.textContent = 'New session started'
}
</script>
</body>
</html>`)
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

// When Redis isn't configured, run campaigns in-process (no separate worker needed).
// Resumes running/scheduled campaigns and starts the stale-dial sweep. No-op under
// Redis (use `npm run worker`) or when CAMPAIGN_RUNNER=off.
import('./queue/inline.js')
  .then(({ INLINE_ENABLED, startInlineRunner }) => { if (INLINE_ENABLED) return startInlineRunner() })
  .catch((e) => console.error('[INLINE] failed to start:', e.message))
