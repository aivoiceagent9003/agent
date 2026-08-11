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
// isn't a cold start (which was taking ~3 seconds). Call once per call.
export async function warmupRAG() {
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
const ragKey = (tenantId, q) => `${tenantId}|${q.toLowerCase().replace(/\s+/g, ' ').trim()}`

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

    // 1. Embed the caller's question
    const tEmb = Date.now()
    const embRes = await ai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question,
    })
    const queryEmbedding = embRes.data[0].embedding
    telemetry.recordLatency('embedding', Date.now() - tEmb, { tenantId })

    // 2. Search this tenant's knowledge via the pgvector RPC function
    const tSearch = Date.now()
    const { data, error } = await supabase.rpc('match_knowledge', {
      query_embedding: queryEmbedding,
      match_tenant_id: tenantId,
      match_count: matchCount,
    })
    telemetry.recordLatency('vector_search', Date.now() - tSearch, { tenantId })

    if (error) {
      console.error('[RAG] Search error:', error.message)
      telemetry.recordServiceEvent({ component: 'rag', severity: 'error', kind: 'vector_search', detail: { tenantId, error: error.message } })
      return ''
    }

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
    console.log(`[RAG] Found ${relevant.length} chunks in ${Date.now() - t0}ms (best similarity: ${relevant[0].similarity.toFixed(2)})`)
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
