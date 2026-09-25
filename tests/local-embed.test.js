import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The model itself is faked: these tests are about remembering vectors on disk, so a
// restart re-reads them instead of spending ~38s re-embedding a whole catalogue.
const model = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => async (text) => {
    model.calls++
    // Deterministic, distinct per text, and deliberately not "nice" floats.
    const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0)
    const v = Float32Array.from({ length: 8 }, (_, i) => Math.sin(seed * (i + 1)) / 3)
    return { data: v }
  },
}))

let dir
beforeEach(() => {
  vi.resetModules()
  model.calls = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-embed-'))
  vi.stubEnv('RAG_LOCAL_CACHE_DIR', dir)
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('buildLocalVectors', () => {
  it('embeds every chunk the first time, then reads them back from disk bit for bit', async () => {
    const { buildLocalVectors } = await import('../src/services/local-embed.js')
    const contents = ['Vaayu LifeShield Secure', 'Vaayu LifeShield Supreme', 'Kavach HealthShield Secure']
    const first = await buildLocalVectors('t1', contents)
    expect(first.embedded).toBe(3)
    expect(model.calls).toBe(3)

    vi.resetModules()
    const again = await (await import('../src/services/local-embed.js')).buildLocalVectors('t1', contents)
    expect(again.embedded).toBe(0)                    // a restart re-reads, it does not re-embed
    expect(again.reused).toBe(3)
    expect(model.calls).toBe(3)
    expect(Array.from(again.vecs)).toEqual(Array.from(first.vecs))
  })

  it('embeds only the chunks it has not seen, and keeps the order it was given', async () => {
    const { buildLocalVectors } = await import('../src/services/local-embed.js')
    const a = await buildLocalVectors('t1', ['one', 'two'])
    const b = await buildLocalVectors('t1', ['two', 'three', 'one'])
    expect(b.embedded).toBe(1)
    expect(Array.from(b.vecs.slice(0, 8))).toEqual(Array.from(a.vecs.slice(8, 16)))    // "two" moved first
    expect(Array.from(b.vecs.slice(16, 24))).toEqual(Array.from(a.vecs.slice(0, 8)))   // "one" moved last
  })

  it('gives each query and passage the prefix e5 was trained with', async () => {
    const seen = []
    vi.doMock('@huggingface/transformers', () => ({
      env: {}, pipeline: async () => async (text) => { seen.push(text); return { data: new Float32Array(4) } },
    }))
    const { embedLocal } = await import('../src/services/local-embed.js')
    await embedLocal('Vaayu premium', 'query')
    await embedLocal('Vaayu premium table', 'passage')
    expect(seen).toEqual(['query: Vaayu premium', 'passage: Vaayu premium table'])
  })
})
