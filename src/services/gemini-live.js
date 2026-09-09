// services/gemini-live.js — Google Gemini Live (speech-to-speech) engine.
//
// A DROP-IN alternative to the OpenAI Realtime engine (same signature + { send,
// finish }), but ~5–10× cheaper and with strong native Indic support (Telugu,
// Hindi, …). Wire it with VOICE_ENGINE=gemini.
//
// Audio: Vobiz/Twilio speak g711 μ-law 8kHz, but Gemini Live wants 16kHz PCM in
// and emits 24kHz PCM out — so unlike the OpenAI path we RESAMPLE on both edges:
//   inbound : μ-law 8k → PCM16 8k → upsample → PCM16 16k → Gemini
//   outbound: Gemini PCM16 24k → downsample → PCM16 8k → μ-law → caller
//
// ⚠️ CONFIRM-ON-FIRST-CALL: Gemini's live model IDs move fast. If the first call
// logs a model-not-found error, set GEMINI_LIVE_MODEL to the current id shown in
// Google AI Studio. Native-audio models sound best (Telugu); the "half-cascade"
// live models are a bit more reliable for tool-calling — try both.

import { GoogleGenAI, Modality } from '@google/genai'
import 'dotenv/config'
import { buildSystemPrompt, getHistory } from './llm.js'
import { buildLookupTools, runLookup, sanitizeName } from './lookups.js'
import { retrieveKnowledge, warmupRAG } from './rag.js'
import { resolveGreeting } from './greeting.js'
import { addToDnd } from './dnd.js'
import { whatsappReady, resolveCfg, tenantWa, sendDocument, sendConfirmation, logWhatsApp } from './whatsapp.js'
import { resolveSendable } from './sendables.js'
import { detectHandoffKeyword, transferToHuman } from './handoff.js'
import { LanguageManager, toName } from './language-manager.js'
import { resolveGeminiVoice } from './gemini-voices.js'
import telemetry from './telemetry.js'

// Gemini 3.1 Flash Live — the latest general real-time voice model, with proper
// function calling (unlike the native-audio variant, which spoke the tool-call
// syntax instead of invoking it). If this exact id errors, copy the precise model
// id from AI Studio into GEMINI_LIVE_MODEL (ids often carry a -preview/date suffix).
const GEMINI_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Aoede'   // fallback prebuilt voice name
// The per-call voice is the tenant's chosen voice (config.voice), validated
// against the Gemini catalog; GEMINI_VOICE is the fallback for empty/invalid ones.

// Native-audio models are true audio-to-audio: they mirror the caller's language
// natively and hear Indic speech far better, so the half-cascade language-steering
// hack (injecting "reply in X" turns) is unnecessary — and would only add noise.
// We disable it for native audio and let the model mirror on its own.
const IS_NATIVE_AUDIO = /native-audio/i.test(GEMINI_MODEL)

// ─── Audio helpers ───────────────────────────────────────────────────────────
// G.711 μ-law → linear PCM16, as a 256-entry table because this runs on every
// inbound frame of every call.
//
// Per ITU-T G.711: bias 0x84 (132), mantissa shifted left 3, then left by the
// exponent. The previous implementation used bias 33 and shifted by exp-1, which
// is not G.711. It peaked at 20383 where the standard peaks at 32124, and — the
// part that actually mattered — it was non-linear against the real curve, landing
// anywhere from 0.25x to 1.94x of the correct sample depending on its value. That
// is waveform distortion, not quiet audio, and it sat on the INBOUND path: every
// word a caller spoke reached the model misshapen.
//
// pcm16ToMulaw below has always used the standard bias, so the two never agreed
// with each other. decode(encode(x)) !== x, which is what the round-trip test in
// tests/audio.test.js caught.
const MULAW_DECODE = (() => {
  const t = new Int16Array(256)
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xFF
    let m = ((u & 0x0F) << 3) + 0x84   // mantissa + bias
    m <<= (u & 0x70) >> 4              // scale by exponent
    t[i] = (u & 0x80) ? (0x84 - m) : (m - 0x84)
  }
  return t
})()

export function mulawToPcm16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2)
  for (let i = 0; i < mulawBuf.length; i++) pcm.writeInt16LE(MULAW_DECODE[mulawBuf[i]], i * 2)
  return pcm
}

export function pcm16ToMulaw(pcmBuf) {
  const samples = pcmBuf.length >> 1
  const out = Buffer.alloc(samples)
  for (let i = 0; i < samples; i++) {
    let s = pcmBuf.readInt16LE(i << 1)
    const sign = s < 0 ? 0x80 : 0
    if (s < 0) s = -s
    if (s > 32635) s = 32635
    s += 132                                                  // G.711 bias
    let exp = 7
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    const mantissa = (s >> (exp + 3)) & 0x0F
    out[i] = ~(sign | (exp << 4) | mantissa) & 0xFF
  }
  return out
}

// 8kHz → 16kHz: linear interpolation (one extra sample between each pair).
export function upsample8to16(pcm8) {
  const n = pcm8.length >> 1
  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const cur = pcm8.readInt16LE(i * 2)
    const next = i + 1 < n ? pcm8.readInt16LE((i + 1) * 2) : cur
    out.writeInt16LE(cur, i * 4)
    out.writeInt16LE((cur + next) >> 1, i * 4 + 2)
  }
  return out
}

// 24kHz → 8kHz: average each group of 3 samples (cheap anti-alias).
export function downsample24to8(pcm24) {
  const n = pcm24.length >> 1
  const outN = Math.floor(n / 3)
  const out = Buffer.alloc(outN * 2)
  for (let j = 0; j < outN; j++) {
    const a = pcm24.readInt16LE(j * 6)
    const b = pcm24.readInt16LE(j * 6 + 2)
    const c = pcm24.readInt16LE(j * 6 + 4)
    out.writeInt16LE(((a + b + c) / 3) | 0, j * 2)
  }
  return out
}

// ─── Tools + instructions (shared shape with the OpenAI engine) ──────────────
function buildGeminiTools(tenantConfig) {
  const decls = []
  for (const t of buildLookupTools(tenantConfig)) {
    const f = t.function || {}
    decls.push({ name: f.name, description: f.description, parameters: f.parameters })
  }
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
    decls.push({
      name: 'search_knowledge',
      description: "Search the business knowledge base for facts (prices, projects, policies, product details) to answer the caller. Call this before stating ANY business fact.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: "The caller's question or topic to look up" } },
        required: ['query'],
      },
    })
  }
  // Always declared, on every call. The right to ask not to be called again does
  // not depend on which features the tenant enabled, and someone on an INBOUND
  // call may equally want off the outbound list.
  decls.push({
    name: 'add_to_dnd',
    description: "Record that this person does NOT want to be contacted again, and stop calling them. Call this the moment they say anything meaning 'do not call me again', 'remove me from your list', 'stop calling', or 'unsubscribe'. Do not argue, do not try to persuade them to stay, and do not ask why. Confirm warmly that they have been removed, then end the call politely.",
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "Optional: their stated reason, in their own words, if they gave one. Leave out if they did not." },
      },
      required: [],
    },
  })

  if (whatsappReady(tenantConfig)) {
    decls.push({
      name: 'send_whatsapp',
      description: "Send the caller a document (brochure, menu, price list, catalogue…) or a confirmation (appointment, booking, site visit, reservation…) to their WhatsApp. Call ONLY after the caller agrees to receive it, or once something is booked. Then confirm to the caller you've sent it.",
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: "'document' to send a file (brochure/menu/price list/etc.), or 'confirmation' to send an appointment/booking confirmation" },
          about: { type: 'string', description: "What it is, in natural words that read well in the message. For a document: e.g. 'brochure for My Home Akara', 'lunch menu', 'price list'. For a confirmation: e.g. 'site visit to My Home Akara', 'dental appointment', 'table for 4'." },
          topic: { type: 'string', description: "Just the bare subject name, no extra words — e.g. 'My Home Akara', 'Lunch Menu'. Used to pick the right file and to fill templates that already word the sentence." },
          customer_name: { type: 'string', description: "The caller's name as they gave it on this call (first name is fine). Pass it so the message greets them properly. Omit only if they never gave a name." },
          date: { type: 'string', description: "For 'confirmation' only: the confirmed date, e.g. '10/12/2026'." },
          time: { type: 'string', description: "For 'confirmation' only: the confirmed time, e.g. '12:00 PM'." },
        },
        required: ['kind', 'about'],
      },
    })
  }
  return decls.length ? [{ functionDeclarations: decls }] : []
}

