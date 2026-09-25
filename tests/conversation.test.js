// The Conversation Intelligence Framework: layer composition, gating, and state.
//
// Before this suite the prompt had NO test coverage of any kind, which is how a
// real-estate rule ended up in every tenant's instructions for months without
// anything going red.
//
// These tests assert on STRUCTURE and GATING, not wording — layer order, which
// layers render for which configuration, and what the deterministic state machine
// concludes. That way rewording a rule to make it clearer does not break the suite,
// but deleting a safety layer or leaking one sector's vocabulary into another does.

import { describe, it, expect } from 'vitest'
import {
  buildContext,
  buildAgentPrompt,
  renderLayers,
  describeLayers,
  ConversationState,
  AGENT_TEMPLATES,
  getAgentTemplate,
  allOutcomeCodes,
} from '../src/config/conversation/index.js'
import { TEMPLATES, getTemplate } from '../src/api/templates.js'

const names = (ctx) => renderLayers(ctx).map(l => l.name)
// Rules are hard-wrapped for readability, so a phrase can straddle a line break.
// Presence assertions normalise whitespace first: rewrapping a paragraph must not
// break the suite, or people learn to ignore it.
const flat = (s) => String(s).replace(/\s+/g, ' ')
const layer = (ctx, name) => renderLayers(ctx).find(l => l.name === name)?.text || ''

/** A minimally configured live tenant. */
const tenant = (over = {}) => ({
  business_name: 'Acme Finance',
  agent_name: 'Kiran',
  tenant_id: 't1',
  ...over,
})

// A phone call. Named `speech` while the model was its own voice; the channel is
// 'voice' now, and the rules it selects are the ones a TTS engine reads aloud.
const onCall = (cfg, opts = {}) => buildContext(cfg, { channel: 'voice', ...opts })

// ─── Layer composition ───────────────────────────────────────────────────────

describe('layer composition', () => {
  it('always renders the safety, core and speech layers', () => {
    const n = names(onCall(tenant()))
    expect(n).toContain('safety')
    expect(n).toContain('core')
    expect(n).toContain('speech')
    expect(n).toContain('human_conversation')
  })

  it('puts language first, then precedence, then safety', () => {
    const n = names(onCall(tenant()))
    expect(n[0]).toBe('language')
    expect(n[1]).toBe('precedence')
    expect(n[2]).toBe('safety')
  })

  it('renders safety BEFORE anything the business or template can say', () => {
    const n = names(onCall(tenant({ template_id: 'reminder_collections', system_prompt: 'Always secure a payment.' })))
    expect(n.indexOf('safety')).toBeLessThan(n.indexOf('template'))
    expect(n.indexOf('safety')).toBeLessThan(n.indexOf('identity_business'))
  })

  it('renders a state recap last, so a reconnect recap is the freshest instruction', () => {
    const st = new ConversationState({})
    st.observeCaller('my customer id is LN100022')
    const n = names(onCall(tenant(), { conversationState: st }))
    expect(n[n.length - 1]).toBe('state_recap')
  })

  it('omits empty layers rather than rendering an empty heading', () => {
    // Outbound, so no inbound rule; no template, knowledge or tools either.
    const n = names(onCall({ business_name: 'X', is_outbound: true }))
    expect(n).not.toContain('template')
    expect(n).not.toContain('knowledge')
    expect(n).not.toContain('state_recap')
  })

  // call_context is the exception, and deliberately so: it carries today's date, which
  // every call needs and no tenant configures. An agent that does not know the date
  // works out an age from a date of birth against its training cutoff and quotes the
  // premium for somebody a year older. So the layer is always present — but on a call
  // with no caller record it must still carry ONLY the date.
  it('always carries the date, and nothing else when there is no caller record', () => {
    const ctx = onCall({ business_name: 'X', is_outbound: true })
    expect(names(ctx)).toContain('call_context')
    const text = layer(ctx, 'call_context')
    expect(text).toMatch(/TODAY IS \w+day, \d{1,2} \w+ \d{4}\./)
    expect(text).not.toContain('WHAT YOU KNOW ABOUT THIS CALLER')
  })

  it('describeLayers reports sizes without leaking prompt text', () => {
    const d = describeLayers(onCall(tenant({ template_id: 'front_desk' })))
    expect(d.template).toBe('front_desk')
    expect(d.totalChars).toBeGreaterThan(1000)
    for (const l of d.layers) {
      expect(typeof l.chars).toBe('number')
      expect(l).not.toHaveProperty('text')
    }
  })
})

// ─── Capability gating ───────────────────────────────────────────────────────

