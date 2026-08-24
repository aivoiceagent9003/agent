// services/greeting.js — resolve the call's opening line.
//
// Inbound: the caller reached out, so we open by offering help
//   → "Namaste, I am Priya from Acme. How can I help you?"
// Outbound (campaigns + instant CRM calls): WE dialed them, so opening with
// "how can I help you" feels off — we made the first move. Instead we acknowledge
// why we're calling and invite them in
//   → "Hello Asha, this is Priya from Acme. I saw you reached out to us — what are
//      you looking for?"
//
// Outbound is flagged by tenantConfig.is_outbound (set by the campaign/instant
// dialers). Both greetings are tenant-overridable (greeting_message /
// outbound_greeting_message), and the outbound one supports {name} + any
// contact_fields placeholders.

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
// as verbatim text the model speaks and then mirrors, so appending here keeps the
// disclosure inside that same steer instead of stranding an English sentence at
// the top of a Hindi call.
//
// Tenant-overridable via recording_notice, and only added when recording is on.
export function recordingNotice(tenantConfig = {}) {
  if (!tenantConfig.recording_enabled) return ''
  const custom = String(tenantConfig.recording_notice || '').trim()
  return custom || 'This call is recorded for quality and training purposes.'
}

export function resolveGreeting(tenantConfig = {}) {
  const agentName = tenantConfig.agent_name || 'Priya'
  const businessName = tenantConfig.business_name || 'our company'
  const notice = recordingNotice(tenantConfig)
  // Appended, not prepended: leading with a legal sentence before saying who you
  // are makes the call feel like a robocall from the first word.
  const withNotice = (line) => (notice ? `${line} ${notice}` : line)

  if (tenantConfig.is_outbound) {
    const name = (tenantConfig.contact_name || '').trim() || 'there'
    const tpl = tenantConfig.outbound_greeting_message
      || `Hello {name}, this is ${agentName} from ${businessName}. I saw you reached out to us — what are you looking for?`
    return withNotice(fill(tpl, { name, agent_name: agentName, business_name: businessName, ...(tenantConfig.contact_fields || {}) }))
  }

  return withNotice(
    tenantConfig.greeting_message
      || `Namaste, I am ${agentName} from ${businessName}. How can I help you?`
  )
}
