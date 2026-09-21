// telephony/demo.js — Public "try it live" demo call for the marketing site.
//
// Anonymous visitors talk to a REAL agent from the browser, using the SAME engine
// a phone call uses — not a scripted chat. The browser is the audio
// transport (mulaw 8kHz frames, exactly like Vobiz/Twilio), so the engines work
// unchanged. No tenant, no DB writes, no telephony.
//
// The agent is configured from the SECTOR the visitor picks: we take that sector's
// pre-built template (persona + flow) and inject a small block of demo facts, since
// there's no knowledge base to search. Without those facts the templates correctly
// refuse to invent prices, which would make the demo feel useless.
//
// Because this is public and every session costs money, it is guarded:
//   • hard session cap (DEMO_MAX_SECONDS)
//   • global concurrency cap (DEMO_MAX_CONCURRENT)
//   • per-IP hourly cap (DEMO_MAX_PER_IP_PER_HOUR)
//   • kill switch (DEMO_ENABLED=false)

import { createSonioxCascadeConnection } from '../services/soniox-cascade.js'
import { clearHistory } from '../services/llm.js'
import { getTemplate } from '../api/templates.js'
import 'dotenv/config'

// The demo runs the SAME engine a real call runs. It used to run a different one, on
// the theory that a marketing page should sound better than the product; that is
// exactly backwards — a demo that flatters the stack is a demo that lies.
const createVoiceConnection = createSonioxCascadeConnection

// Browser clients still get proper audio (24kHz PCM out, 16kHz PCM in) rather than the
// 8kHz µ-law telephony codec — Soniox speaks both, so there is no reason to degrade a
// web page to phone quality. See AUDIO_PROFILES in soniox-cascade.js.
const DEMO_AUDIO = { format: 'pcm16', outputSampleRate: 24000, inputSampleRate: 16000 }

const ENABLED = process.env.DEMO_ENABLED !== 'false'
const MAX_SECONDS = parseInt(process.env.DEMO_MAX_SECONDS || '90', 10)
// Priya (the "Talk to Priya" sales agent) gets a much longer session so she can
// fully explain AnswerLabs without being cut off mid-sentence. Still capped — but
// generously — so a forgotten tab can't run forever.
const VOCERA_MAX_SECONDS = parseInt(process.env.DEMO_VOCERA_MAX_SECONDS || '600', 10)
const MAX_CONCURRENT = parseInt(process.env.DEMO_MAX_CONCURRENT || '5', 10)
const MAX_PER_IP_PER_HOUR = parseInt(process.env.DEMO_MAX_PER_IP_PER_HOUR || '3', 10)

// ─── Sectors offered on the public page ──────────────────────────────────────
// `template` reuses the real pre-built agent; `facts` stands in for the knowledge
// base so the agent can quote specifics during the demo. Facts are fictional but
// realistic — clearly a sample business, never a real one.
export const DEMO_SECTORS = [
  {
    id: 'real_estate',
    template: 'real_estate_sales',
    title: 'Real Estate',
    emoji: '🏠',
    description: 'Qualifies buyers and books site visits.',
    business_name: 'Sunrise Realty',
    agent_name: 'Priya',
    language_code: 'en-IN',   // Indian English accent, not US
    tts_voice: 'Priya',       // Indian English, warm female
    facts: `DEMO BUSINESS FACTS (treat these as your knowledge base — this is a sample business):
- Sunrise Realty sells residential apartments in Hyderabad.
- Projects:
  • Sunrise Heights, Kokapet — 2BHK 1,250 sqft ₹95 lakhs; 3BHK 1,750 sqft ₹1.35 crore. Possession Dec 2026. RERA registered.
  • Sunrise Meadows, Gachibowli — 3BHK 1,900 sqft ₹1.65 crore. Possession June 2027. RERA registered.
  • Sunrise Grove, Tellapur — 2BHK 1,150 sqft ₹78 lakhs. Ready to move. RERA registered.
- Amenities across projects: clubhouse, gym, swimming pool, children's play area, 24x7 security, power backup.
- Extra charges: registration, GST, ₹50,000 maintenance deposit, parking included.
- Home loan tie-ups with HDFC, SBI and ICICI.
- Site visits available Saturday and Sunday, 10 AM to 6 PM.`,
  },
  {
    id: 'clinic',
    template: 'front_desk',
    title: 'Clinic / Front Desk',
    emoji: '🩺',
    description: 'Books appointments and answers patient queries.',
    business_name: 'Smile Dental Care',
    agent_name: 'Asha',
    language_code: 'en-IN',   // Indian English accent, not US
    tts_voice: 'Kavya',       // warm female
    facts: `DEMO BUSINESS FACTS (treat these as your knowledge base — this is a sample business):
- Smile Dental Care is a dental clinic in Jubilee Hills, Hyderabad.
- Doctors: Dr. Meera Rao (root canal, crowns), Dr. Arjun Nair (braces, aligners), Dr. Kavya Reddy (general dentistry, cleaning).
- Timings: Monday to Saturday, 9 AM to 8 PM. Closed Sunday.
- Consultation fee ₹500. Teeth cleaning ₹1,500. Root canal from ₹6,000. Braces from ₹35,000.
- Appointments usually available same week; emergency slots kept free each morning.
- Parking available. Insurance accepted from Star Health and HDFC Ergo.`,
  },
  {
    id: 'support',
    template: 'customer_support',
    title: 'Customer Support',
    emoji: '🎧',
    description: 'Answers FAQs and triages issues 24/7.',
    business_name: 'Nova Electronics',
    agent_name: 'Ravi',
    language_code: 'en-IN',   // Indian English accent, not US
    tts_voice: 'Arjun',       // Indian English, steady male (Ravi)
    facts: `DEMO BUSINESS FACTS (treat these as your knowledge base — this is a sample business):
- Nova Electronics sells home appliances online across India.
- Delivery: 3-5 working days metro, 5-8 days elsewhere. Free above ₹2,000.
- Returns accepted within 7 days of delivery if unused and in original packaging. Refunds in 5-7 working days.
- Warranty: 1 year manufacturer warranty on all appliances; 2 years on refrigerators.
- Order tracking is sent by SMS and email once the order ships.
- Installation is free for washing machines, ACs and refrigerators, scheduled within 48 hours of delivery.
- Support hours: 9 AM to 9 PM, all days.`,
  },
]