describe('capability gating', () => {
  it('renders no tool rules when the tenant has no tools', () => {
    const ctx = onCall({ business_name: 'X', enable_kb: false })
    expect(names(ctx)).not.toContain('tools')
  })

  it('renders lookup guidance only when lookups are configured', () => {
    const without = layer(onCall(tenant({ enable_kb: false })), 'tools')
    expect(without).toBe('')

    const with_ = layer(onCall(tenant({ lookups: [{ name: 'loan_status' }] })), 'tools')
    expect(with_).toMatch(/identifier/i)
  })

  it('does not tell an agent to search a knowledge base it does not have', () => {
    const ctx = onCall(tenant({ enable_kb: false, lookups: [{ name: 'loan_status' }] }))
    expect(layer(ctx, 'tools')).not.toMatch(/knowledge base/i)
  })

  it('tells an agent with no handoff number never to promise a transfer', () => {
    const ctx = onCall(tenant())            // no handoff_number
    const esc = layer(ctx, 'escalation')
    expect(esc).toMatch(/no one to transfer/i)
    expect(esc).not.toContain('[HANDOFF]')
  })

  it('gives the handoff marker only when a handoff number exists', () => {
    const ctx = onCall(tenant({ handoff_number: '+919999999999' }))
    expect(layer(ctx, 'escalation')).toContain('[HANDOFF]')
  })

  it('adds the template-specific escalation triggers to the universal ones', () => {
    const ctx = onCall(tenant({ handoff_number: '+91', template_id: 'reminder_collections' }))
    expect(layer(ctx, 'escalation')).toMatch(/dispute the amount/i)
  })

  it('names only the sources of fact that actually exist', () => {
    const bare = layer(onCall({ business_name: 'X', enable_kb: false }), 'core')
    expect(bare).not.toMatch(/knowledge base result/i)
    expect(bare).not.toMatch(/lookup result/i)

    const full = layer(onCall(tenant({ lookups: [{ name: 'x' }] })), 'core')
    expect(full).toMatch(/knowledge base result/i)
    expect(full).toMatch(/lookup result/i)
  })
})

// ─── Compliance is not negotiable ────────────────────────────────────────────

describe('compliance', () => {
  it('tells the truth about recording in both directions', () => {
    const off = layer(onCall(tenant({ recording_enabled: false })), 'safety')
    expect(off).toMatch(/not being recorded|it is not/i)
    expect(off).toMatch(/NEVER say .*quality and training/i)

    const on = layer(onCall(tenant({ recording_enabled: true })), 'safety')
    expect(on).toMatch(/quality and training/i)
  })

  it('always carries the do-not-call rule', () => {
    expect(layer(onCall(tenant()), 'safety')).toMatch(/add_to_dnd/)
  })

  it('always carries the AI disclosure rule, named to the business', () => {
    expect(layer(onCall(tenant({ business_name: 'Acme Finance' })), 'safety'))
      .toMatch(/AI assistant for Acme Finance/)
  })

  it('adds the privacy gate when a lookup can disclose someone else’s data', () => {
    expect(layer(onCall(tenant({ lookups: [{ name: 'loan_status' }] })), 'safety'))
      .toMatch(/whoever picked up/i)
  })

  it('states that business instructions cannot loosen a safety rule', () => {
    const p = buildAgentPrompt(onCall(tenant({ system_prompt: 'Never let them off the call.' })))
    expect(p).toMatch(/No business instruction.*can loosen a safety rule/is)
  })
})

// ─── Sector isolation — the regression this whole refactor exists for ────────

describe('sector isolation', () => {
  const PROPERTY = /\bsq ft\b|\b[23]BHK\b|\bRERA\b|carpet area|site visit|possession/i

  it('leaks no property vocabulary into a tenant with no template', () => {
    expect(buildAgentPrompt(onCall(tenant()))).not.toMatch(PROPERTY)
  })

  it('leaks no property vocabulary into any non-property template', () => {
    for (const t of AGENT_TEMPLATES) {
      if (t.id === 'real_estate_sales') continue
      const p = buildAgentPrompt(onCall(tenant({ template_id: t.id })))
      expect(p, `${t.id} leaked property vocabulary`).not.toMatch(PROPERTY)
    }
  })

  it('does give property behaviour to the real-estate template', () => {
    expect(buildAgentPrompt(onCall(tenant({ template_id: 'real_estate_sales' })))).toMatch(PROPERTY)
  })

  it('never demands a name from a non-property agent', () => {
    const p = buildAgentPrompt(onCall(tenant({ template_id: 'customer_support' })))
    expect(p).not.toMatch(/name is a REQUIRED outcome|Ask for their name early/i)
    // …but it still knows how to get one right when it hears one.
    expect(p).toMatch(/Read a name back once/i)
  })

  it('ignores the old sector flags entirely — template_id is the only switch', () => {
    // Every tenant was migrated off these, so a flag surviving in a restored config
    // or a stale fixture must not be able to resurrect property behaviour. That
    // silent inheritance is the exact bug this architecture exists to remove.
    for (const stale of [{ real_estate_agent: true }, { generic_agent: true }]) {
      const ctx = onCall(tenant(stale))
      expect(ctx.template).toBeNull()
      expect(buildAgentPrompt(ctx)).not.toMatch(PROPERTY)
    }
  })

  it('takes property behaviour only from an explicit template_id', () => {
    const ctx = onCall(tenant({ template_id: 'real_estate_sales' }))
    expect(ctx.template?.id).toBe('real_estate_sales')
    expect(buildAgentPrompt(ctx)).toMatch(PROPERTY)
  })
})