// Send the brochure / booking confirmation to the caller's WhatsApp, using the
// tenant's own WhatsApp number + templates. Returns a short string the model
// speaks back ("Sent…" / "Could not send…").
async function handleSendWhatsapp(tenantConfig, callerNumber, args = {}, sentKeys = null) {
  const cfg = resolveCfg(tenantConfig)                 // platform number (or tenant's own)
  const wa = tenantWa(tenantConfig)
  const tenantId = tenantConfig.tenant_id
  if (!callerNumber) return 'No phone number is available to send WhatsApp to.'
  // The client's brand rides in the message body so the customer sees who it's from.
  const who = {
    businessName: tenantConfig.business_name || 'our team',
    businessPhone: wa.display_phone || tenantConfig.business_phone || tenantConfig.phone_number || '',
    // Inbound callers aren't in any CRM record — let the agent pass the name it heard.
    customerName: args.customer_name || tenantConfig.contact_name || null,
  }
  // Normalise: accept legacy 'brochure'/'booking' as document/confirmation.
  let kind = String(args.kind || 'document').toLowerCase()
  if (kind === 'brochure') kind = 'document'
  if (kind === 'booking') kind = 'confirmation'
  const about = args.about || args.project || ''
  const topic = args.topic || args.project || about
  // Told the model, verbatim, why we won't send the same thing twice — so it stops
  // re-firing and reassures the caller instead.
  const alreadyMsg = (what) =>
    `You have ALREADY sent the ${what} to the caller's WhatsApp on this call. Do NOT send it again — ` +
    `WhatsApp drops an identical message re-sent to the same number, so resending is what stops it arriving. ` +
    `Reassure the caller it's been sent and can take up to a minute to appear; if they still don't see it, ` +
    `ask them to confirm this number is on WhatsApp, and offer to have the team follow up.`
  try {
    let res
    if (kind === 'confirmation') {
      const key = `confirmation:${about.toLowerCase()}:${args.date || ''}:${args.time || ''}`
      if (sentKeys?.has(key)) return alreadyMsg(about || 'confirmation')
      res = await sendConfirmation({ cfg, to: callerNumber, who, about, topic, date: args.date, time: args.time })
      sentKeys?.add(key)
    } else {
      const doc = await resolveSendable(tenantId, topic || about)   // the file matching the subject
      // No match = we don't have that document. Say so — never fall back to a
      // different file, or the caller is told they got something they didn't.
      if (!doc) return `There is no document available for ${topic || about || 'that'}. Tell the caller you don't have that one to send, and offer to have the team send it instead. Do NOT say you sent anything.`
      // Send each distinct file to this caller only ONCE per call (see sentWhatsapp).
      const key = `document:${doc.id}`
      if (sentKeys?.has(key)) return alreadyMsg(about || 'document')
      res = await sendDocument({
        tenantId, cfg, to: callerNumber, docId: doc.id, who, about, topic,
        filename: doc.filename || `${topic || who.businessName || 'document'}.pdf`,
      })
      sentKeys?.add(key)
    }
    logWhatsApp(tenantId, { to: callerNumber, kind, messageId: res.id })
    return `Sent ${about ? `the ${about}` : `the ${kind}`} to the caller's WhatsApp.`
  } catch (e) {
    // Surface the provider's real error — this is the only place it's visible.
    console.error(`[WHATSAPP] send failed (kind=${kind}, to=${callerNumber}):`, e.message)
    logWhatsApp(tenantId, { to: callerNumber, kind, error: e.message })
    return `Could not send it on WhatsApp right now.`
  }
}

// ─── Knowledge-miss return ────────────────────────────────────────────────────
// The tool's miss path returns an INSTRUCTION, not a status. A bare "not found"
// leaves the model to fill the gap itself, and on a real insurance call it did
// exactly that: search_knowledge missed, and the agent still told the caller
// "a payment of 15000 rupees due on October 1st" — a premium and a due date that
// do not exist anywhere in the system, which then got persisted into the lead row.
//
// send_whatsapp already returns instructions on ITS miss path ("Do NOT say you
// sent anything") and the model follows them correctly on the same call. So this
// mirrors that shape rather than inventing a new one.
//
// ⚠️ The first sentence is load-bearing: knowledgeHits / knowledgeMisses analytics
// and the tool span's `hit` attribute all test for this exact prefix. Keep it.
const NO_KNOWLEDGE = 'No matching knowledge found.'
const NEVER_INVENT =
  ` Do NOT state any amount, date, number, or policy/account detail of your own — a confident ` +
  `wrong figure is far worse than admitting you don't have it.`

// A knowledge miss must NOT end the call when a lookup tool could still answer.
//
// The knowledge base holds material that is the same for every caller; anything
// about THIS caller's own account lives behind a lookup. On a real call the caller
// asked about their loan, the model reached for search_knowledge, missed — and this
// instruction told it to apologise and offer a callback. It never asked for the
// customer ID, and never called the loan_status tool the tenant had configured. The
// caller was turned away from a question the system could have answered.
function noKnowledgeInstruction(tenantConfig = {}) {
  const names = (Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : [])
    .map(l => sanitizeName(l?.name)).filter(Boolean)

  if (names.length) {
    return `${NO_KNOWLEDGE} The knowledge base holds general information only — it NEVER holds ` +
      `anything about an individual caller's own account. If the caller was asking about THEIR ` +
      `account, that lives behind ${names.join(' or ')}. Ask them for the one detail that tool ` +
      `needs — their customer ID or registered phone number — and then call it. Do NOT tell the ` +
      `caller you cannot help, and do NOT offer a callback, until you have actually tried that ` +
      `tool. Only if it ALSO comes back empty should you say you don't have the detail.` + NEVER_INVENT
  }

  return `${NO_KNOWLEDGE} You do NOT have this information. Tell the caller plainly that you don't ` +
    `have that detail to hand, and offer to have the team confirm it and follow up.` + NEVER_INVENT
}

