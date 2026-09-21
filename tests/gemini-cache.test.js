import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/services/telemetry.js', () => ({
  default: { incr: vi.fn(), recordLatency: vi.fn(), recordServiceEvent: vi.fn(), getTrace: () => null },
}))

let cachedContentFor, forgetCache, cacheStats, releaseCaches
const calls = []

async function load(env = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  ;({ cachedContentFor, forgetCache, cacheStats, releaseCaches } = await import('../src/services/gemini-cache.js'))
}

const settle = () => new Promise(r => setTimeout(r, 10))

beforeEach(async () => {
  calls.length = 0
  let n = 0
  globalThis.fetch = vi.fn(async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null })
    return {
      ok: true, status: 200,
      json: async () => ({ name: `cachedContents/c${++n}`, usageMetadata: { totalTokenCount: 10905 } }),
    }
  })
  await load()
})
afterEach(() => vi.unstubAllEnvs())

const ARGS = { apiKey: 'k', model: 'gemini-3.5-flash-lite', system: 'SYSTEM PROMPT', tools: [{ name: 'search_knowledge' }] }

describe('holding a tenant prompt on the provider side', () => {
  it('never blocks a turn: the first call returns null and sends the prompt inline', async () => {
    // Creating a cache is a network round trip. A caller is waiting, so the first turn
    // pays the normal price and later turns get the discount.
    expect(cachedContentFor(ARGS)).toBe(null)
    await settle()
    expect(cachedContentFor(ARGS)).toBe('cachedContents/c1')
  })

  it('creates the cache once, however many turns ask for it', async () => {
    cachedContentFor(ARGS); cachedContentFor(ARGS); cachedContentFor(ARGS)
    await settle()
    cachedContentFor(ARGS)
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('caches the tool schemas alongside the prompt — they are just as static', async () => {
    cachedContentFor(ARGS)
    await settle()
    const body = calls[0].body
    expect(body.systemInstruction.parts[0].text).toBe('SYSTEM PROMPT')
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'search_knowledge' }] }])
    expect(body.model).toBe('models/gemini-3.5-flash-lite')
    expect(body.ttl).toMatch(/^\d+s$/)
  })

  it('builds a SEPARATE cache when the prompt changes', async () => {
    // The dangerous failure would be serving a new prompt from an old cache, so the key
    // is the content itself rather than a tenant id.
    cachedContentFor(ARGS)
    await settle()
    cachedContentFor({ ...ARGS, system: 'A DIFFERENT PROMPT' })
    await settle()
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(2)
    expect(cachedContentFor({ ...ARGS, system: 'A DIFFERENT PROMPT' })).toBe('cachedContents/c2')
  })

  it('builds a separate cache when the tool list changes', async () => {
    cachedContentFor(ARGS)
    await settle()
    cachedContentFor({ ...ARGS, tools: [{ name: 'search_knowledge' }, { name: 'end_call' }] })
    await settle()
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(2)
  })

  it('keeps the call alive when Google refuses to create a cache', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }))
    await load()
    expect(cachedContentFor(ARGS)).toBe(null)
    await settle()
    expect(cachedContentFor(ARGS)).toBe(null)   // still inline, still working
  })

  it('stops using a cache Google has stopped recognising', async () => {
    cachedContentFor(ARGS)
    await settle()
    expect(cachedContentFor(ARGS)).toBe('cachedContents/c1')
    forgetCache('cachedContents/c1')
    expect(cachedContentFor(ARGS)).toBe(null)
  })

  it('can be switched off entirely', async () => {
    await load({ GEMINI_EXPLICIT_CACHE: 'false' })
    cachedContentFor(ARGS)
    await settle()
    expect(cachedContentFor(ARGS)).toBe(null)
    expect(calls).toHaveLength(0)
  })

  it('does nothing without an api key or a prompt', async () => {
    expect(cachedContentFor({ ...ARGS, apiKey: '' })).toBe(null)
    expect(cachedContentFor({ ...ARGS, system: '' })).toBe(null)
    expect(calls).toHaveLength(0)
  })

  it('releases its caches, because storage bills by the hour until they lapse', async () => {
    cachedContentFor(ARGS)
    await settle()
    const freed = await releaseCaches('k')
    expect(freed).toBe(1)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
    expect(cacheStats().entries).toBe(0)
  })

  it('reports what it is holding, so the cost of it is visible', async () => {
    cachedContentFor(ARGS)
    await settle()
    expect(cacheStats()).toEqual({ entries: 1, tokens: 10905 })
  })
})
