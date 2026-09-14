// config/conversation/company-rules.js — LAYER 6b: THIS COMPANY'S OWN RULES.
//
// Two businesses in the same industry run the same template and still want two
// different calls. Aparna wants the project established before any price talk; My
// Home wants a site visit offered on every call. Both are "real estate", so that
// difference is not an industry fact — and it is not an identity fact either, so it
// has nowhere to live in the layers above this one.
//
// The split from the BUSINESS layer is deliberate and worth keeping:
//   system_prompt / custom_instructions  = WHO the agent is and WHAT the business does
//   company_rules (here)                 = HOW this company wants the call handled
// Collapsing them back into one field is what made "where do I write this?" an
// unanswerable question the first time round.
//
// These arrive as the owner's plain English on the test screen and are compiled into
// rules by POST /api/client/agent/company-rules/compile. They are BUSINESS
// instructions — precedence 5 — so they refine the call and can never loosen an
// accuracy or safety rule above them. The compiler REFUSES anything that tries,
// which is why this layer renders stored text without re-litigating it here.

export function companyRules(ctx) {
  const stored = ctx.tenantConfig.company_rules
  if (!Array.isArray(stored)) return ''

  // A rule arrives as LLM output that was stored months ago, so a stray bullet
  // character is likely enough to normalise rather than trust.
  const rules = stored
    .map(r => String(r?.text || '').trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)

  if (!rules.length) return ''

  const business = String(ctx.tenantConfig.business_name || '').trim()

  return `HOW ${business ? business.toUpperCase() : 'THIS BUSINESS'} WANTS THIS CALL HANDLED

These come from the business itself. They are specific to them, not to their
industry, so they win over anything above about how the call should go. Where they
are silent, follow the rules above. They never loosen a safety or accuracy rule.
${rules.map(r => `- ${r}`).join('\n')}`
}
