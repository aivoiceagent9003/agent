import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { createDeepgramConnection } from './services/deepgram.js'
import { clearHistory, streamAIReply, getHistory } from './services/llm.js'
import { speakReply } from './services/tts.js'
import { extractLead, saveLead } from './services/leads.js'
import { supabase } from './api/db.js'
import publicRoutes from './api/public.js'
import clientRoutes from './api/client.js'
import adminRoutes from './api/admin.js'
import agentRoutes from './api/agent.js'
import signupRoutes from './api/signup.js'
import 'dotenv/config'

const app = express()

// CORS — allow the frontend (different origin) to call the API.
// In production, replace '*' with your frontend domain.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// ─── Web API routes (for the frontend) ────────────────────────────────────────
app.use('/api/public', publicRoutes)
app.use('/api/signup', signupRoutes)
app.use('/api/client/agent', agentRoutes)
app.use('/api/client', clientRoutes)
app.use('/api/admin', adminRoutes)

const activeCalls = new Map()

app.post('/incoming-call', async (req, res) => {
  // Extract E.164 number from either "+1234" or "sip:+1234@domain"
  const normalize = n => {
    if (!n) return ''
    const match = n.match(/(\+?\d[\d\s\-().]+)/)
    return match ? match[1].replace(/\s/g, '') : n.trim()
  }
  const calledNumber = normalize(req.body.To)
  const callerNumber = normalize(req.body.From)
  console.log(`Incoming call to: ${calledNumber} from: ${callerNumber}`)

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('phone_number', calledNumber)
    .single()

  if (error || !tenant) {
    console.error('No tenant found for number:', calledNumber)
    res.type('text/xml')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, this number is not configured.</Say></Response>`)
    return
  }

  console.log('Tenant found:', tenant.name)

  const { data: call, error: callError } = await supabase
    .from('calls')
    .insert({
      tenant_id: tenant.id,
      caller_number: callerNumber,
      status: 'active'
    })
    .select()
    .single()

  if (callError || !call) {
    console.error('Failed to insert call:', callError)
    res.type('text/xml')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, something went wrong.</Say></Response>`)
    return
  }

  activeCalls.set(callerNumber, {
    tenant,
    callId: call.id,
    transcript: []
  })

  const ngrokUrl = process.env.NGROK_URL

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${ngrokUrl}/media-stream">
      <Parameter name="caller_number" value="${callerNumber}"/>
    </Stream>
  </Connect>
</Response>`

  res.type('text/xml')
  res.send(twiml)
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/media-stream' })

wss.on('connection', (ws) => {
  console.log('WebSocket connected')

  let callSid = null
  let callerNumber = null
  let tenant = null
  let callId = null
  let deepgramConnection = null
  let transcriptBuffer = []
  let audioBuffer = []
  let deepgramReady = false
  let streamSid = null
  let callStartTime = null  // for computing duration_seconds

  ws.on('message', async (data) => {
    const msg = JSON.parse(data)

    if (msg.event === 'start') {
      callSid = msg.start.callSid
      streamSid = msg.start.streamSid
      callerNumber = msg.start.customParameters?.caller_number
      callStartTime = Date.now()  // mark call start for duration
      console.log('Stream started for:', callerNumber)

      const session = activeCalls.get(callerNumber)
      if (session) {
        tenant = session.tenant
        callId = session.callId
        console.log('Session loaded for tenant:', tenant.name)
      } else {
        console.log('No session found — creating test session')
        const { data: testTenant } = await supabase
          .from('tenants')
          .select('*')
          .eq('phone_number', '+14056497747')
          .single()

        if (testTenant) {
          const { data: testCall, error: testCallError } = await supabase
            .from('calls')
            .insert({
              tenant_id: testTenant.id,
              caller_number: callerNumber,
              status: 'active'
            })
            .select()
            .single()

          if (testCallError || !testCall) {
            console.error('Failed to create test call record:', testCallError)
          } else {
            tenant = testTenant
            callId = testCall.id
            console.log('Test session created for tenant:', tenant.name)
          }
        }
      }

      const tenantConfig = { ...(tenant?.config || {}), tenant_id: tenant?.id }

      deepgramConnection = createDeepgramConnection(
        callSid,
        tenantConfig,
        ws,
        streamSid,
        (finalTranscript) => {
          // onTranscript hook — save turns for Supabase transcript
          transcriptBuffer.push({
            role: 'user',
            text: finalTranscript,
            timestamp: new Date().toISOString()
          })
        },
        () => {
          // onReady — flush buffered audio
          deepgramReady = true
          console.log(`Flushing ${audioBuffer.length} buffered chunks to Deepgram`)
          audioBuffer.forEach(chunk => deepgramConnection.send(chunk))
          audioBuffer = []
        },
        callerNumber  // ← NEW: needed for human handoff warm transfer
      )

      console.log('Deepgram connection created')
    }

    if (msg.event === 'media') {
      const audioChunk = Buffer.from(msg.media.payload, 'base64')
      if (!deepgramReady) {
        audioBuffer.push(audioChunk)
      } else {
        if (audioBuffer.length === 0 && !deepgramConnection._loggedFirstChunk) {
          deepgramConnection._loggedFirstChunk = true
          console.log('[AUDIO] First media chunk received from Twilio ✅')
        }
        deepgramConnection.send(audioChunk)
      }
    }

    if (msg.event === 'stop') {
      console.log('Call ended:', callSid)

      if (deepgramConnection) deepgramConnection.finish()

      // ── Day 8: Lead extraction ──────────────────────────────────────────
      // Grab the full conversation (user + agent) BEFORE clearing it.
      // Extraction runs post-call so it never adds latency to the live call.
      const history = getHistory(callSid)
      const tenantConfig = tenant?.config || {}

      const fullTranscript = transcriptBuffer
        .map(t => `${t.role}: ${t.text}`)
        .join('\n')

      // Save call transcript + status + duration
      const durationSeconds = callStartTime
        ? Math.round((Date.now() - callStartTime) / 1000)
        : 0
      await supabase
        .from('calls')
        .update({
          status: 'completed',
          transcript: fullTranscript,
          duration_seconds: durationSeconds,
        })
        .eq('id', callId)

      // Extract lead from the conversation, then save it
      if (history && history.length > 0 && tenant) {
        const lead = await extractLead(history, tenantConfig)
        if (lead) {
          await saveLead(supabase, {
            tenantId: tenant.id,
            callId,
            callerNumber,
            lead,
          })
        }
      }

      // Now safe to clear conversation memory
      clearHistory(callSid)
      // ─────────────────────────────────────────────────────────────────────

      activeCalls.delete(callerNumber)
      console.log('Call completed, transcript + lead saved')
    }
  })

  ws.on('close', () => {
    if (deepgramConnection) deepgramConnection.finish()
    if (callSid) clearHistory(callSid)
    console.log('WebSocket disconnected')
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