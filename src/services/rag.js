// rag.js — Day 8.5: Retrieval for the live call
// Given a caller's question + tenant, find the most relevant knowledge chunks
// to inject into the LLM prompt. Runs during the call, so it must be FAST.

import OpenAI from 'openai'
import { supabase } from '../api/db.js'
import telemetry from './telemetry.js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── Warmup ───────────────────────────────────────────────────────────────
// Fire a tiny embedding request when the call starts so the first REAL query
// isn't a cold start (which was taking ~3 seconds), and load the tenant's chunks
// into memory so no lookup during the call has to go to the database. Call once
// per call.
export async function warmupRAG(tenantId) {
  if (tenantId) getReadyIndex(tenantId)   // starts the load in the background
  try {
    await ai.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'warmup',
    })
    console.log('[RAG] Warmed up ✅')
  } catch {
    /* ignore — warmup is best-effort */
  }
}

// ─── Query embeddings ───────────────────────────────────────────────────────
// Embedding the question is the slow half of a lookup: 400–900ms to OpenAI, where
// the vector search itself is ~100ms. The same text always embeds to the same
// vector, so this never expires — only the LRU cap bounds it.
const EMBED_CACHE = new Map()           // normalized text -> Float32Array (unit length)
const EMBED_CACHE_MAX = 2000
const normalizeQ = (q) => q.toLowerCase().replace(/\s+/g, ' ').trim()

