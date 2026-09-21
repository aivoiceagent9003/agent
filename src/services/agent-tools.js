// agent-tools.js — the tools an agent can reach for, and what it is told when it finds
// nothing. Shared by every engine, because none of this is about audio.
//
// This used to live in gemini-live.js, which is why the builder was called
// buildGeminiTools: the speech-to-speech engine happened to be written first. The tool
// surface was never Gemini-specific — it is the tenant's configured lookups, the
// knowledge base, do-not-call, hanging up, and WhatsApp — and it outlived that engine.
//
// Which tools a tenant gets is a behavioural decision, not an implementation detail,
// so it is exported and tested directly.

import { buildLookupTools, sanitizeName } from './lookups.js'
import { whatsappReady, resolveCfg, tenantWa, sendDocument, sendConfirmation, logWhatsApp } from './whatsapp.js'
import { resolveSendable } from './sendables.js'
import telemetry from './telemetry.js'

// ─── Tools + instructions (shared shape with the OpenAI engine) ──────────────
// Exported so the tool surface is testable: which tools a tenant gets is a
// behavioural decision, not an implementation detail.
export function buildAgentTools(tenantConfig) {
  const decls = []
  for (const t of buildLookupTools(tenantConfig)) {
    const f = t.function || {}
    decls.push({ name: f.name, description: f.description, parameters: f.parameters })
  }
  if (tenantConfig.tenant_id && tenantConfig.enable_kb !== false) {
    decls.push({
      name: 'search_knowledge',
      description: "Search the business knowledge base for facts (prices, projects, policies, product details) missing from supplied information and earlier successful tool results in this call. Reuse retrieved facts for follow-up explanations; search again for missing details, a different product, or a correction. Never invent facts.",
      parameters: {
        type: 'object',
        // No real plan or company names in these examples. A previous version used a
        // live tenant's plan name and the model copied it into a search the caller had
        // never asked for, then answered about the wrong product.
        properties: {
          query: { type: 'string', description: "What to look up, IN ENGLISH, using the caller's request and established conversation context. For options or recommendations, search the category without inventing a company. For variants, search the parent product family, not only the previously mentioned variant. For specific benefits, include the exact company, product and variant. Do not conflate company names with plan names." },
          mode: { type: 'string', enum: ['overview', 'detail'], description: 'Use overview for available plans, recommendations, alternatives, lists, comparisons or variants; detail for a specific product fact. Overview discovers named products across the KB rather than just three similar paragraphs.' },
        },
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

  // Always declared. Leaving the line open after both sides have said goodbye makes
  // the caller do the hanging up, which on a service call reads as being dumped — and
  // on their mobile plan it is their money. Ending it ourselves is the polite half of
  // a call we placed or answered.
  //
  // A TOOL rather than transcript matching, because a goodbye has to be recognised in
  // Telugu, Hindi, English and any mix of them, and "bye" turns up mid-conversation as
  // often as it does at the end. The model already knows when a conversation is over;
  // asking it is more reliable than pattern-matching its own words after the fact.
  decls.push({
    name: 'end_call',
    description: "Hang up. Call this ONLY when the conversation is genuinely finished — the caller has said goodbye, or said they have everything they need — AND you have said your own closing line. The call ends as soon as your last words have played, so never call it mid-conversation, never while they are still asking things, and NEVER on a turn you could not make out. If you are not sure whether they are done, do not call this: ask, and let them tell you.",
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "Briefly, why the call is over — e.g. 'caller said goodbye', 'question answered and they had nothing else'." },
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
export async function handleSendWhatsapp(tenantConfig, callerNumber, args = {}, sentKeys = null) {
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
export const NO_KNOWLEDGE = 'No matching knowledge found.'
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
export function noKnowledgeInstruction(tenantConfig = {}) {
  const names = (Array.isArray(tenantConfig.lookups) ? tenantConfig.lookups : [])
    .map(l => sanitizeName(l?.name)).filter(Boolean)

  if (names.length) {
    // Both halves are scar tissue. Without the second, a miss ended the call on a
    // question a lookup could have answered. Without the FIRST, a miss on a plain
    // question about products turned into "give me your customer ID" four times in
    // one call — the caller asked what term insurance was on offer and was asked to
    // identify themselves, which reads as evasive and is useless anyway.
    return `${NO_KNOWLEDGE} What you do next depends on what they actually asked.\n` +
      `• A GENERAL question — what products exist, prices, plans, how something works, the ` +
      `business itself: do NOT ask for a customer ID or phone number. It cannot help, and it ` +
      `sounds like you are dodging. Search ONCE more with different ENGLISH words (the product ` +
      `or company name on its own works well). If that misses too, say plainly that you don't ` +
      `have that detail to hand and offer to have the team confirm it.\n` +
      `• A question about THEIR OWN account — their policy, payment, loan, order or booking: ` +
      `that never lives in the knowledge base, it lives behind ${names.join(' or ')}. Ask for ` +
      `the one detail that tool needs — their customer ID or registered phone number — and then ` +
      `call it. Do NOT tell the caller you cannot help, and do NOT offer a callback, until you ` +
      `have actually tried it.` + NEVER_INVENT
  }

  return `${NO_KNOWLEDGE} You do NOT have this information. Tell the caller plainly that you don't ` +
    `have that detail to hand, and offer to have the team confirm it and follow up.` + NEVER_INVENT
}