// ─── Company rules ───────────────────────────────────────────────────────────
// Two firms in one industry, one template, two different calls. These assert the
// layer renders, is gated on real content, and lands where its authority says it
// should — never that a particular rule is worded a particular way.

describe('company rules', () => {
  const withRules = (rules, over = {}) =>
    onCall(tenant({ template_id: 'real_estate_sales', company_rules: rules, ...over }))

  const RULE = 'Ask which project they are calling about before discussing price.'

  it('renders the rule the company wrote', () => {
    expect(flat(layer(withRules([{ id: 'a', text: RULE }]), 'company_rules'))).toContain(RULE)
  })

  it('sits directly after the template it refines', () => {
    const n = names(withRules([{ id: 'a', text: RULE }]))
    expect(n[n.indexOf('template') + 1]).toBe('company_rules')
  })

  it('stays below the safety and core layers that outrank it', () => {
    const n = names(withRules([{ id: 'a', text: RULE }]))
    expect(n.indexOf('safety')).toBeLessThan(n.indexOf('company_rules'))
    expect(n.indexOf('core')).toBeLessThan(n.indexOf('company_rules'))
  })

  it('does not render at all without rules', () => {
    for (const empty of [undefined, [], null, 'not an array']) {
      expect(names(withRules(empty))).not.toContain('company_rules')
    }
  })

  it('ignores blank and malformed entries rather than rendering a naked bullet', () => {
    const n = names(withRules([{ id: 'a', text: '   ' }, { id: 'b' }, {}]))
    expect(n).not.toContain('company_rules')
  })

  it('strips a bullet the compiler left on, so it never doubles up', () => {
    const text = layer(withRules([{ id: 'a', text: `- ${RULE}` }]), 'company_rules')
    expect(text).not.toMatch(/-\s+-\s/)
    expect(flat(text)).toContain(`- ${RULE}`)
  })

  it('keeps one company\'s rules out of another company\'s prompt', () => {
    const aparna = buildAgentPrompt(withRules([{ id: 'a', text: RULE }]))
    const myHome = buildAgentPrompt(withRules([{ id: 'b', text: 'Offer a site visit on every call.' }]))
    expect(aparna).toContain(RULE)
    expect(myHome).not.toContain(RULE)
  })

  it('reaches the composed prompt on a tenant with no template at all', () => {
    const p = buildAgentPrompt(onCall(tenant({ company_rules: [{ id: 'a', text: RULE }] })))
    expect(p).toContain(RULE)
  })
})

// ─── Call context ────────────────────────────────────────────────────────────

describe('call context', () => {
  it('adds the inbound rule only on an inbound call', () => {
    expect(layer(onCall(tenant()), 'call_context')).toMatch(/INBOUND/)
    expect(layer(onCall(tenant({ is_outbound: true })), 'call_context')).not.toMatch(/INBOUND/)
  })

  it('injects the caller record and closes the set', () => {
    const ctx = onCall(tenant({ is_outbound: true, contact_name: 'Ravi', contact_fields: { policy_no: 'LN100022', due: '2026-10-01' } }))
    const t = layer(ctx, 'call_context')
    expect(t).toContain('Ravi')
    expect(t).toContain('LN100022')
    expect(t).toMatch(/COMPLETE set of caller-specific details/i)
  })

  it('bounds a very wide contact row', () => {
    const fields = {}
    for (let i = 0; i < 80; i++) fields[`f${i}`] = 'x'.repeat(500)
    const t = layer(onCall(tenant({ is_outbound: true, contact_fields: fields })), 'call_context')
    expect(t.split('\n').filter(l => l.startsWith('- ')).length).toBeLessThanOrEqual(30)
    expect(t).not.toContain('x'.repeat(300))
  })

  it('stringifies nested values instead of printing [object Object]', () => {
    const t = layer(onCall(tenant({ is_outbound: true, contact_fields: { plan: { tier: 'gold' } } })), 'call_context')
    expect(t).not.toContain('[object Object]')
    expect(t).toContain('gold')
  })

  it('skips empty and null fields', () => {
    const t = layer(onCall(tenant({ is_outbound: true, contact_fields: { a: '', b: null, c: 'kept' } })), 'call_context')
    expect(t).toContain('kept')
    expect(t).not.toMatch(/^- a:/m)
    expect(t).not.toMatch(/^- b:/m)
  })
})

