import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ rows: [], rpcRows: null, rpc: vi.fn() }))
vi.mock('openai', () => ({ default: class {
  constructor() { this.embeddings = { create: async () => ({ data: [{ embedding: [1, 0] }] }) } }
} }))
vi.mock('../src/services/telemetry.js', () => ({ default: {
  incr: vi.fn(), recordLatency: vi.fn(), recordServiceEvent: vi.fn(),
} }))
vi.mock('../src/api/db.js', () => ({ supabase: {
  rpc: (...args) => state.rpc(...args),
  from: () => {
    let tenantId
    let columns
    let limit = Infinity
    const chain = {
      select(s) { columns = s; return chain },
      eq(key, value) { if (key === 'tenant_id') tenantId = value; return chain },
      not() { return chain }, order() { return chain },
      range(from, to) { limit = to - from + 1; return chain },
      limit(n) { limit = n; return chain },
      then(resolve, reject) {
        const rows = state.rows.filter(r => r.tenant_id === tenantId)
        return Promise.resolve({ count: rows.length, error: null, data: columns === 'created_at'
          ? [{ created_at: '2026-09-18' }] : rows.slice(0, limit) }).then(resolve, reject)
      },
    }
    return chain
  },
} }))

let retrieveKnowledge
beforeEach(async () => {
  vi.resetModules()
  // These cover the OpenAI path, whatever the developer's .env has switched search to.
  vi.stubEnv('RAG_EMBEDDER', 'openai')
  state.rows = Array.from({ length: 20 }, (_, i) => ({
    id: String(i), tenant_id: 't1', embedding: [1, 0], similarity: .8,
    content: `Introduction "Firm${Math.floor(i / 2)} LifeShield ${i % 2 ? 'Supreme' : 'Secure'}" is a term insurance plan.`,
  }))
  state.rpcRows = null
  state.rpc.mockReset().mockImplementation(async (_, params) => ({
    data: (state.rpcRows || state.rows.filter(r => r.tenant_id === params.match_tenant_id)).slice(0, params.match_count), error: null,
  }))
  ;({ retrieveKnowledge } = await import('../src/services/rag.js'))
})

describe('RAG catalogue integration', () => {
  it('lists the words of the product names for the speech-to-text to listen for', async () => {
    // A caller said "Secure"; the STT wrote "Tech Care". The vocabulary comes from the
    // tenant's own catalogue, so it exists without anyone typing a list.
    const rag = await import('../src/services/rag.js')
    expect(rag.knowledgeVocabulary('t1')).toBeNull()                  // nothing loaded yet
    rag.warmupRAG('t1')
    await rag.whenKnowledgeLoaded('t1')
    const words = rag.knowledgeVocabulary('t1')
    expect(words).toEqual(expect.arrayContaining(['LifeShield', 'Secure', 'Supreme']))
    expect(words.some(w => /\d/.test(w))).toBe(false)               // "Firm3" is not a word to listen for
  })

  it('returns all indexed names and a bounded detail sample on a cold overview', async () => {
    const result = await retrieveKnowledge('t1', 'term insurance options best plan')
    expect(result).toContain('CATALOGUE DISCOVERY')
    expect(result.match(/^- /gm)).toHaveLength(20)
    expect(result.match(/Introduction/g)).toHaveLength(6)
    expect(state.rpc.mock.calls[0][1].match_count).toBe(60)
  })
  it('can discover names even when vectors return no matches', async () => {
    state.rpcRows = []
    expect(await retrieveKnowledge('t1', 'term insurance options')).toContain('Firm9 LifeShield Supreme')
  })
  it('keeps detail, overview and requested-count cache entries separate', async () => {
    const one = await retrieveKnowledge('t1', 'term insurance', 1)
    const four = await retrieveKnowledge('t1', 'term insurance', 4)
    const overview = await retrieveKnowledge('t1', 'term insurance', 1, { mode: 'overview' })
    expect(one.match(/Introduction/g)).toHaveLength(1)
    expect(four.match(/Introduction/g)).toHaveLength(4)
    expect(overview).toContain('CATALOGUE DISCOVERY')
  })
  it('never includes another tenant in the catalogue', async () => {
    state.rows.push({ tenant_id: 't2', content: 'Introduction "PrivatePlan" is a term insurance plan.', embedding: [1, 0] })
    const result = await retrieveKnowledge('t1', 'term insurance options')
    expect(result).not.toContain('PrivatePlan')
  })
})
