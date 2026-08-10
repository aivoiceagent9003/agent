// ingest.js — Knowledge base ingestion
// Exposes ingestText() for the API, and still works as a CLI:
//   node src/ingest.js <tenant_id> <path-to-text-file>

import OpenAI from 'openai'
import { supabase } from './api/db.js'
import { readFileSync } from 'fs'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function chunkText(text, chunkSize = 500, overlap = 100) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const chunks = []
  let current = ''
  for (const para of paragraphs) {
    if ((current + ' ' + para).length > chunkSize && current) {
      chunks.push(current.trim())
      const tail = current.slice(-overlap)
      current = tail + ' ' + para
    } else {
      current = current ? `${current} ${para}` : para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// Embed many chunks at once. The embeddings endpoint accepts an array, so a
// 150-chunk upload becomes a couple of requests instead of 150 sequential ones.
// Batched at 100 inputs/request to stay well under the per-request token cap.
// The API returns items with an `index` field — sort by it to preserve order.
async function embedBatch(texts) {
  const out = []
  const BATCH = 100
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await ai.embeddings.create({
      model: 'text-embedding-3-small',
      input: slice,
    })
    const ordered = [...res.data].sort((a, b) => a.index - b.index).map(d => d.embedding)
    out.push(...ordered)
  }
  return out
}

// ─── Auto recognition-vocabulary (keyterms) from the KB ──────────────────────
// A caller might say a product/place/person/project name the speech recognizer
// mangles ("Kokapet" → "Kukatpally"). Rather than make each client hand-curate a
// keyword list (doesn't scale to hundreds of tenants), we DERIVE the vocabulary
// from their own uploaded knowledge — the proper nouns are already in it. The
// voice engine then primes the model with these so it maps fuzzy audio to a real
// name. Works for any industry: real-estate projects, clinic doctors, menu items…

// Pull the distinct proper nouns a caller might say from a document's text.
export async function extractKeyterms(text) {
  const sample = String(text || '').slice(0, 6000)   // enough to capture the names; caps cost
  if (!sample.trim()) return []
  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `From this business document, extract the distinct PROPER NOUNS a phone caller might say — names of products, projects, places/locations, people, services, or plans. These prime a speech recognizer, so include ONLY specific names, never generic words ("apartment", "price", "doctor", "menu"). Return JSON: {"terms": ["Name One", "Name Two"]} — max 40 items, no duplicates.` },
        { role: 'user', content: sample },
      ],
      max_tokens: 500,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}')
    const terms = Array.isArray(parsed.terms) ? parsed.terms : []
    return terms.map(t => String(t).trim()).filter(Boolean).slice(0, 40)
  } catch (e) {
    console.error('[KEYTERMS] extraction failed:', e.message)
    return []
  }
}

// Merge new terms into tenants.config.kb_keyterms (case-insensitive dedupe, capped).
export async function mergeKeyterms(tenantId, newTerms) {
  if (!tenantId || !newTerms?.length) return
  try {
    const { data: tenant } = await supabase.from('tenants').select('config').eq('id', tenantId).single()
    const config = tenant?.config || {}
    const existing = Array.isArray(config.kb_keyterms) ? config.kb_keyterms : []
    const seen = new Set(existing.map(t => String(t).toLowerCase()))
    const merged = [...existing]
    for (const t of newTerms) {
      const k = String(t).toLowerCase()
      if (!seen.has(k)) { seen.add(k); merged.push(t) }
    }
    config.kb_keyterms = merged.slice(0, 150)
    await supabase.from('tenants').update({ config }).eq('id', tenantId)
    console.log(`[KEYTERMS] tenant ${tenantId}: +${newTerms.length} → ${config.kb_keyterms.length} total`)
  } catch (e) {
    console.error('[KEYTERMS] merge failed:', e.message)
  }
}

// Reusable ingestion (used by the API and the CLI).
// Chunks + embeds + stores text for a tenant. Returns { chunks_added }.
// When `documentId` is given, every chunk is linked to that document so deleting
// the document cascades to its chunks (see sql/documents.sql).
export async function ingestText(
  tenantId,
  text,
  source = 'upload',
  { replace = false, documentId = null } = {}
) {
  if (!tenantId || !text?.trim()) return { chunks_added: 0 }

  if (replace) {
    await supabase.from('knowledge_base').delete().eq('tenant_id', tenantId)
  }

  const chunks = chunkText(text)
  if (!chunks.length) return { chunks_added: 0 }

  let embeddings
  try {
    embeddings = await embedBatch(chunks)
  } catch (e) {
    console.error('[INGEST] batch embed error:', e.message)
    return { chunks_added: 0 }
  }

  const rows = chunks.map((content, i) => ({
    tenant_id: tenantId,
    content,
    embedding: embeddings[i],
    source,
    ...(documentId ? { document_id: documentId } : {}),
  }))

  const { error } = await supabase.from('knowledge_base').insert(rows)
  if (error) {
    console.error('[INGEST] insert error:', error.message)
    return { chunks_added: 0 }
  }

  // Auto-derive the recognition vocabulary from this document. Fire-and-forget so
  // it never delays the upload response (it's a background enrichment).
  extractKeyterms(text).then(terms => mergeKeyterms(tenantId, terms)).catch(() => {})

  return { chunks_added: rows.length }
}

// CLI entry (only runs when invoked directly)
const isCLI = process.argv[1] && process.argv[1].endsWith('ingest.js')
if (isCLI) {
  const [tenantId, filePath] = process.argv.slice(2)
  if (!tenantId || !filePath) {
    console.error('Usage: node src/ingest.js <tenant_id> <path-to-text-file>')
    process.exit(1)
  }
  const text = readFileSync(filePath, 'utf-8')
  console.log(`\nIngesting "${filePath}" for tenant ${tenantId}\n`)
  ingestText(tenantId, text, filePath.split('/').pop(), { replace: true })
    .then(({ chunks_added }) => {
      console.log(`\nDone — ${chunks_added} chunks ingested\n`)
      process.exit(0)
    })
    .catch(err => {
      console.error('Ingestion failed:', err)
      process.exit(1)
    })
}