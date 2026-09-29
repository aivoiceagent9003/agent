import { describe, expect, it, vi } from 'vitest'

// buildAiConfig merges the business's agent config with one AI campaign's settings into
// what a campaign call runs on. Each case below is a way a campaign call used to say
// or know the wrong thing without anything failing.
vi.mock('openai', () => ({ default: class { constructor() { this.embeddings = { create: vi.fn() } } } }))
vi.mock('../src/api/db.js', () => ({ supabase: {} }))
vi.mock('../src/services/campaigns/dialer.js', () => ({ originate: vi.fn() }))
vi.mock('../src/services/campaigns/compliance.js', () => ({ canDial: vi.fn() }))
vi.mock('../src/services/campaigns/broadcast.js', () => ({ renderTemplate: vi.fn() }))
vi.mock('../src/services/campaigns/knowledge.js', () => ({ campaignKeyterms: vi.fn(async () => []) }))
vi.mock('../src/telephony/campaign-registry.js', () => ({ setPending: vi.fn() }))
vi.mock('../src/queue/queues.js', () => ({ enqueueRetry: vi.fn(), enqueueAnalytics: vi.fn() }))

const { buildAiConfig } = await import('../src/services/campaigns/execute.js')
const { knowledgeKey } = await import('../src/services/rag.js')
const { resolveGreeting } = await import('../src/services/greeting.js')

const tenant = (config = {}) => ({
  id: 't1', name: 'Acme',
  config: {
    agent_name: 'Ramya', business_name: 'Acme Insurance',
    system_prompt: 'You sell Acme term plans.',
    kb_keyterms: ['LifeShield', 'Secure'],
    outbound_greeting_message: 'Hello {name}, this is Ramya from Acme Insurance. I saw you reached out to us.',
    ...config,
  },
})
const campaign = (config = {}) => ({ id: 'c1', config })
const contact = { name: 'Ravi', custom_fields: {} }

describe('blank campaign fields', () => {
  it("inherit the agent's own setting instead of erasing it", () => {
    // The builder sends every field, filled or not. An empty system_prompt spread over
    // the tenant's used to strip the business's instructions from the call.
    const cfg = buildAiConfig(tenant(), campaign({ system_prompt: '', voice: '', response_language: '' }), contact)
    expect(cfg.system_prompt).toBe('You sell Acme term plans.')
  })

  it('still override when filled in', () => {
    const cfg = buildAiConfig(tenant(), campaign({ system_prompt: 'You are calling about Skyline Towers.' }), contact)
    expect(cfg.system_prompt).toBe('You are calling about Skyline Towers.')
  })

  it('keep a real zero', () => {
    expect(buildAiConfig(tenant(), campaign({ temperature: 0 }), contact).temperature).toBe(0)
  })
})

describe('where the agent talks from', () => {
  it("searches only the campaign's files when the campaign chose them", () => {
    const cfg = buildAiConfig(tenant(), campaign({ kb_source: 'campaign' }), contact, { campaignKeyterms: ['Skyline Towers'] })
    expect(knowledgeKey(cfg)).toBe('campaign:c1')
    // Recognition hints are the names in THOSE files, not the business's usual products.
    expect(cfg.kb_keyterms).toEqual(['Skyline Towers'])
  })

  it('keeps the search tool even when the business switched its knowledge base off', () => {
    const cfg = buildAiConfig(tenant({ enable_kb: false }), campaign({ kb_source: 'campaign' }), contact)
    expect(cfg.enable_kb).toBe(true)
  })

  it("uses the business's knowledge base by default", () => {
    const cfg = buildAiConfig(tenant(), campaign({}), contact)
    expect(knowledgeKey(cfg)).toBe('t1')
    expect(cfg.kb_keyterms).toEqual(['LifeShield', 'Secure'])
  })

  it('does not switch the knowledge base on for a business that turned it off', () => {
    expect(buildAiConfig(tenant({ enable_kb: false }), campaign({}), contact).enable_kb).toBe(false)
  })
})

describe('the opening line of a campaign call', () => {
  it('never uses the lead-call "you reached out" greeting', () => {
    // Every campaign call used to open with this, because the tenant's outbound
    // greeting was merged in and nothing told the two kinds of call apart.
    const g = resolveGreeting(buildAiConfig(tenant(), campaign({ campaign_greeting: '' }), contact))
    expect(g).not.toMatch(/reached out/i)
    expect(g).toContain('Ravi')
  })

  it("speaks the line written in the campaign builder", () => {
    const g = resolveGreeting(buildAiConfig(tenant(), campaign({
      campaign_greeting: 'Hello {name}, {agent_name} here from {business_name} — we have just launched Skyline Towers.',
    }), contact))
    expect(g).toBe('Hello Ravi, Ramya here from Acme Insurance — we have just launched Skyline Towers.')
  })
})
