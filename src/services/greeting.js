// services/greeting.js — resolve the call's opening line.
//
// Inbound: the caller reached out, so we open by offering help
//   → "Namaste, I am Priya from Acme. How can I help you?"
// Outbound: WE dialed them, so opening with "how can I help you" feels off — we
// made the first move. Two kinds, because they are different conversations:
//   • Instant call (a CRM / form lead that just came in) — they did reach out
//     → "Hello Asha, this is Priya from Acme. I saw you reached out to us — what
//        are you looking for?"   (tenant-overridable: outbound_greeting_message)
//   • Campaign call (our outreach to a list) — the campaign's own opening line,
//     campaign_greeting, written in the campaign builder
//     → "Hello Asha, this is Priya from Acme. Do you have a minute to talk?"
//
// Outbound is flagged by tenantConfig.is_outbound (set by the campaign/instant
// dialers); a campaign call also carries campaign_id. Every outbound line supports
// {name} + any contact_fields placeholders.

import { dominantScript } from './tts-text.js'
import { toName } from './language-manager.js'
import { languagePlan, languageQuestion } from './call-language.js'

function fill(tpl, vars) {
  return String(tpl || '')
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : ''))
    .replace(/\s{2,}/g, ' ')       // collapse gaps left by an empty {placeholder}
    .replace(/\s+([,.])/g, '$1')   // "Hello ," → "Hello,"
    .trim()
}

// DPDP 2023 requires notice before personal data is collected, and a recorded
// voice call is personal data. The notice rides on the greeting rather than being
// a separate utterance so it lands in the caller's language: the greeting is sent
// as verbatim text the model speaks and then mirrors, so carrying the disclosure
// inside that same steer beats stranding an English sentence at the top of a
// Hindi call.
//
// Tenant-overridable via recording_notice, and only added when recording is on.
export function recordingNotice(tenantConfig = {}) {
  if (!tenantConfig.recording_enabled) return ''
  const custom = String(tenantConfig.recording_notice || '').trim()
  return custom || 'This call is recorded for quality and training purposes.'
}

export function resolveGreeting(tenantConfig = {}, { includeNotice = true } = {}) {
  const agentName = tenantConfig.agent_name || 'Priya'
  const businessName = tenantConfig.business_name || 'our company'
  const notice = includeNotice ? recordingNotice(tenantConfig) : ''
  // Prepended. This used to be appended, on the reasoning that opening with a
  // legal sentence makes the call feel like a robocall from the first word —
  // true, but it loses to the reason for the notice existing. Recording starts
  // when the call connects, so a caller who speaks over a greeting that ends
  // with the disclosure has already been recorded without hearing it. That is
  // not hypothetical: a caller interrupted to ask "are you recording this call?"
  // and then said, correctly, "actually, you need to tell that first."
  //
  // includeNotice:false is for callers that need the greeting TEXT without the
  // compliance sentence — language detection, which an English notice in front
  // of a Hindi greeting would skew.
  const withNotice = (line) => (notice ? `${notice} ${line}` : line)

  if (tenantConfig.is_outbound) {
    const name = (tenantConfig.contact_name || '').trim() || 'there'
    const vars = { name, agent_name: agentName, business_name: businessName, ...(tenantConfig.contact_fields || {}) }

    // A campaign call is OUR outreach — to a list the business uploaded, about
    // something the business chose. "I saw you reached out to us" is false for
    // almost everyone on that list, and it was what every campaign call opened with.
    // So a campaign speaks only its own opening line (written in the campaign
    // builder), never the lead-call one, and never a tenant-level outbound greeting.
    if (tenantConfig.campaign_id) {
      const tpl = String(tenantConfig.campaign_greeting || '').trim()
        || `Hello {name}, this is ${agentName} from ${businessName}. Do you have a minute to talk?`
      return withNotice(fill(tpl, vars))
    }

    // An instant call: a lead that just came in from the business's CRM or a form.
    // They really did reach out, so we say so.
    const tpl = tenantConfig.outbound_greeting_message
      || `Hello {name}, this is ${agentName} from ${businessName}. I saw you reached out to us — what are you looking for?`
    return withNotice(fill(tpl, vars))
  }

  return withNotice(
    tenantConfig.greeting_message
      || `Namaste, I am ${agentName} from ${businessName}. How can I help you?`
  )
}

/**
 * The language the greeting is spoken in ("English", "Telugu", …) — the model's default
 * while the caller's own language is still unclear (language-rules.js, "DEFAULT WHILE
 * YOU CANNOT TELL").
 *
 * The speech-to-speech engine passed this and the cascade that replaced it did not, so
 * the model had no default at all. On outbound that decides the first reply, because a
 * callee's first words are nearly always a bare "yes" — which the language rules rightly
 * say is not a language signal. On a real campaign call the agent greeted in English,
 * the callee said "Yes, I do have.", and with nothing to fall back on, the model answered
 * in Telugu: the language most of its examples are written in.
 *
 * Judged WITHOUT the recording notice, a fixed English sentence that would drag a Hindi
 * or Telugu greeting's verdict to English; and by majority script, so an English product
 * name inside a Telugu greeting leaves it Telugu. Romanised Hindi reads as English — the
 * script cannot tell them apart.
 */
export function greetingLanguage(tenantConfig = {}) {
  const greeting = resolveGreeting(tenantConfig, { includeNotice: false })
  return greeting.trim() ? toName(dominantScript(greeting)) : null
}

/**
 * What the agent says the moment the call connects: { line, pending }.
 *
 * English agent: the greeting, unchanged; nothing pending.
 *
 * Caller-chooses agent: the greeting's introduction, then the language question —
 *   "Hello Ravi, this is Ramya from GSK Insurance. Which language would you like to
 *    continue in?"
 * The greeting's own closing question ("Do you have a minute to talk?") is held back as
 * `pending` and asked once they have chosen, in THEIR language. Asking both at once
 * leaves the caller answering one of them and the call not knowing which.
 *
 * The recording notice still comes first — see resolveGreeting.
 */
export function openingForCall(tenantConfig = {}) {
  const plan = languagePlan(tenantConfig)
  if (plan.mode !== 'caller_choice') return { line: resolveGreeting(tenantConfig), pending: null }

  const greeting = resolveGreeting(tenantConfig, { includeNotice: false })
  const sentences = greeting.split(/(?<=[.!?।])\s+/).filter(Boolean)
  let intro = greeting
  let pending = null
  if (sentences.length > 1 && /\?\s*$/.test(sentences.at(-1))) {
    pending = sentences.at(-1).trim()
    intro = sentences.slice(0, -1).join(' ')
  }
  const line = [recordingNotice(tenantConfig), intro, languageQuestion()].filter(Boolean).join(' ')
  return { line, pending }
}
