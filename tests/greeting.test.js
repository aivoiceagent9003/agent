// The call's opening line, and the recording disclosure that must precede it.
//
// The disclosure half is a compliance control, not a cosmetic one: recording
// begins when the call connects, so a caller who talks over a greeting that ENDS
// with the notice has been recorded without hearing it. A real caller demonstrated
// this by interrupting to ask "are you recording this call?" and then saying
// "actually, you need to tell that first."

import { describe, it, expect } from 'vitest'
import { resolveGreeting, recordingNotice, greetingLanguage, openingForCall } from '../src/services/greeting.js'
import { buildContext, renderLayers } from '../src/config/conversation/index.js'

const DEFAULT_NOTICE = 'This call is recorded for quality and training purposes.'

describe('recordingNotice', () => {
  it('is empty unless the tenant enabled recording', () => {
    expect(recordingNotice({})).toBe('')
    expect(recordingNotice({ recording_enabled: false })).toBe('')
    // A notice configured while recording is off must still stay silent, or the
    // agent would announce recording that is not happening.
    expect(recordingNotice({ recording_notice: 'Custom wording.' })).toBe('')
  })

  it('uses the default wording when enabled with nothing custom', () => {
    expect(recordingNotice({ recording_enabled: true })).toBe(DEFAULT_NOTICE)
  })

  it('prefers tenant wording, including non-English', () => {
    expect(recordingNotice({ recording_enabled: true, recording_notice: 'Yeh call record ho rahi hai.' }))
      .toBe('Yeh call record ho rahi hai.')
  })

  it('falls back to the default when custom wording is blank', () => {
    expect(recordingNotice({ recording_enabled: true, recording_notice: '   ' })).toBe(DEFAULT_NOTICE)
  })
})

describe('inbound greeting', () => {
  it('introduces the agent and the business', () => {
    const g = resolveGreeting({ agent_name: 'Sameera', business_name: 'Madhu Constructions' })
    expect(g).toBe('Namaste, I am Sameera from Madhu Constructions. How can I help you?')
  })

  it('falls back to sane defaults when unconfigured', () => {
    const g = resolveGreeting({})
    expect(g).toContain('Priya')
    expect(g).toContain('our company')
  })

  it('uses a tenant-supplied greeting verbatim', () => {
    expect(resolveGreeting({ greeting_message: 'Welcome to Acme!' })).toBe('Welcome to Acme!')
  })
})

describe('outbound greeting', () => {
  it('acknowledges that we placed the call', () => {
    const g = resolveGreeting({ is_outbound: true, contact_name: 'Ravi', agent_name: 'Sameera', business_name: 'Acme' })
    expect(g).toContain('Ravi')
    expect(g).not.toContain('How can I help you?')
  })

  it('substitutes {name} in a custom template', () => {
    expect(resolveGreeting({ is_outbound: true, outbound_greeting_message: 'Hello {name}, this is Acme.', contact_name: 'Ravi' }))
      .toBe('Hello Ravi, this is Acme.')
  })

  it('substitutes arbitrary contact fields', () => {
    const g = resolveGreeting({
      is_outbound: true,
      outbound_greeting_message: 'Hi {name}, about {project} in {area}.',
      contact_name: 'Ravi',
      contact_fields: { project: 'Akara', area: 'Kokapet' },
    })
    expect(g).toBe('Hi Ravi, about Akara in Kokapet.')
  })

  it('collapses the gap left by an unfilled placeholder', () => {
    // An empty {placeholder} must not leave a double space or a stranded comma —
    // the agent SPEAKS this line, and "Hello , this is" reads aloud as a stumble.
    const g = resolveGreeting({
      is_outbound: true,
      outbound_greeting_message: 'Hello {missing}, this is Acme calling about {alsoMissing} today.',
      contact_name: 'Ravi',
    })
    expect(g).not.toMatch(/\s{2,}/)
    expect(g).not.toMatch(/\s,/)
    expect(g).toBe('Hello, this is Acme calling about today.')
  })

  it('uses "there" when no contact name is known', () => {
    expect(resolveGreeting({ is_outbound: true })).toContain('there')
  })
})