export function listDemoSectors() {
  return DEMO_SECTORS.map(({ id, title, emoji, description }) => ({ id, title, emoji, description }))
}

// ─── AnswerLabs' own sales agent (the "Talk to Priya" hero on the landing page) ──
// Not an industry demo — this is Priya selling ANSWERLABS itself. She's a live example
// of the product, so she explains features, answers prospect questions, and guides
// toward starting free / booking a demo. `system_prompt` is used directly, and a
// persona takes no template layer at all — see buildDemoConfig.
export const DEMO_PERSONAS = {
  vocera: {
    id: 'vocera',
    agent_name: 'Priya',
    business_name: 'AnswerLabs',
    language_code: 'en-IN',   // Indian English accent, not US
    tts_voice: 'Priya',       // warm, natural female voice
    max_seconds: VOCERA_MAX_SECONDS,   // long session — she's explaining the product
    greeting_message:
      "Hi! I'm Priya from AnswerLabs — the AI voice agent you're reading about, live on this call. Tell me, what kind of business do you run?",
    system_prompt: `You are Priya, a warm and sharp sales executive for AnswerLabs, an AI voice agent platform for businesses. Right now you are on a live call with someone exploring AnswerLabs on our website — so you are also a working demo of the product itself. Sound like a friendly, confident human: natural, curious, never scripted or pushy.

WHAT ANSWERLABS IS: An AI voice agent that answers every business phone call twenty four seven, speaks the caller's own language, qualifies leads, books appointments, and sends details on WhatsApp — so a business never misses a call or a lead again.

WHAT IT CAN DO (share only what fits the conversation, one or two points at a time — never list everything at once):
- Speaks thirty plus languages, and Indian languages like Telugu, Hindi, Tamil and Kannada natively — it mirrors whatever language the caller uses.
- Answers from the business's own knowledge: their documents, FAQs, pricing and policies — never made up.
- Captures every lead automatically: name, intent, contact and key details, into a dashboard you can export.
- Hands off hot or complex calls straight to your team's phone.
- Shows analytics: calls, minutes, leads, sentiment and conversion, at a glance.
- Works after hours and when every line is busy, so no call is missed.
- Can also make outbound calls: follow up leads, confirm orders, send reminders.
- Sends brochures, price lists and booking confirmations on WhatsApp.
- Goes live in minutes: pick a template, add your knowledge, choose a voice, connect your number. No coding.

PRICING: usage based, with Starter, Growth and Enterprise plans. Exact pricing is tailored, so for a real quote, offer to book a quick demo or connect them to the team. NEVER invent a specific price.

HOW YOU SELL:
- Open by asking what kind of business they run, or what is making them lose calls or leads today. Then tailor everything to that.
- Answer only what they ask. Keep it short and real.
- If they doubt the voice quality, warmly remind them they are talking to AnswerLabs right now.
- If you do not know something, say so honestly and offer to connect them to the team.
- Guide gently to a next step: starting free on the website, or booking a quick demo.`,
  },
}

// Resolve a requested demo id to either an industry sector or a persona.
function findDemoConfig(id) {
  return DEMO_SECTORS.find((s) => s.id === id) || DEMO_PERSONAS[id] || null
}

