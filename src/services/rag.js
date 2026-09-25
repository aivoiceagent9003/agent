// rag.js — Day 8.5: Retrieval for the live call
// Given a caller's question + tenant, find the most relevant knowledge chunks
// to inject into the LLM prompt. Runs during the call, so it must be FAST.

import OpenAI from 'openai'
import { supabase } from '../api/db.js'
import telemetry from './telemetry.js'
import 'dotenv/config'
import { isOverviewQuery, extractCatalogue, catalogueContext, catalogueMatches, selectDiverseChunks, comparisonAnchors } from './knowledge-selection.js'
import { loadLocalEmbedder, embedLocal, buildLocalVectors } from './local-embed.js'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Who turns a search into a vector during a call: 'openai' (the default) or 'local'
// (a small model on this server — see local-embed.js). One line in .env switches it.
// Local vectors are derived from the same Supabase text and are used only once a
// tenant's are ready; until then, and if the local model fails, OpenAI answers.
const EMBEDDER = String(process.env.RAG_EMBEDDER || 'openai').trim().toLowerCase() === 'local' ? 'local' : 'openai'
// Matches weaker than this are dropped, so an off-topic question gets "no knowledge"
// rather than six unrelated chunks to improvise from. The two models score on
// different scales: OpenAI's unanswerable questions sat at 0.14–0.39 and the cut is
// 0.3; e5 squeezes everything high — answerable 0.84–0.95, unanswerable 0.76–0.85 on
// GSK's catalogue — and 0.83 kept every answerable question while dropping 10 of 12
// unanswerable ones (0.3 drops 9 of 12 for OpenAI).
const OPENAI_MIN_SIMILARITY = 0.3
const LOCAL_MIN_SIMILARITY = Number(process.env.RAG_LOCAL_MIN_SIMILARITY || 0.83)

// ─── Warmup ───────────────────────────────────────────────────────────────
// Fire a tiny embedding request when the call starts so the first REAL query
// isn't a cold start (which was taking ~3 seconds), and load the tenant's chunks
// into memory so no lookup during the call has to go to the database. Call once
// per call.
/**
 * Load the local search model when the SERVER starts, not when a call does. Loading it
 * freezes the event loop for ~1s (measured 985ms) — on the first call after a restart
 * that landed on the greeting: an "event loop lag, p99 502ms" alert and a greeting that
 * took 2.2s to reach the caller. At boot nobody is listening.
 */
export function preloadSearchModel() {
  return EMBEDDER === 'local' ? loadLocalEmbedder() : Promise.resolve(null)
}

export async function warmupRAG(tenantId) {
  if (tenantId) getReadyIndex(tenantId)   // starts the load in the background
  if (EMBEDDER === 'local') loadLocalEmbedder()   // ~1s from disk; never on a caller's turn
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

/** The same, on this server. Null if the local model cannot run — the caller falls back. */
async function embedQueryLocal(question, tenantId) {
  const key = `local|${normalizeQ(question)}`
  const hit = EMBED_CACHE.get(key)
  if (hit) {
    EMBED_CACHE.delete(key); EMBED_CACHE.set(key, hit)
    return hit
  }
  const t = Date.now()
  const vec = await embedLocal(question, 'query')
  if (!vec) return null
  telemetry.recordLatency('embedding', Date.now() - t, { tenantId, local: true })
  EMBED_CACHE.set(key, vec)
  if (EMBED_CACHE.size > EMBED_CACHE_MAX) EMBED_CACHE.delete(EMBED_CACHE.keys().next().value)
  return vec
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

  // Parsing is done in slices, yielding to the event loop between them.
  //
  // This looked like harmless CPU work and was not: each row holds a 1536-float
  // embedding as a JSON STRING, so the whole index is ~634 JSON.parse calls plus a
  // normalise pass, and doing it in one go blocks Node entirely. On a real call it
  // blocked long enough that the greeting's TTS audio could not be forwarded to the
  // caller until it finished — "greeting first audio 5181ms after the call connected",
  // against ~1200ms when nothing is in the way. The caller sat in silence through it.
  //
  // Warming the index during a call is still the right thing to do; hogging the one
  // thread that is also feeding the caller's audio is not.
  const first = rows[0]?.embedding
  const dim = (typeof first === 'string' ? JSON.parse(first) : first)?.length || 0
  const vecs = new Float32Array(rows.length * dim)
  const SLICE = 64
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i].embedding
    vecs.set(toUnitVector(typeof raw === 'string' ? JSON.parse(raw) : raw), i * dim)
    // setImmediate rather than a microtask: a resolved promise would run before I/O
    // callbacks and still starve the socket that is carrying the agent's voice.
    if (i % SLICE === SLICE - 1) await new Promise(setImmediate)
  }

  const idx = {
    contents: rows.map(r => r.content),
    vecs, dim, sig,
    checkedAt: Date.now(),
    usedAt: TENANT_INDEX.get(tenantId)?.usedAt || Date.now(),
  }
  TENANT_INDEX.set(tenantId, idx)
  console.log(`[RAG] 🧠 loaded ${rows.length} chunks into memory in ${Date.now() - t0}ms`)
  if (EMBEDDER === 'local') attachLocalVectors(tenantId, idx)
}