// ─── Respect and delivery ────────────────────────────────────────────────────
// Both of these came back from a live call: the agent called the customer "Manoj"
// with no honorific in the middle of a Telugu sentence, and rushed the opening line
// past a caller who had only just picked up.

describe('addressing the caller with respect', () => {
  const t = () => flat(layer(onCall(tenant()), 'speech'))

  it('requires a respect marker on the name in Telugu and Hindi', () => {
    expect(t()).toMatch(/Manoj garu/)
    expect(t()).toMatch(/Manoj ji/)
    expect(t()).toMatch(/EVERY time you use the name/i)
  })

  it('forbids the bare first name, which is what actually went wrong', () => {
    expect(t()).toMatch(/NEVER address a customer by their bare first name/i)
  })

  it('no longer bans "garu" — it is the correct Telugu form, not a mistake', () => {
    expect(t()).not.toMatch(/Never (use )?"?garu/i)
  })

  it('keeps the honorific gender-neutral, which was the original reason for the rule', () => {
    expect(t()).toMatch(/Never "sir" or "madam"/)
    expect(t()).toMatch(/gender-neutral/i)
  })

  it('demands one form for the whole call, not a mix', () => {
    expect(t()).toMatch(/keep it for the whole call/i)
  })

  it('leaves English alone — a bare name is correct there', () => {
    expect(t()).toMatch(/In English, no marker/)
  })
})

describe('mirroring the caller, whatever language they use', () => {
  const t = () => flat(layer(onCall(tenant({ agent_name: 'Aruna', business_name: 'GSK insurance' })), 'language'))

  it('says the caller is the ONLY thing that picks the language', () => {
    expect(t()).toMatch(/THE CALLER'S LANGUAGE IS THE ONLY THING THAT DECIDES THIS/)
  })

  it('rules out the things that were actually biasing it', () => {
    // A Telugu agent name, a Hyderabad business and Telugu-flavoured reference
    // material had the agent answering a Hindi caller in Telugu for a whole call.
    const x = t()
    expect(x).toMatch(/your own name, or what language it sounds like/i)
    expect(x).toMatch(/the city or state it operates in/i)
    expect(x).toMatch(/the language most of this business's customers happen to speak/i)
    expect(x).toMatch(/the language you happened to use a moment ago/i)
  })

  it('tells the agent to re-check and switch mid-call', () => {
    expect(t()).toMatch(/CHECK YOURSELF EVERY TURN/)
    expect(t()).toMatch(/never too late in a call to start speaking their language/i)
  })

  it('names no single language as the wrong fallback', () => {
    // The old rule said "never fall back to Hindi", which pushed a Telugu-leaning
    // model further from a Hindi caller — the opposite of what was needed.
    expect(t()).not.toMatch(/never fall back to Hindi/i)
    expect(t()).toMatch(/Never pick a language neither of you has used/i)
  })

  it('gives Telugu and Hindi equal weight in the whole prompt', () => {
    // Not cosmetic: the examples are what the model pattern-matches against.
    const p = buildAgentPrompt(onCall(tenant()))
    const te = (p.match(/Telugu/g) || []).length
    const hi = (p.match(/Hindi/g) || []).length
    expect(Math.abs(te - hi), 'Telugu ' + te + ' vs Hindi ' + hi).toBeLessThanOrEqual(1)
  })

  it('holds the CALLER language through an unintelligible turn, not its own', () => {
    expect(t()).toMatch(/hold the language the caller has been\s+using/i)
  })
})

describe('not asking "anything else?" after every answer', () => {
  const t = () => flat(layer(onCall(tenant()), 'human_conversation'))

  it('names the phrase family outright', () => {
    // The abstract version of this rule was ignored through seven turns, because the
    // model does not recognise "Inka emaina kavala?" as the thing being described.
    expect(t()).toMatch(/NEVER ASK "ANYTHING ELSE\?"/)
    expect(t()).toMatch(/is there anything else/i)
    expect(t()).toMatch(/what else can I help with/i)
  })

  it('covers it in any language, translated or code-mixed', () => {
    expect(t()).toMatch(/in any language/i)
    expect(t()).toMatch(/translated or\s+code-mixed/i)
  })

  it('says what to do instead', () => {
    expect(t()).toMatch(/Do not abandon an unfinished decision after a fact/)
    expect(t()).toMatch(/specific question/)
  })

  it('distinguishes a factual answer from an unfinished buying decision', () => {
    expect(t()).toMatch(/A direct factual question can end with its answer/)
    expect(t()).toMatch(/An unfinished buying decision needs guidance/)
  })
})

describe('saying an identifier and looking it up', () => {
  const t = () => flat(layer(onCall(tenant()), 'speech'))

  it('requires the spoken value and the searched value to be identical', () => {
    // The caller gave LN100077, the agent said it back correctly, and searched
    // LN1000077. One extra zero nobody could hear, and a real customer was told
    // twice that they did not exist.
    expect(t()).toMatch(/WHAT YOU SAY AND WHAT YOU LOOK UP MUST BE THE SAME VALUE/)
    expect(t()).toMatch(/not from your memory of what you heard/i)
  })

  it('forbids tidying a character out of an identifier', () => {
    expect(t()).toMatch(/Never add, drop or "tidy" a character/i)
    expect(t()).toMatch(/Leading zeros, repeated digits/i)
  })

  it('still bans the grouping that hid the error', () => {
    expect(t()).toMatch(/Never compress a run into "double", "triple"/i)
  })
})

describe('reading a figure off a record', () => {
  const t = () => flat(layer(onCall(tenant()), 'speech'))

  it('demands the exact digits, decimals included', () => {
    // The record said 14.07 and the agent said "fourteen point zero four". On a loan
    // that is a different contract.
    expect(t()).toMatch(/READ EXACTLY AS IT IS WRITTEN/)
    expect(t()).toMatch(/including the ones after the decimal point/i)
    expect(t()).toMatch(/Do not round it/i)
  })

  it('tells it not to argue when corrected', () => {
    expect(t()).toMatch(/do not argue and do not repeat your\s+version/i)
  })
})

describe('ending the call', () => {
  const t = () => flat(layer(onCall(tenant()), 'speech'))

  it('tells the agent to hang up rather than wait to be hung up on', () => {
    expect(t()).toMatch(/Then HANG UP/)
    expect(t()).toMatch(/call end_call/)
  })

  it('explains why, so the rule survives a rewrite', () => {
    expect(t()).toMatch(/costs them their own airtime/i)
  })

  it('forbids announcing the hangup', () => {
    expect(t()).toMatch(/Do not announce it/i)
  })

  it('keeps the guard against ending on speech you did not understand', () => {
    expect(t()).toMatch(/NEVER treat speech you could not make out as a goodbye/i)
    expect(t()).toMatch(/on a turn you could not make out/i)
  })

  it('is the same rule for every template — no agent opts out of hanging up', () => {
    for (const tpl of AGENT_TEMPLATES) {
      const s = flat(layer(onCall(tenant({ template_id: tpl.id })), 'speech'))
      expect(s, tpl.id).toMatch(/Then HANG UP/)
    }
  })
})

describe('delivery pace', () => {
  const t = () => flat(layer(onCall(tenant()), 'speech'))

  it('tells the agent to slow the opening line down', () => {
    expect(t()).toMatch(/SAY YOUR OPENING LINE SLOWLY/)
    expect(t()).toMatch(/beat after the greeting word/i)
  })

  it('slows down for anything the caller has to remember', () => {
    expect(t()).toMatch(/amount, a date, a reference number/i)
  })

  it('does not slow the whole call down', () => {
    expect(t()).toMatch(/Ordinary conversation runs at ordinary speed/i)
  })
})

// ─── Channel differences ─────────────────────────────────────────────────────

describe('channel', () => {
  it('gives the say-it-exactly rules to a phone call and not to text', () => {
    expect(layer(onCall(tenant()), 'speech')).toMatch(/CHARACTER BY CHARACTER/)
    expect(layer(buildContext(tenant(), { channel: 'text' }), 'speech')).not.toMatch(/CHARACTER BY CHARACTER/)
  })

  it('never tells the model to spell figures out as words', () => {
    // It used to, on the channel where the model was its own voice. A TTS engine reads
    // what the model writes now and tts-text.js does the spelling-out, so this
    // instruction would contradict the digits rule sitting right below it — which on a
    // real call produced "seven thousand five vandalaku" and a premium heard as 101%.
    // (The positive instruction — write digits — lives in VOICE_OUTPUT_RULES next to
    // the engine that needs it. What matters here is that the contradiction is gone.)
    const rules = layer(onCall(tenant()), 'speech')
    expect(rules).not.toMatch(/as ENGLISH words/)
    expect(rules).not.toMatch(/three point five crore/)
    expect(rules).toMatch(/SAYING NUMBERS AND IDENTIFIERS OUT LOUD/)
  })

  it('treats an unknown channel as text rather than as a phone call', () => {
    // 'speech' was a real channel while Gemini Live was. Anything still passing it
    // should get the conservative answer, not phone-call rules by accident.
    expect(names(buildContext(tenant(), { channel: 'speech' })))
      .toEqual(names(buildContext(tenant(), { channel: 'text' })))
  })

  it('renders the recognition vocabulary only on a live call', () => {
    const cfg = tenant({ kb_keyterms: ['Kokapet', 'Gachibowli'] })
    expect(layer(onCall(cfg), 'identity_business')).toContain('Kokapet')
    expect(layer(buildContext(cfg, { channel: 'text' }), 'identity_business')).not.toContain('Kokapet')
  })

  it('inlines retrieved knowledge as its own layer, above the tool rules', () => {
    const ctx = buildContext(tenant({ lookups: [{ name: 'x' }] }), { knowledge: 'Premium is 4500 a year.' })
    const n = names(ctx)
    expect(layer(ctx, 'knowledge')).toContain('Premium is 4500')
    expect(n.indexOf('knowledge')).toBeLessThan(n.indexOf('tools'))
  })
})

// ─── Language ────────────────────────────────────────────────────────────────

describe('language', () => {
  it('hands the model ownership by default', () => {
    expect(layer(onCall(tenant()), 'language')).toMatch(/YOU OWN THE CONVERSATION LANGUAGE/)
  })

  it('hands the application ownership when the manager is driving', () => {
    const t = flat(layer(onCall(tenant(), { language: { modelLed: false } }), 'language'))
    expect(t).toMatch(/THE APPLICATION OWNS THE CONVERSATION LANGUAGE/)
    expect(t).toMatch(/LANGUAGE CONTROL directive/)
  })

  it('treats code-mixing as normal in both modes', () => {
    for (const modelLed of [true, false]) {
      const t = layer(onCall(tenant(), { language: { modelLed } }), 'language')
      expect(t).toMatch(/CODE-MIXING IS NORMAL/i)
      expect(t).toMatch(/Tinglish|Hinglish/i)
    }
  })

  it('uses the greeting language only as a fallback, and drops it once locked', () => {
    const opening = layer(onCall(tenant(), { language: { opening: 'Telugu' } }), 'language')
    expect(opening).toMatch(/DEFAULT WHILE YOU CANNOT TELL/)

    const locked = layer(onCall(tenant(), { language: { opening: 'Telugu', locked: 'Hindi' } }), 'language')
    expect(locked).toMatch(/CURRENT CONVERSATION LANGUAGE: Hindi/)
    expect(locked).not.toMatch(/DEFAULT WHILE YOU CANNOT TELL/)
  })
})

// ─── Template library ────────────────────────────────────────────────────────

describe('template library', () => {
  it('ships all eleven templates', () => {
    expect(AGENT_TEMPLATES).toHaveLength(11)
  })

  it('keeps every id that a tenant may already have stored', () => {
    const legacy = ['real_estate_sales', 'lead_qualification', 'customer_support',
      'front_desk', 'reminder_collections', 'order_confirmation']
    for (const id of legacy) expect(getAgentTemplate(id), id).toBeTruthy()
  })

  it('gives every template the full structure', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.role, t.id).toBeTruthy()
      expect(t.conversationStrategy, t.id).toBeTruthy()
      expect(t.primaryGoals?.length, t.id).toBeGreaterThan(0)
      expect(t.informationPriorities?.length, t.id).toBeGreaterThan(0)
      expect(Object.keys(t.successOutcomes || {}).length, t.id).toBeGreaterThan(2)
      expect(t.prohibitedBehavior?.length, t.id).toBeGreaterThan(0)
    }
  })

  it('explains WHY every piece of information is worth collecting', () => {
    // Without the why, an information priority is just a form field, which is the
    // interrogation failure mode this architecture exists to prevent.
    for (const t of AGENT_TEMPLATES) {
      for (const p of t.informationPriorities) {
        expect(p.why, `${t.id}/${p.field}`).toBeTruthy()
        expect(p.why.length, `${t.id}/${p.field}`).toBeGreaterThan(15)
      }
    }
  })

  it('never restates a universal rule inside a template', () => {
    // A template that repeats the universal rules is how they drift out of sync.
    const UNIVERSAL = [
      /under (about )?twelve words/i,
      /no markdown/i,
      /add_to_dnd/,
      /\[HANDOFF\]/,
      /are you a (human|robot|bot)/i,
      /gender-neutral honorific/i,
    ]
    for (const t of AGENT_TEMPLATES) {
      const text = [t.templateInstructions, ...(t.prohibitedBehavior || [])].join('\n')
      for (const re of UNIVERSAL) expect(text, `${t.id} restates ${re}`).not.toMatch(re)
    }
  })

  it('never scripts a call as numbered steps', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.templateInstructions || '', t.id).not.toMatch(/^\s*\d[).]\s/m)
      expect(t.conversationStrategy, t.id).not.toMatch(/step \d/i)
    }
  })

  it('tells the model the strategy is not an order of operations', () => {
    const p = buildAgentPrompt(onCall(tenant({ template_id: 'customer_support' })))
    expect(p).toMatch(/not an order of operations/i)
  })

  it('treats every listed outcome as a legitimate ending', () => {
    const p = buildAgentPrompt(onCall(tenant({ template_id: 'outbound_sales' })))
    expect(p).toMatch(/all of them legitimate/i)
    expect(p).toMatch(/Do not keep a caller on the line/i)
  })

  it('registers every outcome code exactly once', () => {
    const codes = allOutcomeCodes()
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toContain('PAYMENT_COMMITMENT')
    expect(codes).toContain('SITE_VISIT_BOOKED')
    expect(codes).toContain('SURVEY_DECLINED')
  })
})

