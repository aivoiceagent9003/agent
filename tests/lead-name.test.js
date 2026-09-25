// The agent's own name must never come back as the caller's.
//
// The failure this guards against is a real call, and it is worth stating in full
// because no single line of it looks wrong. The agent greets: "Namaste, I am Arjun
// from GSK insurance." The caller answers "హలో అర్జున్" — hello Arjun — which is them
// saying hello, not saying who they are. The agent then loses track of whose name that
// is and starts addressing the CALLER as "అర్జున్ గారు". By the time the post-call
// extractor runs, the transcript agrees with itself: the caller said "Arjun" and the
// agent "confirmed" it, and the extractor's strongest rule — prefer the name the agent
// read back — points straight at the wrong answer. The lead was filed under the agent's
// name, in the caller-name field, with no sign anything had gone wrong.
//
// So there are two defences and this file covers both:
//   1. the live prompt tells the agent its name is not the caller's, so the transcript
//      never acquires the corroboration in the first place
//   2. the extractor drops the name anyway if it comes back as the agent's
//
// Nothing here throws when it breaks — that is the whole problem — so the assertions
// are on the values that reach the CRM, not on control flow.
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ reply: '{}', systemPrompt: null }))

vi.mock('openai', () => ({ default: class {
  constructor() {
    this.chat = { completions: { create: async ({ messages }) => {
      state.systemPrompt = messages.find(m => m.role === 'system')?.content || ''
      return { choices: [{ message: { content: state.reply } }] }
    } } }
  }
} }))

const { extractLead, isAgentsOwnName, nameIsEvidenced } = await import('../src/services/leads.js')
const { buildSystemPrompt } = await import('../src/services/llm.js')

const TENANT = { agent_name: 'Arjun', business_name: 'GSK insurance' }

// The call as it actually happened, trimmed to the turns that carry the name.
const TRANSCRIPT = [
  { role: 'assistant', content: 'Namaste, I am Arjun from GSK insurance. How can I help you?' },
  { role: 'user', content: 'హలో అర్జున్, నేను టర్మ్ ఇన్సూరెన్స్ గురించి చూస్తున్నాను.' },
  { role: 'assistant', content: 'అర్జున్ గారు, మీరు 5 crores cover గురించి అడుగుతున్నారా?' },
  { role: 'user', content: 'నా మొబైల్ నంబర్ వచ్చేసి 9003503664.' },
]

const lead = (over = {}) => JSON.stringify({
  name: 'Arjun', intent: 'product_inquiry', summary: 'Asked about term insurance.',
  sentiment: 'positive', language: 'te', key_details: [], follow_up_needed: true,
  name_source: 'నా పేరు అర్జున్ అండి.', handed_off: false, contact_info: '9003503664', is_lead: true,
  interest_score: 80, interest_reason: 'gave a number', ...over,
})

describe("the agent's own name is never the caller's", () => {
  it('drops a name that is really the agent, rather than filing the lead under it', async () => {
    state.reply = lead()
    const out = await extractLead(TRANSCRIPT, TENANT)
    expect(out.name).toBeNull()
    // Only the name is suspect. Everything else the call produced is still good, and
    // throwing the lead away would cost more than the wrong name did.
    expect(out.contact_info).toBe('9003503664')
    expect(out.is_lead).toBe(true)
  })

  it('keeps a real caller name, including one that merely appears alongside the agent', async () => {
    state.reply = lead({ name: 'Madhusudhan' })
    const out = await extractLead(TRANSCRIPT, TENANT)
    expect(out.name).toBe('Madhusudhan')
  })

  it('tells the extractor which name belongs to the agent', async () => {
    state.reply = lead()
    await extractLead(TRANSCRIPT, TENANT)
    expect(state.systemPrompt).toContain('THE AGENT ON THIS CALL IS CALLED "Arjun"')
  })

  it('leaves the name alone when the tenant never named its agent', async () => {
    state.reply = lead()
    const out = await extractLead(TRANSCRIPT, { business_name: 'GSK insurance' })
    expect(out.name).toBe('Arjun')
  })

  // The name arrives wearing the honorific the caller used, because that is how it was
  // said on the call. Comparing politeness instead of names let it straight through.
  it.each(['Arjun garu', 'arjun ji', 'ARJUN sir'])('recognises "%s" as the agent', (name) => {
    expect(isAgentsOwnName(name, 'Arjun')).toBe(true)
  })

  it('does not mistake a different name that merely starts the same way', () => {
    expect(isAgentsOwnName('Arjuna', 'Arjun')).toBe(false)
    expect(isAgentsOwnName('Garuda', 'Arjun')).toBe(false)
  })
})