// Adds local vectors to an index in the background. Lookups keep using OpenAI until
// they land; a reload builds a fresh index and attaches its own (mostly from disk).
function attachLocalVectors(tenantId, idx) {
  const t0 = Date.now()
  buildLocalVectors(tenantId, idx.contents)
    .then((local) => {
      if (!local) return
      idx.local = local
      console.log(`[RAG] 🧮 local search ready: ${idx.contents.length} chunks in ${Date.now() - t0}ms (${local.embedded} embedded now, ${local.reused} from disk)`)
    })
    .catch(e => console.warn(`[RAG] local vectors failed — search stays on OpenAI: ${e.message}`))
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

/**
 * The words of this tenant's product names — "Vaayu", "LifeShield", "Supreme" — for the
 * speech-to-text to listen for. On a real call a caller asked about the "Secure" variant,
 * the STT wrote "Tech Care", and the model searched twice for a plan that does not exist
 * before telling the caller so. Built from the tenant's own catalogue, so no tenant has
 * to type a list. Null until the knowledge index is in memory; see whenKnowledgeLoaded.
 */
export function knowledgeVocabulary(tenantId) {
  const idx = TENANT_INDEX.get(tenantId)
  if (!idx?.contents) return null
  if (!idx.vocabulary) {
    const words = new Set()
    for (const { name } of extractCatalogue(idx.contents)) {
      for (const w of name.split(/\s+/)) if (/^[A-Za-z][A-Za-z-]{2,}$/.test(w)) words.add(w)
    }
    idx.vocabulary = [...words].slice(0, 60)
  }
  return idx.vocabulary
}

/** Resolves once a load of this tenant's knowledge that is in flight has finished. */
export function whenKnowledgeLoaded(tenantId) {
  return INDEX_LOADING.get(tenantId) || Promise.resolve()
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

export async function retrieveKnowledge(tenantId, question, matchCount = 3, { mode } = {}) {
  if (!tenantId || !question) return ''
  const overview = isOverviewQuery(question, mode)
  matchCount = Math.min(12, Math.max(1, Math.floor(Number(matchCount) || 3)))
  const candidateCount = overview ? 60 : matchCount

  const key = `${ragKey(tenantId, question)}|${overview ? 'overview' : 'detail'}|${matchCount}`
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

    // 1. Embed the question (cached per text) — locally once this tenant's local
    //    vectors are ready, otherwise with OpenAI. A query vector is only ever compared
    //    with document vectors from the SAME model.
    const idx = getReadyIndex(tenantId)
    let local = EMBEDDER === 'local' && idx?.local ? idx.local : null
    let queryEmbedding = local ? await embedQueryLocal(question, tenantId) : null
    if (!queryEmbedding) { local = null; queryEmbedding = await embedQuery(question, tenantId) }
    const minSimilarity = local ? LOCAL_MIN_SIMILARITY : OPENAI_MIN_SIMILARITY

    // 2. Search this tenant's knowledge — in memory when the index is loaded,
    //    otherwise via the pgvector RPC function
    const tSearch = Date.now()
    let data = idx ? searchIndex(local ? { ...idx, vecs: local.vecs, dim: local.dim } : idx, queryEmbedding, candidateCount) : null
    const where = data ? 'memory' : 'db'
    if (!data) {
      const res = await supabase.rpc('match_knowledge', {
        query_embedding: Array.from(queryEmbedding),
        match_tenant_id: tenantId,
        match_count: candidateCount,
      })
      if (res.error) {
        console.error('[RAG] Search error:', res.error.message)
        telemetry.recordServiceEvent({ component: 'rag', severity: 'error', kind: 'vector_search', detail: { tenantId, error: res.error.message } })
        return ''
      }
      data = res.data
    }
    telemetry.recordLatency('vector_search', Date.now() - tSearch, { tenantId, where })

    if ((!data || data.length === 0) && !overview) {
      console.log('[RAG] No matching knowledge found')
      telemetry.incr('rag_no_match')
      telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
      return cache('')
    }

    // 3. Filter by similarity threshold — ignore weak matches
    // (cosine similarity: 1 = identical, 0 = unrelated)
    let relevant = (data || []).filter(d => d.similarity > minSimilarity)

    if (relevant.length === 0 && !overview) {
      console.log(`[RAG] Matches too weak (best: ${data[0].similarity.toFixed(2)})`)
      telemetry.incr('rag_no_match')
      telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
      return cache('')
    }

    let catalogue = ''
    if (overview) {
      // Scan names across the corpus, not only the top vector hits. This also
      // works when twenty plans were uploaded together as one document.
      let contents = idx?.contents
      let truncated = false
      if (!contents) {
        const rows = await supabase.from('knowledge_base').select('content')
          .eq('tenant_id', tenantId).order('id').limit(INDEX_MAX_CHUNKS + 1)
        if (!rows.error) {
          truncated = rows.data.length > INDEX_MAX_CHUNKS
          contents = rows.data.slice(0, INDEX_MAX_CHUNKS).map(r => r.content)
        }
      }
      const entries = extractCatalogue(contents || [])
      const matches = catalogueMatches(entries, question)
      catalogue = catalogueContext(entries, question, { truncated })
      // When the catalogue identifies the requested family/category, keep detail
      // evidence inside it instead of borrowing benefits from unrelated products.
      if (matches.length) relevant = relevant.filter(row => matches.some(e =>
        row.content.toLowerCase().includes(e.name.toLowerCase())))
      const anchors = comparisonAnchors(contents || [], matches, relevant)
      relevant = selectDiverseChunks([...anchors, ...relevant], entries, 6)
    }
    if (!catalogue && !relevant.length) return cache('')
    const knowledge = catalogue + (overview
      ? 'DETAIL EXCERPTS — a selected sample, not the whole catalogue. If benefits are missing, search the exact named products.\n'
      : '') + relevant.map(d => d.content).join('\n\n')
    const bestSimilarity = Math.max(0, ...relevant.map(row => row.similarity || 0))
    console.log(`[RAG] Found ${relevant.length} chunks${overview ? ' + catalogue discovery' : ''} in ${Date.now() - t0}ms (embed ${tSearch - t0}ms ${local ? 'local' : 'openai'}, search ${Date.now() - tSearch}ms ${where}, best similarity: ${bestSimilarity.toFixed(2)})`)
    telemetry.recordLatency('rag_retrieval', Date.now() - t0, { tenantId })
    // Similarity distribution (0-100) and chunk count, for the RAG dashboard.
    telemetry.recordLatency('rag_similarity', Math.round(bestSimilarity * 100), { tenantId })
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
// during the call by the engine, and flushed here once at hangup, so nothing
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
