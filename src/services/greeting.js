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

export function resolveGreeting(tenantConfig = {}) {
  const agentName = tenantConfig.agent_name || 'Priya'
  const businessName = tenantConfig.business_name || 'our company'

  if (tenantConfig.is_outbound) {
    const name = (tenantConfig.contact_name || '').trim() || 'there'
    const tpl = tenantConfig.outbound_greeting_message
      || `Hello {name}, this is ${agentName} from ${businessName}. I saw you reached out to us — what are you looking for?`
    return fill(tpl, { name, agent_name: agentName, business_name: businessName, ...(tenantConfig.contact_fields || {}) })
  }

  return tenantConfig.greeting_message
    || `Namaste, I am ${agentName} from ${businessName}. How can I help you?`
}
