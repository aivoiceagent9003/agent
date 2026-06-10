// rag.js — Day 8.5: Retrieval for the live call
// Given a caller's question + tenant, find the most relevant knowledge chunks
// to inject into the LLM prompt. Runs during the call, so it must be FAST.

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

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

export async function retrieveKnowledge(tenantId, question, matchCount = 3) {
  if (!tenantId || !question) return ''

  try {
    const t0 = Date.now()

    // 1. Embed the caller's question
    const embRes = await ai.embeddings.create({
      model: 'text-embedding-3-small',
      input: question,
    })
    const queryEmbedding = embRes.data[0].embedding

    // 2. Search this tenant's knowledge via the pgvector RPC function
    const { data, error } = await supabase.rpc('match_knowledge', {
      query_embedding: queryEmbedding,
      match_tenant_id: tenantId,
      match_count: matchCount,
    })

    if (error) {
      console.error('[RAG] Search error:', error.message)
      return ''
    }

    if (!data || data.length === 0) {
      console.log('[RAG] No matching knowledge found')
      return ''
    }

    // 3. Filter by similarity threshold — ignore weak matches
    // (cosine similarity: 1 = identical, 0 = unrelated)
    const relevant = data.filter(d => d.similarity > 0.3)

    if (relevant.length === 0) {
      console.log(`[RAG] Matches too weak (best: ${data[0].similarity.toFixed(2)})`)
      return ''
    }

    const knowledge = relevant.map(d => d.content).join('\n\n')
    console.log(`[RAG] Found ${relevant.length} chunks in ${Date.now() - t0}ms (best similarity: ${relevant[0].similarity.toFixed(2)})`)

    return knowledge

  } catch (e) {
    console.error('[RAG] retrieveKnowledge error:', e.message)
    return ''  // fail gracefully — call continues without KB
  }
}