function toUnitVector(values) {
  const v = Float32Array.from(values)
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

async function embedQuery(question, tenantId) {
  const key = normalizeQ(question)
  const hit = EMBED_CACHE.get(key)
  if (hit) {
    EMBED_CACHE.delete(key); EMBED_CACHE.set(key, hit)   // refresh LRU position
    telemetry.recordLatency('embedding', 0, { tenantId, cache: true })
    return hit
  }
  const t = Date.now()
  const res = await ai.embeddings.create({ model: 'text-embedding-3-small', input: question })
  telemetry.recordLatency('embedding', Date.now() - t, { tenantId })
  const vec = toUnitVector(res.data[0].embedding)
  EMBED_CACHE.set(key, vec)
  if (EMBED_CACHE.size > EMBED_CACHE_MAX) EMBED_CACHE.delete(EMBED_CACHE.keys().next().value)
  return vec
}

// ─── In-memory tenant index ─────────────────────────────────────────────────
// A tenant's knowledge base is small (hundreds of chunks), so an exact cosine scan
// over it in-process takes ~1ms — against ~100ms (and a cold connection on the
// first ask) for the match_knowledge RPC. The index loads in the background at
// call start; until it is ready, and for tenants too large to hold, the RPC is used.
//
// Freshness: writes made through this server call invalidateKnowledge(). Anything
// else (the ingest CLI, another process) is caught by a cheap signature check —
// chunk count + newest created_at — every INDEX_CHECK_MS, which reloads only if
// the knowledge actually changed. Neither ever blocks a lookup.
const TENANT_INDEX = new Map()          // tenantId -> { contents, vecs, dim, sig, checkedAt, usedAt }
const INDEX_LOADING = new Map()         // tenantId -> Promise
const INDEX_CHECK_MS = 5 * 60 * 1000
const INDEX_IDLE_EVICT_MS = 30 * 60 * 1000
const INDEX_MAX_CHUNKS = 5000           // ~30MB of vectors; bigger tenants stay on the RPC
const PAGE = 1000                       // PostgREST's default max rows per request

async function knowledgeSignature(tenantId) {
  const { data, count, error } = await supabase
    .from('knowledge_base')
    .select('created_at', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return { count: count || 0, sig: `${count || 0}|${data?.[0]?.created_at || ''}` }
}

async function loadTenantIndex(tenantId) {
  const t0 = Date.now()
  const { count, sig } = await knowledgeSignature(tenantId)
  if (count > INDEX_MAX_CHUNKS) {
    TENANT_INDEX.set(tenantId, { tooLarge: true, sig, checkedAt: Date.now(), usedAt: Date.now() })
    console.log(`[RAG] ${count} chunks — too large to hold in memory, using vector search`)
    return
  }

  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('knowledge_base')
      .select('id, content, embedding')
      .eq('tenant_id', tenantId)
      .not('embedding', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < PAGE) break
  }

  const parsed = rows.map(r => (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding))
  const dim = parsed[0]?.length || 0
  const vecs = new Float32Array(rows.length * dim)
  parsed.forEach((values, i) => vecs.set(toUnitVector(values), i * dim))

  TENANT_INDEX.set(tenantId, {
    contents: rows.map(r => r.content),
    vecs, dim, sig,
    checkedAt: Date.now(),
    usedAt: TENANT_INDEX.get(tenantId)?.usedAt || Date.now(),
  })
  console.log(`[RAG] 🧠 loaded ${rows.length} chunks into memory in ${Date.now() - t0}ms`)
}

function startLoad(tenantId, { onlyIfChanged = false } = {}) {
  if (INDEX_LOADING.has(tenantId)) return
  const job = (async () => {
    if (onlyIfChanged) {
      const current = TENANT_INDEX.get(tenantId)
      const { sig } = await knowledgeSignature(tenantId)
      if (current && current.sig === sig) { current.checkedAt = Date.now(); return }
    }
    await loadTenantIndex(tenantId)
  })()
    .catch(e => console.warn('[RAG] in-memory index load failed (using vector search):', e.message))
    .finally(() => INDEX_LOADING.delete(tenantId))
  INDEX_LOADING.set(tenantId, job)
}

// The tenant's index if it is usable RIGHT NOW, else null. Never waits: a missing
// or stale index is (re)loaded in the background while this lookup uses the RPC
// (missing) or the slightly older index (stale).
function getReadyIndex(tenantId) {
  const now = Date.now()
  for (const [id, idx] of TENANT_INDEX) {
    if (id !== tenantId && now - idx.usedAt > INDEX_IDLE_EVICT_MS) TENANT_INDEX.delete(id)
  }
  const idx = TENANT_INDEX.get(tenantId)
  if (!idx) { startLoad(tenantId); return null }
  idx.usedAt = now
  if (now - idx.checkedAt > INDEX_CHECK_MS) startLoad(tenantId, { onlyIfChanged: true })
  return idx.tooLarge ? null : idx
}

// Exact top-k by cosine similarity. Vectors are unit length, so it is a dot product.
function searchIndex(idx, qvec, k) {
  const { vecs, dim, contents } = idx
  if (qvec.length !== dim) return null   // a different embedding model — let the RPC handle it
  const top = []                          // [{ i, similarity }], best first, length <= k
  for (let r = 0, off = 0; r < contents.length; r++, off += dim) {
    let dot = 0
    for (let j = 0; j < dim; j++) dot += vecs[off + j] * qvec[j]
    if (top.length < k || dot > top[top.length - 1].similarity) {
      let pos = top.length
      while (pos > 0 && top[pos - 1].similarity < dot) pos--
      top.splice(pos, 0, { i: r, similarity: dot })
      if (top.length > k) top.pop()
    }
  }
  return top.map(({ i, similarity }) => ({ content: contents[i], similarity }))
}

// Call after any write to a tenant's knowledge_base so the next lookup sees it.
export function invalidateKnowledge(tenantId) {
  if (!tenantId) return
  for (const key of RAG_CACHE.keys()) if (key.startsWith(`${tenantId}|`)) RAG_CACHE.delete(key)
  const hadIndex = TENANT_INDEX.delete(tenantId)
  const pending = INDEX_LOADING.get(tenantId)
  // A load already in flight may have read the old rows — discard it and load again.
  if (pending) pending.then(() => { TENANT_INDEX.delete(tenantId); startLoad(tenantId) })
  // Rebuild now if it was in use, so the next lookup doesn't fall back to the RPC.
  else if (hadIndex) startLoad(tenantId)
}

// ─── Retrieve relevant knowledge for a tenant ────────────────────────────────
// Returns a string of the top matching chunks, or '' if none/disabled.

// Short-TTL cache keyed by tenant + normalized query. The realtime agents often
// re-ask the same thing within a call (and across calls), and each miss costs an
// embedding + vector search (~600–2000ms) — the dominant latency on tool turns.
// A cache hit returns instantly. Entries expire after a few minutes so KB edits
// still take effect.
const RAG_CACHE = new Map()             // key -> { knowledge, ts }
const RAG_CACHE_TTL = 5 * 60 * 1000     // 5 minutes
const RAG_CACHE_MAX = 500
const ragKey = (tenantId, q) => `${tenantId}|${normalizeQ(q)}`

export async function retrieveKnowledge(tenantId, question, matchCount = 3) {
  if (!tenantId || !question) return ''

  const key = ragKey(tenantId, question)
  const hit = RAG_CACHE.get(key)
  if (hit && Date.now() - hit.ts < RAG_CACHE_TTL) {
    console.log(`[RAG] ⚡ cache hit "${question.slice(0, 40)}"`)
    telemetry.incr('rag_cache_hit')
    telemetry.recordLatency('rag_retrieval', 0, { tenantId, cache: true })
    return hit.knowledge
  }
  telemetry.incr('rag_cache_miss')
  const cache = (val) => {
    RAG_CACHE.set(key, { knowledge: val, ts: Date.now() })
    if (RAG_CACHE.size > RAG_CACHE_MAX) RAG_CACHE.delete(RAG_CACHE.keys().next().value)
    return val
  }

  try {
    const t0 = Date.now()

    // 1. Embed the caller's question (cached per text)
    const queryEmbedding = await embedQuery(question, tenantId)

    // 2. Search this tenant's knowledge — in memory when the index is loaded,
    //    otherwise via the pgvector RPC function
    const tSearch = Date.now()
    const idx = getReadyIndex(tenantId)
    let data = idx ? searchIndex(idx, queryEmbedding, matchCount) : null
    const where = data ? 'memory' : 'db'
    if (!data) {
      const res = await supabase.rpc('match_knowledge', {
        query_embedding: Array.from(queryEmbedding),
        match_tenant_id: tenantId,
        match_count: matchCount,
      })
      if (res.error) {
        console.error('[RAG] Search error:', res.error.message)
        telemetry.recordServiceEvent({ component: 'rag', severity: 'error', kind: 'vector_search', detail: { tenantId, error: res.error.message } })
        return ''
      }
      data = res.data
    }
    telemetry.recordLatency('vector_search', Date.now() - tSearch, { tenantId, where })

    if (!data || data.length === 0) {
      console.log('[RAG] No matching knowledge found')
      telemetry.incr('rag_no_match')
      telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
      return cache('')
    }

    // 3. Filter by similarity threshold — ignore weak matches
    // (cosine similarity: 1 = identical, 0 = unrelated)
    const relevant = data.filter(d => d.similarity > 0.3)

    if (relevant.length === 0) {
      console.log(`[RAG] Matches too weak (best: ${data[0].similarity.toFixed(2)})`)
      telemetry.incr('rag_no_match')
      telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
      return cache('')
    }

    const knowledge = relevant.map(d => d.content).join('\n\n')
    console.log(`[RAG] Found ${relevant.length} chunks in ${Date.now() - t0}ms (embed ${tSearch - t0}ms, search ${Date.now() - tSearch}ms ${where}, best similarity: ${relevant[0].similarity.toFixed(2)})`)
    telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
    // Similarity distribution (0-100) and chunk count, for the RAG dashboard.
    telemetry.recordLatency('rag_similarity', Math.round(relevant[0].similarity * 100), { tenantId })
    telemetry.recordLatency('rag_chunks', relevant.length, { tenantId })

    return cache(knowledge)

  } catch (e) {
    console.error('[RAG] retrieveKnowledge error:', e.message)
    telemetry.recordServiceEvent({ component: 'rag', severity: 'error', kind: 'retrieve', detail: { tenantId, error: e.message } })
    return ''  // fail gracefully — call continues without KB
  }
}
// ─── Knowledge gaps ──────────────────────────────────────────────────────────
// Every question the agent looked up and couldn't answer. Collected on the trace
// during the call (gemini-live.js) and flushed here once, at hangup, so nothing
// touches the database on the latency-critical tool path.
//
// This is what turns "81% info hit rate" on the dashboard into something a client
// can act on: the actual wording of what their agent didn't know.
export async function saveKnowledgeGaps({ tenantId, callId, questions }) {
  const list = (questions || []).filter(Boolean)
  if (!tenantId || !list.length) return 0

  try {
    const { error } = await supabase.from('knowledge_gaps').insert(
      list.map(question => ({ tenant_id: tenantId, call_id: callId || null, question })),
    )
    if (error) throw error
    console.log(`[RAG] 📝 logged ${list.length} unanswered question(s)`)
    return list.length
  } catch (e) {
    // sql/knowledge_gaps.sql may not have been run yet. Never let bookkeeping
    // break the end of a call.
    console.warn('[RAG] knowledge gap log skipped:', e.message)
    return 0
  }
}