// ─── The API shape the UI depends on ─────────────────────────────────────────

describe('templates API', () => {
  it('seeds no config key that nothing reads', () => {
    // Each of these belonged to architecture that has been removed. A dead key in a
    // tenant's config is worse than no key: it looks live, so the next person to work
    // on that area reasons about behaviour that cannot happen.
    const DEAD = ['generic_agent', 'real_estate_agent', 'use_sarvam_stt',
      'translate_replies', 'language_hint', 'primary_language', 'filler_phrases']
    for (const t of TEMPLATES) {
      for (const k of DEAD) expect(Object.keys(t.config), `${t.id} seeds ${k}`).not.toContain(k)
    }
  })

  it('exposes all eleven with the fields the picker renders', () => {
    expect(TEMPLATES).toHaveLength(11)
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy()
      expect(t.label).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.icon).toBeTruthy()
      expect(Array.isArray(t.suggested_kb_topics)).toBe(true)
    }
  })

  it('stores a template id, not a copied prompt', () => {
    const t = getTemplate('policy_renewal')
    expect(t.config.template_id).toBe('policy_renewal')
    expect(t.config.system_prompt).toBe('')
  })

  it('round-trips a stored config back into the right template', () => {
    for (const t of TEMPLATES) {
      expect(buildContext(t.config).template?.id, t.id).toBe(t.id)
    }
  })

  it('surfaces the behaviour so a client can see it before choosing', () => {
    const t = getTemplate('reminder_collections')
    expect(t.goals.length).toBeGreaterThan(0)
    expect(t.collects.length).toBeGreaterThan(0)
    expect(t.outcomes).toContain('PAYMENT_COMMITMENT')
    expect(t.never.join(' ')).toMatch(/threaten/i)
  })
})

