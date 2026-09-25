// Two things a premium quote depends on, both of which fail silently.
//
// 1. THE DATE. The agent turns a date of birth into an age and prices off that age.
//    Nothing in the system prompt used to say what day it was, so it did the
//    arithmetic against its training cutoff: asked in September 2026 about a caller
//    born 12 March 1998 it answered 27. The correct answer is 28, and a year is a
//    premium band. Nothing throws — the caller is simply quoted the wrong product.
//
// 2. THE FACTS. lead_qualification tells the agent to ask for something only when not
//    knowing it would change what it says next. A name changes no number, so on a real
//    call it was never asked for and the lead arrived with no one attached to it.
//    insurance_sales is the template that makes those facts required.
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/services/llm.js'
import { getAgentTemplate, allOutcomeCodes } from '../src/config/conversation/agent-templates.js'

const AT = new Date('2026-09-22T09:30:00+05:30')
const prompt = (cfg = {}, opts = {}) => buildSystemPrompt(
  { business_name: 'Cedar Demo', agent_name: 'Meghana', ...cfg },
  { channel: 'voice', now: AT, ...opts })

describe('the agent knows what day it is', () => {
  it('states today in the prompt', () => {
    expect(prompt()).toContain('TODAY IS Tuesday, 22 September 2026')
  })

  it('takes the date from the caller-supplied clock, so a replay is reproducible', () => {
    expect(prompt({}, { now: new Date('2027-01-05T12:00:00+05:30') }))
      .toContain('TODAY IS Tuesday, 5 January 2027')
  })

  it('falls back to the real clock when nobody passes one', () => {
    expect(buildSystemPrompt({ business_name: 'X' }, { channel: 'voice' }))
      .toMatch(/TODAY IS \w+day, \d{1,2} \w+ \d{4}\./)
  })

  // The date is part of the system prompt that gemini-cache.js holds provider-side,
  // keyed by a hash of its content. A clock time in here would mint a new cache on
  // every single turn: nothing would break, no test would fail, and the input bill
  // would go back to roughly three times what it is with the cache working.
  it('is date-granular, never a clock time', () => {
    const line = prompt().match(/TODAY IS [^\n]*/)[0]
    expect(line).not.toMatch(/\d{1,2}:\d{2}/)
    expect(line).not.toMatch(/\b(am|pm|AM|PM|IST|GMT|UTC)\b/)
  })

  it('renders identically for two moments on the same day', () => {
    const morning = prompt({}, { now: new Date('2026-09-22T06:00:00+05:30') })
    const evening = prompt({}, { now: new Date('2026-09-22T22:45:00+05:30') })
    expect(morning).toBe(evening)
  })

  it('tells the agent to say a derived age back before pricing off it', () => {
    expect(prompt()).toMatch(/say the\s*\n?age back/)
  })
})

describe('the insurance template asks for what a premium is made of', () => {
  const insurance = () => prompt({ template_id: 'insurance_sales' })

  it('is registered and serves its outcome codes', () => {
    expect(getAgentTemplate('insurance_sales')).toBeTruthy()
    expect(allOutcomeCodes()).toContain('QUOTED')
  })

  it('puts the date of birth first, above the age', () => {
    const p = insurance()
    expect(p).toContain('date of birth')
    expect(p).toMatch(/THE FIRST THING YOU ASK FOR IS THE DATE OF BIRTH/)
  })

  it('forbids quoting before the date of birth has been asked for', () => {
    expect(insurance()).toMatch(/Never quote a premium before you have ASKED for a date of birth/)
  })

  // The generic rule immediately above this one says not to ask for anything that does
  // not change your answer. Without the explicit carve-out the name is the casualty.
  it('requires the name even though it changes no number', () => {
    expect(insurance()).toMatch(/THE NAME IS REQUIRED EVEN THOUGH IT CHANGES NO NUMBER/)
  })

  it('does not leak into tenants on another template', () => {
    const other = prompt({ template_id: 'lead_qualification' })
    expect(other).not.toContain('THE FIRST THING YOU ASK FOR IS THE DATE OF BIRTH')
  })

  // The voice reads Latin letters with English phonetics, so a romanised Telugu example
  // in the prompt teaches the model to produce something the caller hears as nonsense.
  it('spells its Telugu examples in Telugu script', () => {
    const tpl = getAgentTemplate('insurance_sales')
    const text = JSON.stringify(tpl)
    for (const roman of ['cheppagalara', 'maarutundi', 'batti ', 'andi?']) {
      expect(text.toLowerCase()).not.toContain(roman)
    }
    expect(tpl.templateInstructions).toMatch(/[\u0C00-\u0C7F]/)
  })
})
