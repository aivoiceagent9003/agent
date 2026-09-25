import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Knowledge search with RAG_EMBEDDER=local: the question is embedded on this server
// once the tenant's local vectors are ready, OpenAI answers until then, and a failure
// of the local model is never a failed lookup.
const state = vi.hoisted(() => ({ rows: [], openaiCalls: 0, localCalls: 0, localBroken: false, releaseBuild: null }))

vi.mock('openai', () => ({ default: class {
  constructor() { this.embeddings = { create: async () => { state.openaiCalls++; return { data: [{ embedding: [1, 0] }] } } } }
} }))
vi.mock('../src/services/telemetry.js', () => ({ default: { incr: vi.fn(), recordLatency: vi.fn(), recordServiceEvent: vi.fn() } }))
vi.mock('../src/api/db.js', () => ({ supabase: {
  rpc: async () => ({ data: [], error: null }),
  from: () => {
    let columns
    const chain = {
      select(s) { columns = s; return chain }, eq() { return chain }, not() { return chain },
      order() { return chain }, range() { return chain }, limit() { return chain },
      then(resolve, reject) {
        return Promise.resolve({ count: state.rows.length, error: null,
          data: columns === 'created_at' ? [{ created_at: '2026-09-25' }] : state.rows }).then(resolve, reject)
      },
    }
    return chain
  },
} }))
// A stand-in model with two directions: "Supreme" text points one way, "Secure" the
// other, anything else in between — enough to tell which vectors a search used.
const vecFor = (text) => /Supreme/.test(text) ? [1, 0] : /Secure/.test(text) ? [0, 1] : [0.6, 0.8]
vi.mock('../src/services/local-embed.js', () => ({
  loadLocalEmbedder: async () => ({}),
  embedLocal: async (text) => { state.localCalls++; return state.localBroken ? null : Float32Array.from(vecFor(text)) },
  buildLocalVectors: async (_tenant, contents) => {
    if (state.releaseBuild) await state.releaseBuild
    const vecs = new Float32Array(contents.length * 2)
    contents.forEach((c, i) => vecs.set(vecFor(c), i * 2))
    return { vecs, dim: 2, embedded: contents.length, reused: 0 }
  },
}))

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
let rag
async function load(env = {}) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  rag = await import('../src/services/rag.js')
}
beforeEach(() => {
  state.openaiCalls = 0; state.localCalls = 0; state.localBroken = false; state.releaseBuild = null
  state.rows = [
    { id: '1', embedding: [1, 0], content: 'Vaayu LifeShield Secure premium table: 5 crore ₹21,000 at age 25.' },
    { id: '2', embedding: [1, 0], content: 'Vaayu LifeShield Supreme premium table: 5 crore ₹39,900 at age 25.' },
  ]
})
afterEach(() => vi.unstubAllEnvs())

describe('knowledge search on the local embedding model', () => {
  it('embeds the question on this server once the tenant\'s local vectors are ready', async () => {
    await load({ RAG_EMBEDDER: 'local' })
    await rag.warmupRAG('t1')
    await tick()
    state.openaiCalls = 0
    const out = await rag.retrieveKnowledge('t1', 'Vaayu LifeShield Supreme 5 crore age 25', 1)
    expect(out).toContain('₹39,900')                  // the Supreme table, not the Secure one
    expect(out).not.toContain('₹21,000')
    expect(state.localCalls).toBe(1)
    expect(state.openaiCalls).toBe(0)
  })

  it('answers with OpenAI while the local vectors are still being built', async () => {
    let release
    state.releaseBuild = new Promise(r => { release = r })
    await load({ RAG_EMBEDDER: 'local' })
    await rag.warmupRAG('t1')
    await tick()
    state.openaiCalls = 0
    await rag.retrieveKnowledge('t1', 'Vaayu premium', 2)
    expect(state.openaiCalls).toBe(1)
    expect(state.localCalls).toBe(0)
    release()
  })

  it('falls back to OpenAI when the local model cannot embed', async () => {
    await load({ RAG_EMBEDDER: 'local' })
    await rag.warmupRAG('t1')
    await tick()
    state.openaiCalls = 0
    state.localBroken = true
    const out = await rag.retrieveKnowledge('t1', 'Vaayu Supreme premium', 2)
    expect(state.openaiCalls).toBe(1)
    expect(out).toContain('Vaayu LifeShield')         // OpenAI vectors still found the chunks
  })

  it('drops matches below the local cut-off rather than handing over unrelated chunks', async () => {
    await load({ RAG_EMBEDDER: 'local', RAG_LOCAL_MIN_SIMILARITY: '0.9' })
    await rag.warmupRAG('t1')
    await tick()
    // [0.6, 0.8] against [1,0] and [0,1]: best similarity 0.8, under the 0.9 cut.
    expect(await rag.retrieveKnowledge('t1', 'weather in Hyderabad today', 2)).toBe('')
  })

  it('loads the model at server start only when local search is on', async () => {
    // Loading it froze the event loop ~1s; at call start that landed on the greeting.
    await load({ RAG_EMBEDDER: 'local' })
    expect(await rag.preloadSearchModel()).toEqual({})     // the stand-in pipeline
    await load({ RAG_EMBEDDER: 'openai' })
    expect(await rag.preloadSearchModel()).toBeNull()
  })

  it('never touches the local model when RAG_EMBEDDER is not local', async () => {
    await load({ RAG_EMBEDDER: 'openai' })
    await rag.warmupRAG('t1')
    await tick()
    await rag.retrieveKnowledge('t1', 'Vaayu Supreme premium', 2)
    expect(state.localCalls).toBe(0)
    expect(state.openaiCalls).toBeGreaterThan(0)
  })
})