// ─── Conversation state ──────────────────────────────────────────────────────

describe('conversation state', () => {
  const st = (over = {}) => new ConversationState({ callSid: 'c1', ...over })

  it('starts empty and produces no recap', () => {
    expect(st().summaryForModel()).toBe('')
  })

  it('seeds what we already knew before the call', () => {
    const s = st({ tenantConfig: { contact_name: 'Ravi' } })
    s.observeCaller('hello')
    expect(s.summaryForModel()).toContain('Ravi')
  })

  // 3. Caller provides information before being asked.
  it('remembers an identifier the caller volunteered', () => {
    const s = st()
    s.observeCaller('my customer id is LN100022, I want to check something')
    expect(s.snapshot().identifiers).toContain('LN100022')
    expect(s.summaryForModel()).toMatch(/LN100022.*Do not ask again/s)
  })

  // 13. Information already provided is not asked again.
  it('detects a repeated question even when it is reworded', () => {
    const s = st()
    expect(s.observeAgent('Can I have your customer ID?').repeatedQuestion).toBeNull()
    expect(s.observeAgent('Could you give me your customer ID please?').repeatedQuestion).toBeTruthy()
    expect(s.snapshot().repeatedQuestions).toBe(1)
  })

  it('does not flag two genuinely different questions', () => {
    const s = st()
    s.observeAgent('Can I have your customer ID?')
    expect(s.observeAgent('Which date works better for you?').repeatedQuestion).toBeNull()
    expect(s.snapshot().repeatedQuestions).toBe(0)
  })

  it('detects the same offer made twice, in different words', () => {
    const s = st()
    expect(s.observeAgent('Shall I send it on WhatsApp?').repeatedOffer).toBeNull()
    expect(s.observeAgent('I can send you the details over WhatsApp.').repeatedOffer).toBe('whatsapp')
  })

  it('does not flag two different offers', () => {
    const s = st()
    s.observeAgent('Shall I send it on WhatsApp?')
    expect(s.observeAgent('Would you like to book a site visit?').repeatedOffer).toBeNull()
  })

  // 4. Caller is busy.
  it('picks up a busy caller and shortens the resumed call', () => {
    const s = st()
    s.observeCaller('I am driving right now, make it quick')
    expect(s.snapshot().cues).toContain('busy')
    expect(s.summaryForModel()).toMatch(/Keep every reply short/)
    expect(s.outcome()).toBe('CALLBACK_REQUESTED')
  })

  // 5. Caller is frustrated.
  it('picks up a frustrated caller', () => {
    const s = st()
    s.observeCaller('this is the third time I am calling, it is ridiculous')
    expect(s.snapshot().cues).toContain('frustrated')
    expect(s.summaryForModel()).toMatch(/do not be cheerful/i)
  })

  // 11 / 12. Not interested, and asking for a human.
  it('derives NOT_INTERESTED and ESCALATED from unambiguous cues', () => {
    const a = st(); a.observeCaller('I am not interested, thanks')
    expect(a.outcome()).toBe('NOT_INTERESTED')

    const b = st(); b.observeCaller('can I speak to a human please')
    expect(b.outcome()).toBe('ESCALATED')

    const c = st(); c.observeCaller('stop calling me')
    expect(c.outcome()).toBe('NOT_INTERESTED')
  })

  it('escalates when the agent emits the handoff marker', () => {
    const s = st()
    s.observeAgent('Let me put you through to the team. [HANDOFF]')
    expect(s.outcome()).toBe('ESCALATED')
  })

  it('claims no outcome when the signal is ambiguous', () => {
    const s = st()
    s.observeCaller('hmm, let me think about it')
    expect(s.outcome()).toBeNull()
  })

  it('notes that the caller says it is already done', () => {
    const s = st()
    s.observeCaller('I already paid it last week')
    expect(s.summaryForModel()).toMatch(/already done. Do not chase/i)
  })

  // 2. Caller interrupts.
  it('counts interruptions', () => {
    const s = st()
    s.observeInterruption(); s.observeInterruption()
    expect(s.snapshot().interruptions).toBe(2)
  })

  // 8. Tool call fails.
  it('counts tool failures separately from misses', () => {
    const s = st()
    s.observeCaller('what is my balance')
    s.observeTool('loan_status', { ok: false })
    s.observeTool('search_knowledge', { ok: true, hit: false })
    const snap = s.snapshot()
    expect(snap.toolFailures).toBe(1)
    expect(snap.toolsUsed).toEqual(['loan_status', 'search_knowledge'])
    expect(snap.unresolved).toContain('what is my balance')
  })

  it('carries an unanswered question into the resumed call', () => {
    const s = st()
    s.observeCaller('when does my policy expire')
    s.observeTool('search_knowledge', { ok: true, hit: false })
    expect(s.summaryForModel()).toContain('when does my policy expire')
  })

  it('tells a reconnected session not to greet or start over', () => {
    const s = st()
    s.observeCaller('my number is 9876543210')
    expect(s.summaryForModel()).toMatch(/Do NOT greet again/i)
  })

  it('remembers what a lookup was called with', () => {
    const s = st()
    s.remember('customer_id', 'LN100022')
    expect(s.summaryForModel()).toMatch(/customer id: LN100022/)
  })

  it('ignores empty values rather than remembering a blank', () => {
    const s = st()
    s.observeCaller('hi')
    s.remember('policy_no', '')
    s.remember('', 'x')
    expect(s.snapshot().known).toEqual({})
  })

  it('bounds the caller turns it holds on to', () => {
    const s = st()
    for (let i = 0; i < 40; i++) s.observeCaller(`turn number ${i}`)
    expect(s.callerTurns.length).toBeLessThanOrEqual(8)
    expect(s.snapshot().turns).toBe(40)
  })
})

