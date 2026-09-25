// local-embed.js — knowledge-search embeddings computed on this server, not at OpenAI.
//
// WHY. Every knowledge lookup embeds the model's search text before it can compare
// anything, and on live calls OpenAI took 385–943ms to do it — most of the lookup,
// since the in-memory comparison itself is 7–30ms. A small multilingual model running
// in-process does the same job in ~9ms. Measured on GSK's catalogue (634 chunks, 60
// near-duplicate products: every brand in a Secure AND a Supreme variant), it also
// ranked better: the wrong variant came back first 1 time in 126 queries, against 15
// for OpenAI's text-embedding-3-small — and the wrong variant first is how a caller
// gets quoted the Secure premium for a Supreme plan.
//
// HOW. Supabase stays the source of truth for the knowledge TEXT; this only derives
// vectors from it. A chunk is embedded once and remembered on disk by a hash of its
// content, so a restart re-reads the file instead of re-embedding, and new uploads
// cost only their own chunks. Until a tenant's vectors are ready — and whenever
// anything here fails — search carries on with OpenAI exactly as before.
//
// The model (~130MB) is downloaded from Hugging Face on first use into .cache/models.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const LOCAL_MODEL = process.env.RAG_LOCAL_MODEL || 'Xenova/multilingual-e5-small'
const CACHE_ROOT = path.resolve(process.env.RAG_LOCAL_CACHE_DIR || '.cache')
// e5 is trained with these prefixes; without them its ranking gets noticeably worse.
const PREFIX = { query: 'query: ', passage: 'passage: ' }

let loading = null   // Promise<pipeline|null>
let failed = false

/** The embedding pipeline, loaded once per process. Null if it cannot be loaded. */
export function loadLocalEmbedder() {
  if (failed) return Promise.resolve(null)
  loading ||= (async () => {
    const t0 = Date.now()
    try {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = path.join(CACHE_ROOT, 'models')
      const pipe = await pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' })
      console.log(`[RAG] 🧮 local embedding model ready (${LOCAL_MODEL}) in ${Date.now() - t0}ms`)
      return pipe
    } catch (e) {
      failed = true
      console.warn(`[RAG] local embedding model unavailable — knowledge search stays on OpenAI: ${e.message}`)
      return null
    }
  })()
  return loading
}

/** Unit-length vector for one text, or null when the local model is unavailable. */
export async function embedLocal(text, kind = 'query') {
  const pipe = await loadLocalEmbedder()
  if (!pipe) return null
  const out = await pipe(PREFIX[kind] + text, { pooling: 'mean', normalize: true })
  return Float32Array.from(out.data)
}

const hashOf = (text) => createHash('sha1').update(text).digest('base64url')
// A small Buffer can sit inside Node's shared pool, so its .buffer is the whole pool —
// the vector has to be cut out by offset, not taken from .buffer.
const fromBase64 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
const cacheFile = (tenantId) =>
  path.join(CACHE_ROOT, 'embeddings', LOCAL_MODEL.replace(/[^\w.-]+/g, '_'), `${String(tenantId).replace(/[^\w.-]+/g, '_')}.json`)

/**
 * Vectors for every chunk of a tenant, as one flat Float32Array in `contents` order.
 * Reads what is already on disk and embeds only what is not. Yields to the event loop
 * after every embedding — this runs during live calls, on the thread that is also
 * forwarding the caller's audio.
 *
 * @returns {{ vecs: Float32Array, dim: number, embedded: number, reused: number } | null}
 */
export async function buildLocalVectors(tenantId, contents) {
  const pipe = await loadLocalEmbedder()
  if (!pipe) return null
  const file = cacheFile(tenantId)
  let saved = {}
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')) } catch { /* first time */ }

  const keep = {}
  const rows = []
  let embedded = 0
  for (const text of contents) {
    const h = hashOf(text)
    let vec = saved[h] ? fromBase64(saved[h]) : null
    if (!vec) {
      vec = await embedLocal(text, 'passage')
      if (!vec) return null
      embedded++
      await new Promise(setImmediate)
    }
    keep[h] = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
    rows.push(vec)
  }

  const dim = rows[0]?.length || 0
  const vecs = new Float32Array(rows.length * dim)
  rows.forEach((v, i) => vecs.set(v, i * dim))

  // Rewritten only when something changed, and replaced whole — a half-written file
  // would be read back as corrupt and throw every chunk away.
  if (embedded || Object.keys(saved).length !== Object.keys(keep).length) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(`${file}.tmp`, JSON.stringify(keep))
      await fs.rename(`${file}.tmp`, file)
    } catch (e) {
      console.warn(`[RAG] could not save local vectors (they will be rebuilt next time): ${e.message}`)
    }
  }
  return { vecs, dim, embedded, reused: rows.length - embedded }
}