// ─── Abuse / cost guards ─────────────────────────────────────────────────────
let activeSessions = 0
const ipHits = new Map()   // ip -> [timestamps within the last hour]

function ipAllowed(ip) {
  if (!ip) return true
  const now = Date.now()
  const cutoff = now - 3600_000
  const hits = (ipHits.get(ip) || []).filter(t => t > cutoff)
  if (hits.length >= MAX_PER_IP_PER_HOUR) { ipHits.set(ip, hits); return false }
  hits.push(now)
  ipHits.set(ip, hits)
  // Opportunistic cleanup so the map can't grow forever.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (!v.some(t => t > cutoff)) ipHits.delete(k)
  }
  return true
}

function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req?.socket?.remoteAddress || ''
}

// Build the agent config for a demo. Industry sectors use a real template persona
// + demo facts; personas (Priya/AnswerLabs) supply their own system_prompt directly.
// Everything tenant-specific (KB, lookups, WhatsApp, handoff) is turned OFF.
function buildDemoConfig(sector) {
  const base = sector.template ? getTemplate(sector.template)?.config || {} : {}
  // The template drives the prompt through template_id; a persona brings its own
  // self-contained system_prompt and takes no template layer.
  const templateId = sector.system_prompt ? null : (sector.template || null)
  const systemPrompt = sector.system_prompt
    ? sector.system_prompt
    : `${base.system_prompt || ''}\n\n${sector.facts || ''}`
  return {
    ...base,
    agent_name: sector.agent_name || base.agent_name,
    business_name: sector.business_name,
    greeting_message: sector.greeting_message || base.greeting_message,
    template_id: templateId,
    language_code: sector.language_code || base.language_code,   // e.g. 'en-IN' accent
    // tts_voice, not voice: `voice` held a Gemini Live voice name and Soniox
    // rejects one. See services/soniox-voices.js.
    tts_voice: sector.tts_voice || base.tts_voice,
    system_prompt: systemPrompt,
    tenant_id: null,
    enable_kb: false,        // no knowledge base in a public demo
    enable_lookups: false,   // no client systems to query
    enable_handoff: false,   // nobody to transfer to
    handoff_number: null,
    whatsapp: { enabled: false },   // never send WhatsApp from a demo
    audio_io: 'pcm',         // hi-fi browser audio, not the 8kHz telephony codec
  }
}

// ─── WS handler ──────────────────────────────────────────────────────────────
export function handleDemoConnection(ws, req) {
  const sid = 'demo-' + Math.random().toString(36).slice(2, 8)
  let engine = null
  let ready = false
  let audioBuffer = []
  let started = false
  let closed = false
  let timer = null
  let counted = false

  const fail = (error) => {
    try { ws.send(JSON.stringify({ event: 'error', error })) } catch {}
    try { ws.close() } catch {}
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    try { engine?.finish() } catch {}
    clearHistory(sid)
    if (counted) { activeSessions = Math.max(0, activeSessions - 1); counted = false }
    console.log(`[DEMO] session ${sid} ended (active=${activeSessions})`)
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.event === 'start' && !started) {
      started = true

      if (!ENABLED) return fail('demo_disabled')
      if (activeSessions >= MAX_CONCURRENT) return fail('busy')
      if (!ipAllowed(clientIp(req))) return fail('rate_limited')

      const sector = findDemoConfig(msg.start?.sector) || DEMO_SECTORS[0]
      const config = buildDemoConfig(sector)
      const maxSeconds = sector.max_seconds || MAX_SECONDS

      activeSessions++
      counted = true
      console.log(`[DEMO] ${sid} started sector=${sector.id} engine=soniox hi-fi cap=${maxSeconds}s (active=${activeSessions})`)

      // Hard stop so a forgotten tab can't burn minutes forever.
      timer = setTimeout(() => {
        try { ws.send(JSON.stringify({ event: 'ended', reason: 'time_limit' })) } catch {}
        try { ws.close() } catch {}
        cleanup()
      }, maxSeconds * 1000)

      engine = createVoiceConnection(
        sid,
        config,
        ws,                                  // browser receives media frames
        msg.start?.streamSid || 'demo',
        () => {},                            // onTranscript — nothing persisted
        () => {                              // onReady — flush buffered mic audio
          ready = true
          audioBuffer.forEach(c => engine.send(c))
          audioBuffer = []
        },
        'web-demo',
      )
      try { ws.send(JSON.stringify({ event: 'started', maxSeconds, audio: DEMO_AUDIO })) } catch {}
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      if (!engine) return
      const chunk = Buffer.from(msg.media.payload, 'base64')
      if (!ready) audioBuffer.push(chunk)
      else engine.send(chunk)
      return
    }

    if (msg.event === 'stop') {
      cleanup()
      try { ws.close() } catch {}
    }
  })

  ws.on('close', cleanup)
  ws.on('error', cleanup)
}