// ─── Behaviours the scenarios in the brief depend on ─────────────────────────
// Each of these is a rule whose absence caused a reported production failure. They
// assert the rule is REACHABLE in a composed prompt, not how it is worded.

describe('conversation behaviours reach the prompt', () => {
  const p = buildAgentPrompt(onCall(tenant({
    template_id: 'policy_renewal',
    handoff_number: '+91',
    lookups: [{ name: 'policy_status' }],
  })))

  const flatP = flat(p)
  const has = (re, what) => it(what, () => expect(flatP).toMatch(re))

  // 1. Caller changes topic suddenly.
  has(/If they raise something that matters to them, go there/i, 'follows the caller off-topic')
  // 2. Caller interrupts.
  has(/WHEN THE CALLER INTERRUPTS/i, 'stops and answers the interruption')
  has(/Never say that they interrupted you/i, 'never mentions the interruption')
  // 6. Caller asks a question during an objective.
  has(/deal with THAT first/i, 'answers what was said before asking anything')
  has(/Their question is the job/i, 'puts the question above the objective')
  // 7. Agent lacks the information.
  has(/you do NOT have it/i, 'admits a missing fact')
  has(/confident wrong number is far worse/i, 'prefers admitting to inventing')
  // 9 / 10. Language switching and code mixing.
  has(/change with them, immediately and silently/i, 'follows a language change')
  has(/do not flip your whole reply to English/i, 'holds the base language through code-mixing')
  // Repeat suppression.
  has(/never ask for it a second time/i, 'never re-asks')
  has(/at most once per topic/i, 'offers once')
  // Length.
  has(/simple question gets a short answer/i, 'matches reply length to the question')
  has(/Finding a record is not permission to read it out/i, 'does not dump a record')
  // Adaptation.
  has(/Never name what you think they are feeling/i, 'adapts silently')
  // Tools.
  has(/NEVER NARRATE YOUR MACHINERY/i, 'never narrates the mechanism')
  has(/Never claim it worked/i, 'never fakes a tool success')
})