// Caller-specific facts we already hold for THIS call — name plus whatever the
// campaign contact row carried (policy number, renewal date, premium, …).
//
// Without this the model knows the caller's name from the greeting template and
// nothing else, so the moment they ask "when does mine expire?" it has no grounded
// answer available. Empty string for inbound calls, where we have no contact row.
function callerContext(tenantConfig) {
  const name = String(tenantConfig.contact_name || '').trim()
  const raw = tenantConfig.contact_fields
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const lines = []
  if (name) lines.push(`- name: ${name}`)
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue
    // Objects would stringify to "[object Object]" and teach the model nothing.
    const val = (typeof v === 'object' ? JSON.stringify(v) : String(v)).trim()
    if (!val) continue
    lines.push(`- ${k.replace(/_/g, ' ')}: ${val.slice(0, 200)}`)
    if (lines.length >= 30) break   // bound the prompt; a contact row can be wide
  }
  if (!lines.length) return ''

  return `

WHAT YOU KNOW ABOUT THIS CALLER (from our own records — accurate, use it freely and
answer straight from it without calling a tool):
${lines.join('\n')}
That list is the COMPLETE set of caller-specific details you hold. Anything about this
caller that is NOT listed above, you do not know — say so and offer to have the team
confirm, rather than guessing a value.`
}

// On an INBOUND call the caller dialled us, so the agenda is theirs. Any goal in
// the tenant's stored prompt ("secure a payment commitment") is written for
// outbound and, left unqualified, makes the agent open a customer's own service
// call with a payment demand — on a real call it answered "I want to ask about my
// loan" with the EMI amount, the due date and "are you ready to pay?", and the
// caller had to interrupt to ask their actual question.
function inboundRule(tenantConfig) {
  if (tenantConfig.is_outbound) return ''
  return `
- THIS IS AN INBOUND CALL — they rang you, so they have a reason and it is not yours. Establish what they actually want and deal with that FIRST, completely. Never open with a payment reminder, a due date, an outstanding balance, or "are you ready to pay?". Any goal described in your instructions above is for calls WE place; here you may raise it at most ONCE, near the end, after their reason for calling has been fully handled — and not at all if they are in the middle of something else.`
}

function buildInstructions(tenantConfig, lockedLang, openingLang) {
  const base = buildSystemPrompt(tenantConfig, { speechToSpeech: true })
  // Recognition vocabulary = auto-derived from the client's KB (kb_keyterms) PLUS
  // any manual overrides (stt_keyterms). Auto-derived means it scales to any
  // client without hand-curation.
  const manual = Array.isArray(tenantConfig.stt_keyterms) ? tenantConfig.stt_keyterms : []
  const auto = Array.isArray(tenantConfig.kb_keyterms) ? tenantConfig.kb_keyterms : []
  const seen = new Set()
  const terms = [...auto, ...manual]
    .map(t => String(t || '').trim())
    .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
  const vocab = terms.length
    ? `\n- RECOGNITION VOCABULARY (CLOSED SET): this business operates ONLY with these exact place and project names: ${terms.join(', ')}. This list is the COMPLETE universe of valid locations and projects for this caller.
- When the caller names a place or project, you MUST map what you heard to the CLOSEST match in this list. If the place you think you heard is NOT in this list (e.g. a far-off city like Pune, Mumbai, Bangalore, Delhi), then you MISHEARD — it is physically impossible for it to be correct. Do NOT act on it, do NOT search it, do NOT recommend for it. Instead, read back the closest listed area and ask the caller to confirm, e.g. "Kokapet aa sir?" before doing anything.
- Never substitute a similar-sounding place that is not in the list (never hear "Kokapet" as "Kukatpally", never as "Pune").`
    : ''

  // Language is governed by an explicit out-of-band steering system (see
  // LanguageManager): it decides the conversation language from the caller's
  // first meaningful utterance, switches only on an explicit request or a stable
  // two-utterance signal, and tells the model via a steering turn. So the model's
  // job here is STABILITY, not per-turn re-detection — the old "switch every turn"
  // rule is exactly what caused Telugu↔English↔Hindi oscillation on code-mixed
  // speech. This block is #1 priority and overrides any mirroring rule below.
  const langPriority = `#1 PRIORITY — LANGUAGE CONTROL POLICY (overrides every other language rule below):

THE APPLICATION OWNS THE CONVERSATION LANGUAGE — not you. A deterministic
language manager watches the caller and tells you, via a LANGUAGE CONTROL
directive, what the CURRENT CONVERSATION LANGUAGE is. Respond primarily in that
language and do not change it on your own initiative.

You must NEVER change the primary conversation language because:
- the caller used a few words from another language;
- the caller used English business or technical words (EMI, loan, payment,
  account, details, booking, price, GST, sq ft) — that is normal code-mixing;
- the caller said hello, okay, yes, no, sir, madam, thanks or similar;
- retrieved reference information happens to be in another language;
- you internally judged another language would suit the caller better;
- your own previous reply came out in another language;
- the caller's accent or pronunciation made a turn ambiguous.

A language change is legitimate ONLY when a LANGUAGE CONTROL directive gives you
a new CURRENT CONVERSATION LANGUAGE. Until one arrives, stay where you are — even
if you are unsure. Staying in the current language for one more turn is always
better than switching wrongly.

When the caller code-switches naturally, keep the current primary language and
mirror their code-mixing inside it.
- NEVER refuse a language. NEVER tell the caller which language to use. NEVER say you were "told", "asked", or "instructed" to use a language, and never explain, apologize for, or comment on the language you are using. Just speak — switching silently and naturally when the caller's language changes.
- Code-mixing is NOT a language change: callers speak Telugu or Hindi while borrowing English words like "flat", "booking", "3BHK", "GST", "price", "loan" and place/project names like "Kokapet" or "My Home". Keep the caller's base language — do not switch your WHOLE reply to English just because they used an English noun. But YOU must code-mix the SAME way they do: keep these common English business/technical words IN ENGLISH (say "units", "price", "size", "sq ft", "clubhouse", "swimming pool", "amenities", "possession", "loan") instead of translating them into bookish/literary Telugu or Hindi. Speak the natural everyday Tinglish/Hinglish register a real estate agent actually uses on the phone — never stiff textbook language.
- Your greeting language is only an opener; it does NOT lock the conversation. On the caller's first real words, match their language.`

  // Reconnect robustness: a reconnect starts a FRESH session with no prior context,
  // so if the conversation language was already established we bake it straight into
  // the system instruction. This is the authoritative, turn-semantics-free channel
  // and means the language survives reconnects without relying on any steer message.
  // Before the first substantive utterance the LanguageManager has NO verdict, and
  // the classifier is deliberately not gated on for Latin/romanized speech (holding
  // the reply for it costs ~1s of dead air on every call). That left turn one with
  // NOTHING anchoring its language, so the model was free to drift — an English
  // caller could get a Telugu first reply, corrected only from turn two.
  //
  // So we seed the language the caller is about to HEAR: the greeting's own. It's a
  // DEFAULT, not a lock — the rules above still hand the conversation to the caller
  // the moment they speak something else, and the real verdict overrides this as
  // soon as it lands. Costs nothing: no gate, no classifier call, no latency.
  // Worded as a FALLBACK for ambiguity, never as an instruction to open in this
  // language regardless. The model hears the caller's actual audio, which is a
  // better signal than anything we can pass it — a caller speaking romanized Telugu
  // ("nenu flat kavali") reads as Latin text but sounds unmistakably Telugu. So
  // mirroring stays primary; this only fills the vacuum when there's no signal yet.
  const openingNote = openingLang
    ? `\n\nDEFAULT LANGUAGE (fallback only): while you still cannot tell what language the caller speaks — before they have said anything, or when their words are too short, garbled or ambiguous to judge — use ${openingLang}, the language of your greeting. The moment you CAN tell what language they are speaking, speak THAT instead, starting with your very first reply to them. NEVER pick a third language that neither of you has used — in particular, do NOT fall back to Hindi just because the caller sounds Indian or their words were unclear.`
    : ''

  const lockedNote = lockedLang
    ? `\n\nCURRENT CONVERSATION LANGUAGE: ${lockedLang}. The language manager established this. Reply primarily in ${lockedLang} and do not greet again. Do not change it yourself — a legitimate change reaches you as a LANGUAGE CONTROL directive.`
    : openingNote

  // Only nudge WhatsApp behaviour when the tenant actually has it configured.
  const waRule = whatsappReady(tenantConfig)
    ? `\n- WHATSAPP: when the caller agrees to receive something on WhatsApp (a document like a brochure/menu/price list, or a confirmation once an appointment/booking is made), you MUST call the send_whatsapp tool — kind 'document' or 'confirmation', with a short 'about' describing it — and only after it succeeds tell them it's on their WhatsApp. NEVER claim you sent it without calling the tool. Send each item ONCE: if the caller says they haven't received it yet, DO NOT call send_whatsapp again — reassure them it's been sent and can take a minute to arrive (resending the same file to the same number makes WhatsApp drop it).`
    : ''

  return `${langPriority}${lockedNote}

${base}${callerContext(tenantConfig)}

SPEECH-TO-SPEECH RULES:${inboundRule(tenantConfig)}
- LOCATION: NEVER assume, invent, or guess a city or area. Never say "Mumbai", "Gurgaon", or any place the caller did not state. Use ONLY a location the caller has explicitly given. If you don't yet know their location, ASK for it before recommending or searching — do not fill one in, and do not search a location they didn't mention.${vocab}
- GROUNDING — you do NOT personally know ANY specific fact about this business or this caller. That means no prices, amounts, premiums, fees, due dates, renewal or expiry dates, policy/account/reference numbers, plan or project names, sizes, locations, or contract terms. There are exactly THREE valid sources: (a) the caller-specific records given to you above, (b) a tool result on this call, (c) something the caller told you on this call. If none of the three has given you a value, you do NOT have it — say so plainly and offer to have the team confirm it. NEVER state a number, date, amount or identifier you were not given: a confident wrong figure is far worse than admitting you don't have it, and on a billing or renewal call it is the single most damaging thing you can do. BUT before searching, CHECK what you already retrieved earlier in THIS conversation: if the answer is already in that context (e.g. you pulled a plan's full details and the caller now asks its price), answer from it and do NOT call search_knowledge again. Only call search_knowledge for information you have NOT yet retrieved this call. Never invent or guess — but never re-fetch what you already have.
- PICK THE RIGHT TOOL. Anything about THIS caller's own account — their balance, their EMI, their due date, their policy, their order, their booking — comes from a lookup tool, NEVER from search_knowledge. search_knowledge holds general material that is identical for every caller: policies, charges, processes, product facts. If you need a caller-specific fact, ask them for their customer ID or registered phone number and call the lookup. Never tell a caller you cannot help with their own account until you have actually tried that tool.
- AFTER A LOOKUP SUCCEEDS, SAY ONLY WHAT WAS ASKED FOR. A lookup returns the caller's WHOLE record; reciting it is a data dump, not service. If they asked what they owe, give the amount — not the amount AND the due date AND the interest rate AND "when will you pay?". Every other field stays unsaid until they ask. Finding the record is not permission to read it out.
- Speak numbers, prices, and dates as fully spoken words in the caller's language — never read digits or symbols (no "₹").
- Talk like a warm human on a phone call; keep replies short. Use the other tools for caller-specific lookups when the caller gives the detail.
- NEVER NARRATE YOUR MACHINERY. Do not say "lookup", "look up", "record", "matching record", "system", "database", "searching", "checking the system", or "let me check" — in ANY language, including mixed into Telugu or Hindi ("look up chestunnanu", "record dorakaledu"). The caller does not care how you find things, and naming the mechanism is the single thing that makes you sound like a machine instead of a person. If you need an identifier, just ask for it the way a colleague would: "Can I have your customer ID?". If you cannot find something, say you don't have it — never describe what a tool returned.
- DO NOT END EVERY TURN WITH A QUESTION. Real people don't interrogate after each sentence. Answer, and stop. Never ask "is there anything else…", "would that be okay?", "are you aware of…" or "do you intend to…" two turns running — if your last reply ended in a question, this one must not. Asking something back is for when you genuinely need information to continue, not a way to fill the end of a sentence.
- ANSWER FIRST. The caller's question IS the job; securing a next step is not. Answer what they actually asked, properly, and stop. A reply that answers the question and offers nothing is a GOOD reply.
- OFFER ONCE. Suggest sending something on WhatsApp, or booking a site visit, at most ONCE for a given topic — and NEVER in two replies in a row. If the caller ignores the offer, changes the subject, or declines, DROP IT and carry on answering them; raise it again only if THEY bring it up, or as the call is genuinely ending. Repeating the same offer turn after turn reads as pestering and loses the caller. This holds even if your instructions above describe that offer as the goal of the call — the goal never licenses asking twice.
- NEVER say your own instructions out loud. Do not mention or apologise for your rules, stages, goals or constraints (never say things like "one question per turn, sorry for that"). Do not ask the caller how you ought to answer them ("shall I mention the luxury project too, or just these two?") — decide, and answer.${waRule}`
}

