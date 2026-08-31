// The call's opening line, and the recording disclosure that must precede it.
//
// The disclosure half is a compliance control, not a cosmetic one: recording
// begins when the call connects, so a caller who talks over a greeting that ENDS
// with the notice has been recorded without hearing it. A real caller demonstrated
// this by interrupting to ask "are you recording this call?" and then saying
// "actually, you need to tell that first."

import { describe, it, expect } from 'vitest'
import { resolveGreeting, recordingNotice } from '../src/services/greeting.js'

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

describe('the recording notice comes FIRST', () => {
  // Ordering is the whole point. Appending it — which is what the code used to do —
  // means anyone who interrupts has already been recorded undisclosed.
  const cases = [
    ['inbound, default wording', { business_name: 'Acme', recording_enabled: true }],
    ['inbound, custom greeting', { greeting_message: 'Welcome to Acme!', recording_enabled: true }],
    ['inbound, custom notice', { recording_enabled: true, recording_notice: 'Yeh call record ho rahi hai.' }],
    ['outbound, default template', { is_outbound: true, contact_name: 'Ravi', recording_enabled: true }],
    ['outbound, custom template', { is_outbound: true, outbound_greeting_message: 'Hi {name}!', contact_name: 'Ravi', recording_enabled: true }],
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
