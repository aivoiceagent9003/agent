import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// A campaign can talk only from files uploaded for it (kb_source 'campaign'). Those
// files must answer that campaign's calls — and must NEVER reach any other call: the
// whole reason they are kept apart is that an inbound caller should not hear about a
// project the business has only announced to one campaign's list.
const state = vi.hoisted(() => ({ tables: {}, reads: [], rpcCalls: 0, failTable: null }))

vi.mock('openai', () => ({ default: class {
  constructor() { this.embeddings = { create: async () => ({ data: [{ embedding: [1, 0] }] }) } }
} }))
vi.mock('../src/services/telemetry.js', () => ({ default: { incr: vi.fn(), recordLatency: vi.fn(), recordServiceEvent: vi.fn() } }))
vi.mock('../src/services/local-embed.js', () => ({
  loadLocalEmbedder: async () => null, embedLocal: async () => null, buildLocalVectors: async () => null,
}))
vi.mock('../src/api/db.js', () => ({ supabase: {
  // What the business-wide database search would return. Seeing it in an answer means
  // a campaign lookup fell through to the business's knowledge base.
  rpc: async () => { state.rpcCalls++; return { data: [{ content: 'BUSINESS-WIDE SEARCH RESULT', similarity: 0.99 }], error: null } },
  from: (table) => {
    let columns
    const filters = {}
    const chain = {
      select(s) { columns = s; return chain },
      eq(c, v) { filters[c] = v; return chain },
      not() { return chain }, order() { return chain }, range() { return chain }, limit() { return chain },
      then(resolve, reject) {
        state.reads.push({ table, filters: { ...filters } })
        if (state.failTable === table) {
          return Promise.resolve({ data: null, count: null, error: { message: `relation "${table}" does not exist` } }).then(resolve, reject)
        }
        const rows = (state.tables[table] || []).filter(r => Object.entries(filters).every(([k, v]) => r[k] === v))
        return Promise.resolve({ count: rows.length, error: null,
          data: columns === 'created_at' ? [{ created_at: '2026-09-28' }] : rows }).then(resolve, reject)
      },
    }
    return chain
  },
} }))

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
let rag
beforeEach(async () => {
  state.reads = []; state.rpcCalls = 0; state.failTable = null
  state.tables = {
    knowledge_base: [
      { id: 'k1', tenant_id: 't1', content: 'Greenfield Villas brochure: plots from 80 lakh.', embedding: [1, 0] },
    ],
    campaign_knowledge: [
      { id: 'c1-1', campaign_id: 'c1', content: 'Skyline Towers launch: 3BHK from 1.2 crore.', embedding: [1, 0] },
      { id: 'c2-1', campaign_id: 'c2', content: 'Riverside Plaza shops: leases from 2 lakh a year.', embedding: [1, 0] },
    ],
  }
  vi.resetModules()
  vi.stubEnv('RAG_EMBEDDER', 'openai')   // .env must not decide which path this exercises
  rag = await import('../src/services/rag.js')
})
afterEach(() => vi.unstubAllEnvs())

describe('knowledgeKey', () => {
  it("is the campaign's files only when the campaign chose them", () => {
    expect(rag.knowledgeKey({ tenant_id: 't1', campaign_id: 'c1', kb_source: 'campaign' })).toBe('campaign:c1')
    expect(rag.knowledgeKey({ tenant_id: 't1', campaign_id: 'c1', kb_source: 'existing' })).toBe('t1')
    expect(rag.knowledgeKey({ tenant_id: 't1', campaign_id: 'c1' })).toBe('t1')
    expect(rag.knowledgeKey({ tenant_id: 't1' })).toBe('t1')
  })

  it('never produces a campaign key without a campaign', () => {
    expect(rag.knowledgeKey({ tenant_id: 't1', kb_source: 'campaign' })).toBe('t1')
  })
})

describe('searching a campaign\'s own files', () => {
  it('answers from that campaign\'s files and nothing else', async () => {
    const out = await rag.retrieveKnowledge('campaign:c1', 'price of the new project', 3, { tenantId: 't1' })
    expect(out).toContain('Skyline Towers')
    expect(out).not.toContain('Greenfield')       // the business's knowledge base
    expect(out).not.toContain('Riverside')        // another campaign's files
  })

  it('does not fall back to the business-wide search on the first question of a call', async () => {
    // No warm-up: this is the lookup that, for a tenant, goes to the database search
    // while the in-memory index loads. For a campaign that search is the wrong corpus.
    const out = await rag.retrieveKnowledge('campaign:c1', 'price of the new project', 3, { tenantId: 't1' })
    expect(state.rpcCalls).toBe(0)
    expect(out).not.toContain('BUSINESS-WIDE')
  })

  it('reads campaign_knowledge for this campaign, never knowledge_base', async () => {
    await rag.retrieveKnowledge('campaign:c1', 'price', 3, { tenantId: 't1' })
    const tables = state.reads.map(r => r.table)
    expect(tables).toContain('campaign_knowledge')
    expect(tables).not.toContain('knowledge_base')
    expect(state.reads.every(r => r.table !== 'campaign_knowledge' || r.filters.campaign_id === 'c1')).toBe(true)
  })

  it('answers nothing, rather than the wrong knowledge, when the files cannot load', async () => {
    state.failTable = 'campaign_knowledge'
    const out = await rag.retrieveKnowledge('campaign:c1', 'price of the new project', 3, { tenantId: 't1' })
    expect(out).toBe('')
    expect(state.rpcCalls).toBe(0)
  })
})

describe("the business's own knowledge base", () => {
  it('never sees a campaign\'s files', async () => {
    await rag.warmupRAG('t1')
    await tick()
    const out = await rag.retrieveKnowledge('t1', 'price of the new project', 3)
    expect(out).toContain('Greenfield Villas')
    expect(out).not.toContain('Skyline')
    expect(state.reads.map(r => r.table)).not.toContain('campaign_knowledge')
  })

  it('keeps separate answers cached for the same question', async () => {
    // The answer cache is keyed by scope: a campaign's answer must not be served to
    // the business's next call that happens to ask the same thing.
    const campaign = await rag.retrieveKnowledge('campaign:c1', 'what is new', 3, { tenantId: 't1' })
    await rag.warmupRAG('t1')
    await tick()
    const business = await rag.retrieveKnowledge('t1', 'what is new', 3)
    expect(campaign).toContain('Skyline')
    expect(business).not.toContain('Skyline')
  })
})