// The two kinds of outbound call are different conversations. An instant call is a
// lead who just filled a form — they did reach out. A campaign call is our outreach
// to a list, and every one of them used to open "I saw you reached out to us".
describe('campaign greeting', () => {
  const campaign = (over = {}) => ({
    is_outbound: true, campaign_id: 'c1', contact_name: 'Ravi',
    agent_name: 'Ramya', business_name: 'Acme', ...over,
  })

  it('never claims the contact reached out', () => {
    expect(resolveGreeting(campaign())).not.toMatch(/reached out/i)
  })

  it("speaks the campaign's own opening line, with placeholders filled", () => {
    const g = resolveGreeting(campaign({
      campaign_greeting: 'Hi {name}, {agent_name} from {business_name} — we just launched something new.',
    }))
    expect(g).toBe('Hi Ravi, Ramya from Acme — we just launched something new.')
  })

  it("ignores the tenant's lead-call greeting", () => {
    // tenant.config is merged under a campaign's config, so a tenant-level outbound
    // greeting is present on campaign calls too. It is written for leads.
    const g = resolveGreeting(campaign({ outbound_greeting_message: 'Hello {name}, I saw you reached out to us.' }))
    expect(g).not.toMatch(/reached out/i)
  })

  it('falls back to a neutral line when the campaign has none', () => {
    expect(resolveGreeting(campaign({ campaign_greeting: '   ' })))
      .toBe('Hello Ravi, this is Ramya from Acme. Do you have a minute to talk?')
  })

  it('leaves the instant (CRM lead) greeting as it was', () => {
    const g = resolveGreeting({ is_outbound: true, contact_name: 'Ravi', agent_name: 'Ramya', business_name: 'Acme' })
    expect(g).toMatch(/reached out/i)
  })
})

describe('the recording notice comes FIRST', () => {
  // Ordering is the whole point. Appending it — which is what the code used to do —
  // means anyone who interrupts has already been recorded undisclosed.
  const cases = [
    ['inbound, default wording', { business_name: 'Acme', recording_enabled: true }],
    ['inbound, custom greeting', { greeting_message: 'Welcome to Acme!', recording_enabled: true }],
    ['inbound, custom notice', { recording_enabled: true, recording_notice: 'Yeh call record ho rahi hai.' }],
    ['outbound, default template', { is_outbound: true, contact_name: 'Ravi', recording_enabled: true }],
    ['outbound, custom template', { is_outbound: true, outbound_greeting_message: 'Hi {name}!', contact_name: 'Ravi', recording_enabled: true }],
    ['campaign, own opening line', { is_outbound: true, campaign_id: 'c1', campaign_greeting: 'Hi {name}!', contact_name: 'Ravi', recording_enabled: true }],
    ['campaign, default line', { is_outbound: true, campaign_id: 'c1', contact_name: 'Ravi', recording_enabled: true }],
    ['blank custom notice', { recording_enabled: true, recording_notice: '  ' }],
  ]

  for (const [label, cfg] of cases) {
    it(`leads the line — ${label}`, () => {
      const notice = recordingNotice(cfg)
      expect(notice).not.toBe('')
      expect(resolveGreeting(cfg).startsWith(notice)).toBe(true)
    })
  }

  it('says nothing about recording when recording is off', () => {
    for (const cfg of [{ business_name: 'Acme' }, { is_outbound: true, contact_name: 'Ravi' }]) {
      expect(resolveGreeting(cfg)).not.toMatch(/record/i)
    }
  })
})

// The model's default language until the caller's own is clear. A callee's first words
// are usually a bare "yes", which is no signal; with no default, a real campaign call
// greeted in English answered "Yes, I do have." in Telugu.
describe('greetingLanguage', () => {
  const campaign = (campaign_greeting, over = {}) =>
    ({ is_outbound: true, campaign_id: 'c1', agent_name: 'Ramya', business_name: 'GSK Insurance', campaign_greeting, ...over })

  it('is English for an English greeting', () => {
    expect(greetingLanguage(campaign('Hello {name}, this is Ramya from GSK Insurance. Do you have a minute to talk?'))).toBe('English')
  })

  it('is Telugu for a Telugu greeting, even with English names in it', () => {
    expect(greetingLanguage(campaign('నమస్కారం అండి, GSK Insurance నుంచి Ramya మాట్లాడుతున్నాను. మీకు ఒక్క నిమిషం ఉందా?'))).toBe('Telugu')
  })

  it('is Hindi for a Hindi greeting', () => {
    expect(greetingLanguage(campaign('नमस्ते जी, मैं GSK Insurance से Ramya बोल रही हूँ। क्या आपके पास एक मिनट है?'))).toBe('Hindi')
  })

  it('ignores the English recording notice in front of the greeting', () => {
    const cfg = campaign('నమస్కారం అండి, మీకు ఒక్క నిమిషం ఉందా?', { recording_enabled: true })
    expect(resolveGreeting(cfg)).toMatch(/^This call is recorded/)
    expect(greetingLanguage(cfg)).toBe('Telugu')
  })

  it('reaches the language rules as the default while the caller is unclear', () => {
    const cfg = campaign('Hello, this is Ramya. Do you have a minute to talk?')
    const ctx = buildContext(cfg, { channel: 'voice', language: { modelLed: true, opening: greetingLanguage(cfg) } })
    const rules = renderLayers(ctx).find(l => l.name === 'language').text
    expect(rules).toMatch(/DEFAULT WHILE YOU CANNOT TELL[\s\S]*use English/)
  })
})