describe('the live agent knows its name is not the caller of the day', () => {
  it("tells the agent that hearing its own name is a hello, not an introduction", () => {
    const prompt = buildSystemPrompt({ ...TENANT, template_id: 'lead_qualification' }, { channel: 'voice' })
    expect(prompt).toContain("YOUR NAME IS NOT THE CALLER'S NAME")
    expect(prompt).toContain('Never call the caller Arjun')
  })

  it('says nothing about it when the tenant never named its agent', () => {
    const prompt = buildSystemPrompt({ business_name: 'GSK insurance' }, { channel: 'voice' })
    expect(prompt).not.toContain("YOUR NAME IS NOT THE CALLER'S NAME")
  })
})

// A second call, a second way to get a name wrong, and the opposite failure mode.
//
// The line turned "term insurance" into "టామ్ ఇన్సూరెన్స్" and the extractor filed the
// caller as "Tom". Nobody on that call ever said a name. This one does not yield to
// prompting: told in the schema, told in a rule, and told with that exact sentence as
// the counter-example, gpt-4o-mini returned "Tom" on every run — and cited the
// insurance question as its evidence.
//
// So the fix is not "ask better". It is to make the model SHOW where it got the name,
// and then check that what it points at is somebody giving a name. The citation stays
// honest even when the conclusion does not, which is what makes it checkable.
describe('a name has to come from somebody giving one', () => {
  it('drops a name whose citation is not an act of naming', async () => {
    state.reply = lead({ name: 'Tom', name_source: 'నేను టామ్ ఇన్సూరెన్స్ గురించి చూస్తున్నాను' })
    const out = await extractLead(TRANSCRIPT, TENANT)
    expect(out.name).toBeNull()
  })

  it('keeps a name the caller actually gave', async () => {
    state.reply = lead({ name: 'Madhusudhan', name_source: 'నా పేరు మధుసూదన్ అండి.' })
    const out = await extractLead(TRANSCRIPT, TENANT)
    expect(out.name).toBe('Madhusudhan')
  })

  it('drops a name the model cannot point at all', async () => {
    state.reply = lead({ name: 'Tom', name_source: null })
    const out = await extractLead(TRANSCRIPT, TENANT)
    expect(out.name).toBeNull()
  })

  it('asks the model to cite the turn the name came from', async () => {
    state.reply = lead()
    await extractLead(TRANSCRIPT, TENANT)
    expect(state.systemPrompt).toContain('"name_source"')
  })

  it.each([
    ['నా పేరు మధుసూదన్ అండి.', 'Telugu'],
    ['मेरा नाम मधुसूदन है', 'Hindi'],
    ['My name is Priya', 'English'],
    ['This is Priya', 'English, no naming verb'],
    ["I'm Priya", 'English, contracted'],
    ['Priya speaking', 'English, trailing'],
    ['naa peru Madhu', 'romanised Telugu'],
    ['mera naam Madhu', 'romanised Hindi'],
  ])('recognises %s as an act of naming (%s)', (source) => {
    expect(nameIsEvidenced({ name: 'X', name_source: source })).toBe(true)
  })

  it.each([
    'నేను టామ్ ఇన్సూరెన్స్ గురించి చూస్తున్నాను',
    'Vaayu LifeShield Supreme లో 5 Crore cover',
    'I am looking for term insurance',
  ])('does not accept "%s" as one', (source) => {
    expect(nameIsEvidenced({ name: 'X', name_source: source })).toBe(false)
  })

  it('has nothing to check when no name was returned', () => {
    expect(nameIsEvidenced({ name: null, name_source: null })).toBe(true)
  })
})