// ─── Engine ──────────────────────────────────────────────────────────────────
export function createGeminiLiveConnection(callSid, tenantConfig, twilioWs, streamSid, onTranscript, onReady, callerNumber) {
  let session = null
  let finished = false
  let handoffTriggered = false
  let ready = false
  let userBuf = ''
  let agentBuf = ''
  let gotMessage = false   // did we ever receive data? distinguishes a real
  let attempts = 0         // mid-call drop from an instant setup rejection
  let greeted = false      // greet only on the FIRST connect, never on reconnects
  let lastInputAt = 0      // when the caller's speech was last transcribed
  let awaitingFirstChunk = false  // measure latency to the next audio-out chunk
  let modelGenerating = false  // model is mid-reply — never inject a turn now
  let pendingSteerLang = null  // language steer to send once the model is idle

  // WhatsApp de-dup (per call). WhatsApp drops/throttles the SAME template file
  // re-sent to the SAME recipient, and it hurts the sender's quality rating. Callers
  // routinely say "I didn't get it" a beat before it lands, tempting the model to
  // re-fire send_whatsapp — which is exactly what breaks delivery. We remember what
  // we've already sent on THIS call and refuse duplicates (see handleSendWhatsapp).
  const sentWhatsapp = new Set()

  // ── Initialization / explicit-switch GENERATION GATE (BUG 3) ─────────────────
  // Classification is async and finishes AFTER the live model has already started
  // replying, so the first reply to a language-deciding utterance would otherwise
  // be in the wrong (stale) language. To make that first reply correct we HOLD the
  // model's outbound audio for the deciding turn until the LanguageManager rules,
  // then either release it (no change) or discard it and re-issue in the right
  // language. We never touch the resampling pipeline or the server VAD — we only
  // buffer already-produced output for a short, bounded window. The gate is armed
  // ONLY while the language is UNKNOWN (initialization) or on an explicit switch
  // request, so steady-state turns keep their full real-time, zero-hold path.
  const GATE_ENABLED = process.env.LANG_GATE_DISABLED !== '1'
  // The gate now only ever holds for SYNCHRONOUS decisions (script / local explicit
  // switch), which resolve in ~a microtask — so this timer is just a safety net and
  // rarely fires. Kept short so a held reply can never add noticeable latency.
  const GATE_MAX_HOLD_MS = Number(process.env.LANG_GATE_HOLD_MS || 600)
  let gateActive = false        // currently holding output for a pending decision
  let gateHeld = []             // buffered outbound μ-law base64 frames
  let gateUtterance = ''        // the caller utterance that armed the gate
  let gateDecision = undefined  // undefined = pending, null = keep, <string> = re-issue in this lang
  let gateTurnDone = false      // has the held model turn reached turnComplete?
  let gateTimer = null          // fail-open timer so the caller is never held in silence too long
  let gateArmedAt = 0           // when the current gate started holding (for gate_hold_ms)

  // ── Telemetry ────────────────────────────────────────────────────────────────
  // One structured JSON line per event so production logs are trivially queryable,
  // PLUS the centralized Operations Center trace (looked up by callSid; the vobiz
  // layer created it before this engine, so it's present for real calls and a
  // harmless no-op for the browser test stream).
  const callStartedAt = Date.now()
  // Time-to-first-word instrumentation (matters most on OUTBOUND, where the callee
  // hears silence until the greeting plays): connectStartedAt→ready = Gemini session
  // handshake; greetingSentAt→first audio = model producing the opening line.
  let connectStartedAt = 0, readyMs = 0, greetingSentAt = 0, greetingTimed = false
  // HI-FI mode (browser clients, e.g. the public demo): skip the telephony codec
  // entirely. Phones need 8kHz G.711 µ-law, but a browser can carry Gemini's NATIVE
  // audio — so we pass 24kHz PCM straight out and take 16kHz PCM straight in.
  // Downsampling to 8kHz µ-law for a browser just makes the model sound tinny.
  const HIFI = tenantConfig.audio_io === 'pcm'
  // The voice this caller will hear: the tenant's picked voice, validated to a
  // real Gemini voice (falls back to the default for empty/legacy values).
  const sessionVoice = resolveGeminiVoice(tenantConfig.voice, GEMINI_VOICE)
  // Optional spoken-language/accent (BCP-47), e.g. 'en-IN' for Indian English so
  // the model doesn't default to US English. Opt-in: when unset, we omit it and
  // the model auto-detects (keeps the multilingual mirroring path unchanged).
  const languageCode = tenantConfig.language_code || process.env.GEMINI_LANGUAGE_CODE || null
  const trace = telemetry.getTrace(callSid)
  trace?.set('model', GEMINI_MODEL)
  trace?.set('voice', sessionVoice)
  let geminiSessionSpan = null     // open span for the current live session
  let turnStartedAt = 0            // when the caller's deciding utterance ended (turn timing)
  let langDetectStartedAt = 0      // when a classification began (language-detection latency)
  // AI-quality detectors (real, cheap, no LLM): duplicate replies + silent turns.
  let lastAgentText = ''           // previous agent reply, to catch near-duplicate responses
  let callerTurnPending = false    // a caller utterance is awaiting a reply this turn
  let agentRespondedThisTurn = false  // did the agent produce any audio/text this turn?
  let langInitLogged = false
  const logMetric = (event, fields) => {
    try { console.log(`[LANG_METRIC] ${JSON.stringify({ callSid, event, ...fields })}`) } catch { /* never throw from logging */ }
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY })
  // Deterministic conversation-language state machine (classification + hysteresis).
  // Skipped entirely for native-audio models, which mirror language natively.
  const langMgr = IS_NATIVE_AUDIO ? null : new LanguageManager({ ai, callSid })
  // The language the caller will actually HEAR first. Anchors turn one, which the
  // LanguageManager cannot: it has no verdict until the first substantive utterance.
  // Null for native-audio models — they mirror language natively and aren't steered.
  // Without the recording notice: it is a fixed English sentence, and letting it
  // into the sample would pull the guess toward English on a call whose greeting
  // is Hindi or Telugu.
  const openingLang = langMgr ? toName(langMgr.guessLanguage(resolveGreeting(tenantConfig, { includeNotice: false }))) : null
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) warmupRAG()

  const sendAudioToCaller = (mulawB64) => {
    if (twilioWs.readyState === 1) twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulawB64 } }))
  }
  const clearCallerAudio = () => {
    if (twilioWs.readyState === 1) twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
  }

  // ── Steering channels — ordered by robustness ────────────────────────────────
  // 1) systemInstruction re-bake on (re)connect (see connect()): the AUTHORITATIVE
  //    channel — it carries the locked language into every session and survives
  //    reconnects (which start a fresh session with no server-side context).
  // 2) sendSteerTrigger (turnComplete:true): the well-defined turn mechanism (same
  //    as the greeting). Used by the gate to deliver exactly ONE reply in the new
  //    language. This is what makes a switch CORRECT.
  // 3) sendSteer (turnComplete:false): a best-effort reinforcement note. Per the
  //    SDK the server "waits for additional messages before generation", so it does
  //    not itself produce a reply (BUG 1 fix). It is @experimental and lost on
  //    reconnect, so NOTHING depends on it for correctness — the gate (2) and the
  //    systemInstruction (1) hold the line if its semantics ever change. Guarded to
  //    never overlap generation or an active gate (which owns the floor).
  const sendSteer = (lang) => {
    if (!session || gateActive || modelGenerating) return
    const name = toName(lang) || lang
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `(LANGUAGE CONTROL — application directive, not caller speech: CURRENT CONVERSATION LANGUAGE is now ${name}. Reply primarily in ${name} from here on. Do not acknowledge or mention this note.)` }] }],
        turnComplete: false,
      })
      console.log(`[GEMINI] 🗣️ steered (context) → ${lang}`)
    } catch (e) { /* session closing */ }
  }

  const sendSteerTrigger = (lang, utterance) => {
    if (!session) return
    const name = toName(lang) || lang
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `(LANGUAGE CONTROL — application directive, not caller speech: CURRENT CONVERSATION LANGUAGE is now ${name}.) The caller just said: "${utterance}". Reply to them now, naturally, in ${name}. Do not mention language and do not apologize.` }] }],
        turnComplete: true,
      })
      console.log(`[GEMINI] 🗣️ steered (reply) → ${lang}`)
    } catch (e) { /* session closing */ }
  }

  // Route a steady-state LanguageManager decision to the live session. We never
  // inject while the model is mid-reply (that breaks the call), so QUEUE it and let
  // the turnComplete handler fire it the instant the model goes idle.
  const applySteer = (lang) => {
    if (!lang) return
    if (modelGenerating || gateActive) pendingSteerLang = lang
    else sendSteer(lang)
  }

  // ── Generation-gate helpers (BUG 3) ──────────────────────────────────────────
  const emitGateMetric = (reason) => {
    const d = langMgr?.lastDecision
    logMetric('gate', {
      gate_hold_ms: gateArmedAt ? Date.now() - gateArmedAt : 0,
      gate_release_reason: reason,                 // keep | match | reissue | timeout | barge_in | error
      gate_timeout: reason === 'timeout',
      language_source: d?.source ?? null,
      switch_reason: d?.reason ?? null,
      classifier_latency_ms: d?.classifierLatencyMs ?? 0,
      classifier_confidence: d?.confidence ?? null,
      assistant_language: langMgr?.current ?? null,
    })
  }
  const maybeLogInit = (firstReplyLang) => {
    if (langInitLogged || !langMgr?.initialized) return
    langInitLogged = true
    logMetric('language_init', {
      language_init_ms: Date.now() - callStartedAt,
      language: langMgr.current,
      language_source: langMgr.lastDecision?.source ?? null,
      first_reply_language: firstReplyLang ?? langMgr.current,
    })
  }

  const resetGate = () => {
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null }
    gateActive = false; gateHeld = []; gateDecision = undefined; gateTurnDone = false; gateUtterance = ''; gateArmedAt = 0
  }

  // Stream whatever we held and let the model's reply stand (language unchanged, or
  // the fail-open path when a decision is slow). `reason` feeds telemetry.
  const releaseHeldAudio = (reason) => {
    if (!gateActive) return
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null }
    emitGateMetric(reason)
    gateActive = false
    for (const b64 of gateHeld) sendAudioToCaller(b64)
    gateHeld = []
    if (gateTurnDone) flushAgent()   // the held reply already finished — record it now
    maybeLogInit(langMgr?.current)   // the released reply is in the current language
  }

  // Decide whether the held turn should be released or discarded+re-issued. Safe to
  // call repeatedly; it only acts once the verdict is known (and, for a re-issue,
  // once the held turn has finished so replies never overlap).
  const resolveGate = () => {
    if (!gateActive || gateDecision === undefined) return
    if (gateDecision === null) { releaseHeldAudio('keep'); return }   // language unchanged
    if (!gateTurnDone) return                                         // wait for the held turn to end
    const lang = gateDecision, utt = gateUtterance
    // If the model ALREADY replied in the right language (natural mirroring, which
    // the system prompt allows until lock-in), keep that reply and just lock the
    // language for future turns — no discard, no re-issue, no dead-air.
    if (langMgr && langMgr.replyMatchesLanguage(agentBuf, lang) === true) {
      console.log(`[GEMINI] 🚦 gated decision → ${lang} (held reply already matches; releasing + locking)`)
      releaseHeldAudio('match')   // stream the held reply, record it, log metrics
      sendSteer(lang)             // best-effort lock for subsequent turns
      return
    }
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null }
    emitGateMetric('reissue')
    gateActive = false; gateHeld = []; gateDecision = undefined; gateUtterance = ''; gateArmedAt = 0
    agentBuf = ''   // the held reply was the wrong language — discard, don't record it
    console.log(`[GEMINI] 🚦 gated decision → ${lang} (discarded stale reply, re-issuing)`)
    maybeLogInit(lang)            // the reply the caller WILL hear is in `lang`
    sendSteerTrigger(lang, utt)
  }

  // The LanguageManager finished classifying a GATED utterance.
  const onGateDecision = (lang) => {
    if (!gateActive) { if (lang) applySteer(lang); return }   // already released (timeout) → fix next turn
    gateDecision = lang || null
    resolveGate()
  }

  // Called the moment the model STARTS replying to a caller utterance. If this turn
  // could change the conversation language, hold its output and classify now. The
  // decision of WHETHER to gate is deterministic and synchronous (LanguageManager.
  // shouldGate): UNKNOWN, an explicit-switch phrase, or a different Indic script.
  const armGate = () => {
    const utt = userBuf.trim()
    if (!GATE_ENABLED || !langMgr || gateActive || !utt) return
    if (!langMgr.shouldGate(utt)) return
    gateActive = true; gateHeld = []; gateDecision = undefined; gateTurnDone = false; gateUtterance = utt; gateArmedAt = Date.now()
    flushUser()   // classify NOW; the decision returns via onGateDecision()
    gateTimer = setTimeout(() => { console.log('[GEMINI] ⏳ lang gate timed out — releasing held reply'); releaseHeldAudio('timeout') }, GATE_MAX_HOLD_MS)
  }

  const flushUser = () => {
    const text = userBuf.trim(); userBuf = ''
    if (!text) return
    console.log(`[GEMINI] Caller: "${text}"`)
    // Conversation language is owned by the LanguageManager: it classifies this
    // finalized utterance (code-mix aware) and returns a language to steer to only
    // when something should actually change — first substantive utterance, an
    // explicit caller request, or a stable two-utterance shift. Greetings, acks and
    // filler are ignored (BUG 2/4). Runs async, off the audio path.
    if (langMgr) {
      const gated = gateActive   // is the model's reply to THIS turn being held?
      langMgr.ingest(text)
        .then(res => {
          // The manager is the sole authority. It returns 'init' or 'switch'
          // exactly when the engine must steer; everything else is 'none' and the
          // conversation stays where it is.
          const lang = res.action === 'none' ? null : res.currentLanguage
          if (lang) console.log(`[GEMINI] 🧭 language ${res.action} → ${lang} (${res.reason}, conf ${res.confidence.toFixed(2)})`)
          logMetric('decision', {
            caller_language: res.detectedLanguage,
            assistant_language: langMgr.current,
            language_state: res.state,
            language_source: res.reason,
            switch_reason: res.action === 'none' ? null : res.action,
            classifier_used: res.classifierUsed,
            classifier_latency_ms: res.classifierLatencyMs,
            classifier_confidence: res.confidence,
            gated,
          })
          // Operations Center: surface the live conversation language + feed the
          // language-detection latency histogram (only when the classifier ran),
          // plus aggregate counters for the Language Analytics dashboard.
          if (langMgr.current) trace?.set('language', langMgr.current)
          // Separate from 'language' (which the Operations Center shows live):
          // this is what the CALL gets filed under, and it must survive a late
          // mis-detection. See LanguageManager.dominant.
          if (langMgr.dominant) trace?.set('dominantLanguage', langMgr.dominant)
          if (res.classifierUsed && res.classifierLatencyMs) {
            telemetry.recordLatency('language_detection', res.classifierLatencyMs, { tenantId: trace?.tenantId })
            telemetry.incr('lang_classifier_used')
          }
          telemetry.incr('lang_decision')
          telemetry.incr(`lang_reason:${res.reason}`)                        // why we did or didn't act
          if (res.detectedLanguage) telemetry.incr(`lang_detected:${res.detectedLanguage}`)
          if (res.confidence) telemetry.recordLatency('lang_confidence', Math.round(res.confidence * 100), { tenantId: trace?.tenantId })
          if (res.action === 'init') telemetry.incr('lang_init')
          else if (res.action === 'switch') {
            telemetry.incr(res.reason === 'explicit_request' ? 'lang_switch_explicit' : 'lang_switch_auto')
          }
          if (gated) onGateDecision(lang)   // release the held reply or re-issue it
          else if (lang) applySteer(lang)   // steady-state: queue a context steer
        })
        .catch(e => {
          console.error('[GEMINI] lang ingest failed:', e.message)
          telemetry.incr('lang_failures')
          telemetry.recordServiceEvent({ component: 'language', severity: 'warning', kind: 'classify_failed', detail: { callSid, error: e.message } })
          if (gated) releaseHeldAudio('error')
        })
    }
    getHistory(callSid).push({ role: 'user', content: text })
    trace?.set('lastTranscript', text.slice(0, 240))
    turnStartedAt = Date.now()   // the caller just finished — start timing the turn
    callerTurnPending = true; agentRespondedThisTurn = false   // expect a reply now (silent-turn detector)
    if (onTranscript) onTranscript(text, 'user')
    if (!handoffTriggered && detectHandoffKeyword(text)) {
      handoffTriggered = true
      console.log(`[GEMINI] 🔑 Handoff keyword: "${text}"`)
      trace?.event('human_handoff', { keyword: text.slice(0, 80) })
      trace?.set('intent', 'human_handoff')
      telemetry.incr('handoffs_total')
      if (onTranscript) onTranscript('[SYSTEM] Call handed off to human agent')
      transferToHuman(callSid, tenantConfig.handoff_number, callerNumber, tenantConfig).catch(e => console.error('[GEMINI] handoff failed:', e.message))
    }
  }
  const flushAgent = () => {
    const text = agentBuf.trim(); agentBuf = ''
    if (!text) return
    // Native-audio snapshots have historically SPOKEN the tool-call syntax aloud
    // instead of invoking it — which silently breaks RAG. Flag it loudly so this
    // failure mode is unmistakable in the logs during testing.
    if (/search_knowledge|\[call:|<ctrl|functionCall/i.test(text)) {
      console.warn('[GEMINI] ⚠️ model SPOKE a tool call instead of invoking it — this native-audio snapshot may not support function calling. Fall back with GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview.')
    }
    console.log(`[GEMINI] Agent: "${text}"`)
    // Duplicate-reply detector: flag when the agent repeats itself near-verbatim
    // (a real quality failure — usually a stuck/looping turn). Normalize first.
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (text.length > 12 && norm(text) === norm(lastAgentText)) {
      telemetry.incr('quality_duplicate_reply')
      trace?.event('duplicate_reply')
    }
    lastAgentText = text
    getHistory(callSid).push({ role: 'assistant', content: text })
    trace?.set('lastAgentReply', text.slice(0, 240))
    // Turn duration = caller-stopped → agent-reply-complete (full round-trip).
    if (turnStartedAt) { telemetry.recordLatency('turn', Date.now() - turnStartedAt, { tenantId: trace?.tenantId }); turnStartedAt = 0 }
    if (onTranscript) onTranscript(text, 'assistant')
  }

  async function handleMessage(msg) {
    gotMessage = true
    const sc = msg.serverContent

    // Caller transcript (incremental) — accumulate BEFORE we look at any model
    // output, so the gate/classifier always see the complete utterance.
    if (sc?.inputTranscription?.text) { userBuf += sc.inputTranscription.text; lastInputAt = Date.now(); awaitingFirstChunk = true }

    // Outbound audio → resample 24k→8k → μ-law → caller
    if (sc?.modelTurn?.parts) {
      const justStarted = !modelGenerating
      modelGenerating = true   // the model is mid-reply — don't inject turns now
      // The model just began replying to a caller utterance: decide whether this
      // turn's output must be held until the language is known (BUG 3).
      if (justStarted) { armGate(); trace?.set('conversationState', 'speaking') }
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData?.data) {
          if (awaitingFirstChunk) {
            const firstAudioMs = Date.now() - lastInputAt
            console.log(`[GEMINI] ⏱️ first audio ${firstAudioMs}ms after you stopped speaking`)
            telemetry.recordLatency('first_audio', firstAudioMs, { tenantId: trace?.tenantId })
            telemetry.recordLatency('model_thinking', firstAudioMs, { tenantId: trace?.tenantId })
            trace?.set('lastLatencyMs', firstAudioMs)
            // Running total, averaged onto the call row at hangup — one slow turn
            // shouldn't be what the client's "avg. response" reports.
            trace?.bump('replyCount')
            trace?.bump('replyMsTotal', firstAudioMs)
            awaitingFirstChunk = false
          }
          // Greeting time-to-first-word: the opening line is the very first audio of
          // the call. readyMs = session handshake; greetMs = model producing the line.
          if (!greetingTimed && greetingSentAt) {
            greetingTimed = true
            const greetMs = Date.now() - greetingSentAt
            console.log(`[GEMINI] ⏱️ greeting first word ${greetMs}ms after ready (total to first word ≈ ${readyMs + greetMs}ms from session start)`)
          }
          // HI-FI: forward Gemini's native 24kHz PCM untouched. Telephony: 24k→8k→µ-law.
          const outB64 = HIFI
            ? p.inlineData.data
            : pcm16ToMulaw(downsample24to8(Buffer.from(p.inlineData.data, 'base64'))).toString('base64')
          agentRespondedThisTurn = true   // the agent produced audio (silent-turn detector)
          if (gateActive) gateHeld.push(outB64)   // hold — don't let the caller hear it yet
          else sendAudioToCaller(outB64)
        }
      }
    }

    // Barge-in — abandon any held reply too (the caller is taking the turn).
    if (sc?.interrupted) {
      agentBuf = ''; clearCallerAudio(); if (gateActive) { emitGateMetric('barge_in'); resetGate() }
      trace?.bump('interruptions'); trace?.event('barge_in')
      telemetry.incr('interruptions_total')
    }

    // Model reply transcript (incremental). Flush caller text once the model starts.
    if (sc?.outputTranscription?.text) {
      // The reply may surface as transcript before its first audio chunk — arm the
      // gate here too so we never miss the start of a language-deciding turn.
      if (!modelGenerating) { modelGenerating = true; armGate() }
      if (userBuf.trim()) flushUser()
      agentBuf += sc.outputTranscription.text
      agentRespondedThisTurn = true
    }
    if (sc?.turnComplete) {
      if (userBuf.trim()) flushUser()
      modelGenerating = false
      trace?.set('conversationState', 'listening')
      // Silent-turn detector: a caller spoke but the agent produced nothing.
      if (callerTurnPending && !agentRespondedThisTurn) {
        telemetry.incr('quality_silent_response')
        trace?.event('silent_response')
      }
      callerTurnPending = false
      if (gateActive) {
        // The held turn just finished. Release it (if the language didn't change)
        // or discard + re-issue (if it did); if the verdict is still pending, keep
        // holding — the fail-open timer guarantees the caller is never stuck.
        gateTurnDone = true
        resolveGate()
      } else {
        flushAgent()
        // Model is now idle — safe to fire a queued (context) language steer.
        if (pendingSteerLang) { const l = pendingSteerLang; pendingSteerLang = null; sendSteer(l) }
      }
    }

    // Function calls (RAG + lookups)
    if (msg.toolCall?.functionCalls?.length) {
      const responses = []
      for (const fc of msg.toolCall.functionCalls) {
        let output = ''
        trace?.set('currentTool', fc.name)
        // One span per tool invocation: name, success/fail, latency, payload size.
        const toolSpan = trace?.span('tool_call', { tool: fc.name, args: fc.args || {} })
        try {
          if (fc.name === 'search_knowledge') {
            output = await retrieveKnowledge(tenantConfig.tenant_id, fc.args?.query || '') || noKnowledgeInstruction(tenantConfig)
            // Say MISS outright rather than printing a character count the reader
            // has to decode — a miss now returns a long instruction, so its length
            // no longer distinguishes it from a hit.
            console.log(`[GEMINI] 🔎 search_knowledge("${fc.args?.query}") → ${output.startsWith(NO_KNOWLEDGE) ? 'MISS (no knowledge — told not to invent)' : output.length + ' chars'}`)
            // "Info hit rate" on the client dashboard: how often a question the
            // agent looked up was actually answerable from their own material.
            trace?.bump('knowledgeAsks')
            if (!output.startsWith(NO_KNOWLEDGE)) {
              trace?.bump('knowledgeHits')
            } else if (trace) {
              // Remember what we couldn't answer; the rows are written once at
              // hangup. Inserting here would put a Supabase round-trip on the
              // tool path, which is the latency the caller actually hears.
              const q = String(fc.args?.query || '').trim().slice(0, 300)
              const seen = trace.state.knowledgeMisses || []
              if (q && !seen.includes(q)) trace.set('knowledgeMisses', [...seen, q].slice(0, 20))
            }
          } else if (fc.name === 'add_to_dnd') {
            const res = await addToDnd({
              tenantId: tenantConfig.tenant_id,
              phone: callerNumber,
              source: 'caller_request',
              reason: fc.args?.reason || null,
            })
            output = res.ok
              ? 'Done — they have been removed and will not be contacted again. Confirm this warmly, then say goodbye and end the call.'
              : 'Could not record that automatically. Apologise, assure them it will be handled, and end the call politely.'
            console.log(`[GEMINI] 🚫 add_to_dnd(${res.phone}) → ${res.ok ? (res.alreadyListed ? 'already listed' : 'added') : 'FAILED'}`)
            trace?.set('optedOut', res.ok)
          } else if (fc.name === 'send_whatsapp') {
            output = await handleSendWhatsapp(tenantConfig, callerNumber, fc.args || {}, sentWhatsapp)
            console.log(`[GEMINI] 💬 send_whatsapp(${fc.args?.kind}) → ${output}`)
          } else {
            const lkArgs = fc.args || {}
            const hasArg = Object.values(lkArgs).some(v => v !== null && v !== undefined && String(v).trim() !== '')
            if (!hasArg) {
              // A lookup with NO parameters can only ever miss. On a real call
              // loan_status({}) fired on the opening turn — before the caller had
              // said anything — burning a turn and teaching the model the tool was
              // broken. Refuse it and tell the model what to collect instead.
              output =
                `You called ${fc.name} without any of the details it needs, so nothing could be looked up. ` +
                `Ask the caller for ONE identifying detail first — their customer ID or registered phone ` +
                `number — then call it again. Do not mention the lookup itself to the caller.`
              console.log(`[GEMINI] 🔧 ${fc.name}() → SKIPPED (no arguments — told to ask for an id first)`)
            } else {
              // callerNumber lets the lookup gate financial disclosure when the
              // record's phone is not the number this call came from.
              output = await runLookup(tenantConfig, fc.name, lkArgs, { callerNumber })
              console.log(`[GEMINI] 🔧 ${fc.name}(${JSON.stringify(lkArgs)})`)
            }
          }
          telemetry.incr(`tool:${fc.name}:ok`)
          toolSpan?.end({ payloadBytes: Buffer.byteLength(String(output)), attrs: { hit: !!output && !/^No matching|could not be retrieved/i.test(String(output)) } })
        } catch (e) {
          output = 'That information could not be retrieved right now.'
          console.error(`[GEMINI] tool ${fc.name} failed:`, e.message)
          telemetry.incr(`tool:${fc.name}:error`)
          telemetry.incr('tool_errors_total')
          toolSpan?.end({ error: e })
          telemetry.recordServiceEvent({ component: 'tool', severity: 'error', kind: 'tool_failure', detail: { tool: fc.name, error: e.message, callSid } })
        }
        responses.push({ id: fc.id, name: fc.name, response: { result: String(output) } })
        trace?.set('currentTool', null)
      }
      try { session.sendToolResponse({ functionResponses: responses }) } catch (e) { console.error('[GEMINI] toolResponse failed:', e.message) }
    }
  }

  async function connect() {
    if (finished) return
    connectStartedAt = Date.now()
    // A (re)connect is a brand-new session with no server-side context. Drop any
    // gate / pending steer from the dead session (they referenced it), and re-bake
    // the already-established language straight into the system instruction so it
    // survives the reconnect without depending on any in-band steer message.
    resetGate()
    pendingSteerLang = null
    modelGenerating = false
    const lockedLang = toName(langMgr?.current) || null
    try {
      session = await ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildInstructions(tenantConfig, lockedLang, openingLang),
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: sessionVoice } },
            ...(languageCode ? { languageCode } : {}),
          },
          tools: buildGeminiTools(tenantConfig),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log(`[GEMINI] Connected ✅ (model: ${GEMINI_MODEL}, voice: ${sessionVoice}, lang: ${languageCode || 'auto'})`)
            // Track the live session as a gauge + an open span (ended on close).
            telemetry.gaugeInc('gemini_sessions')
            geminiSessionSpan = trace?.span('gemini_session', { model: GEMINI_MODEL, attempt: attempts })
            telemetry.incr('gemini_sessions_opened')
          },
          onmessage: (m) => { handleMessage(m).catch(e => console.error('[GEMINI] msg handler:', e.message)) },
          onerror: (e) => {
            console.error('[GEMINI] error:', e?.message || e?.reason || JSON.stringify(e))
            telemetry.incr('gemini_errors')
            telemetry.recordServiceEvent({ component: 'gemini', severity: 'error', kind: 'stream_error', detail: { callSid, error: e?.message || e?.reason || 'unknown' } })
          },
          onclose: (e) => {
            console.log(`[GEMINI] Closed (code=${e?.code ?? '?'}, reason=${e?.reason || 'none'})`)
            telemetry.gaugeDec('gemini_sessions')
            geminiSessionSpan?.end({ status: finished ? 'ok' : 'error', attrs: { closeCode: e?.code ?? null, closeReason: e?.reason || null } })
            geminiSessionSpan = null
            telemetry.incr('gemini_sessions_closed')
            telemetry.incr(`gemini_close:${e?.code ?? 'unknown'}`)
            if (finished) return
            // Only reconnect a GENUINE mid-call drop (we'd received data). If it
            // closed before any message, the setup was rejected — don't loop.
            if (gotMessage && attempts < 3) {
              ready = false; attempts++
              trace?.bump('reconnects')
              telemetry.incr('gemini_reconnects')
              telemetry.recordServiceEvent({ component: 'gemini', severity: 'warning', kind: 'reconnect', detail: { callSid, attempt: attempts, closeCode: e?.code ?? null } })
              setTimeout(connect, 800)
            } else if (!gotMessage) {
              console.error('[GEMINI] ⛔ Closed before any data — the model rejected the session. Verify the EXACT model id in AI Studio (set GEMINI_LIVE_MODEL), and that the config is supported by this model.')
              telemetry.recordServiceEvent({ component: 'gemini', severity: 'critical', kind: 'session_rejected', detail: { callSid, model: GEMINI_MODEL, closeCode: e?.code ?? null } })
            }
          },
        },
      })

      // connect() resolves AFTER onopen, with `session` now assigned — so the
      // greeting (and onReady, which flushes buffered audio) must run here, not
      // inside onopen where `session` is still null.
      ready = true
      readyMs = Date.now() - connectStartedAt
      console.log(`[GEMINI] session ready in ${readyMs}ms (handshake + setup)`)
      if (onReady) onReady()
      // Open with a culturally-neutral "Namaste" greeting spoken VERBATIM (the
      // "Namaste" opener works for any Indian caller and does not anchor the model to
      // one language — the #1 rule then mirrors whatever language the caller uses).
      const greeting = resolveGreeting(tenantConfig)
      if (!greeted) {
        greeted = true
        greetingSentAt = Date.now()
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `Open the call by greeting the caller warmly with exactly these words: "${greeting}". Say it as written — do NOT translate it. Then continue in whatever language the caller replies in.` }] }],
            turnComplete: true,
          })
        } catch (e) { console.error('[GEMINI] greeting failed:', e.message) }
      }
    } catch (e) {
      console.error('[GEMINI] connect failed:', e?.message || e)
    }
  }

  connect()

  // Inbound caller audio → Gemini (16kHz PCM). Telephony sends 8kHz µ-law which we
  // decode + upsample; HI-FI browser clients already send 16kHz PCM, so pass through.
  const send = (chunk) => {
    if (!session || !ready) return
    const pcm16 = HIFI ? chunk : upsample8to16(mulawToPcm16(chunk))
    try {
      session.sendRealtimeInput({ audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })
    } catch (e) { /* session closing */ }
  }

  const finish = () => {
    finished = true
    if (session) { try { session.close() } catch {} session = null }
    console.log('[GEMINI] Connection closed')
  }

  return { send, finish }
}