// What the agent says as the call connects. A caller-chooses agent asks for the language
// in place of its greeting's own closing question, which it asks — in the chosen
// language — once they have picked. Two questions at once leave the caller answering one.
describe('openingForCall', () => {
  const base = { agent_name: 'Ramya', business_name: 'GSK Insurance' }

  it('is the plain greeting for an English agent', () => {
    const cfg = { ...base, language_mode: 'english' }
    expect(openingForCall(cfg)).toEqual({ line: resolveGreeting(cfg), pending: null })
  })

  it('asks for the language after the introduction, holding the question back', () => {
    const o = openingForCall({ ...base, language_mode: 'caller_choice' })
    expect(o.line).toBe('Namaste, I am Ramya from GSK Insurance. Which language would you like to continue in?')
    expect(o.pending).toBe('How can I help you?')
  })

  it('does the same on a campaign call', () => {
    const o = openingForCall({ ...base, is_outbound: true, campaign_id: 'c1', contact_name: 'Ravi' })
    expect(o.line).toBe('Hello Ravi, this is Ramya from GSK Insurance. Which language would you like to continue in?')
    expect(o.pending).toBe('Do you have a minute to talk?')
  })

  it("holds back a campaign's whole pitch line, to be said in the chosen language", () => {
    const o = openingForCall({ ...base, is_outbound: true, campaign_id: 'c1', contact_name: 'Ravi',
      campaign_greeting: 'Hello {name}, this is {agent_name} from {business_name}. We have just launched a new plan — are you interested in knowing more about it?' })
    expect(o.line).toMatch(/^Hello Ravi, this is Ramya from GSK Insurance\. Which language/)
    expect(o.pending).toBe('We have just launched a new plan — are you interested in knowing more about it?')
  })

  it('never reads out the list of languages', () => {
    // It sounded like a phone menu. The options come up only if the caller asks for one
    // that is not offered (voice-turn-context.js).
    for (const caller_languages of [undefined, ['en', 'ta'], ['en', 'te', 'hi', 'kn']]) {
      const { line } = openingForCall({ ...base, caller_languages })
      expect(line).toMatch(/Which language would you like to continue in\?$/)
      expect(line).not.toMatch(/Telugu|Hindi|Tamil|Kannada/)
    }
  })

  it('keeps a greeting with no question whole', () => {
    const o = openingForCall({ ...base, greeting_message: 'Welcome to GSK Insurance!' })
    expect(o.line).toBe('Welcome to GSK Insurance! Which language would you like to continue in?')
    expect(o.pending).toBeNull()
  })

  it('still says the recording notice first', () => {
    const o = openingForCall({ ...base, recording_enabled: true })
    expect(o.line.startsWith(recordingNotice({ recording_enabled: true }))).toBe(true)
    expect(o.pending).toBe('How can I help you?')
  })
})

describe('includeNotice:false', () => {
  it('returns the greeting without the compliance sentence', () => {
    // The language detector samples this to choose the opening language. A fixed
    // English notice in front of a Hindi greeting would drag that guess to English.
    const cfg = { recording_enabled: true, greeting_message: 'Namaste, main Sameera bol rahi hoon.' }
    expect(resolveGreeting(cfg, { includeNotice: false })).toBe('Namaste, main Sameera bol rahi hoon.')
    expect(resolveGreeting(cfg)).toContain(DEFAULT_NOTICE)
  })

  it('is a no-op when recording is off', () => {
    const cfg = { greeting_message: 'Hello!' }
    expect(resolveGreeting(cfg, { includeNotice: false })).toBe(resolveGreeting(cfg))
  })
})
