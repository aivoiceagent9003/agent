// ingest.js — Knowledge base ingestion
// Exposes ingestText() for the API, and still works as a CLI:
//   node src/ingest.js <tenant_id> <path-to-text-file>

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

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

async function embed(text) {
  const res = await ai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return res.data[0].embedding
}

// Reusable ingestion (used by the API and the CLI).
// Chunks + embeds + stores text for a tenant. Returns { chunks_added }.
export async function ingestText(tenantId, text, source = 'upload', { replace = false } = {}) {
  if (!tenantId || !text?.trim()) return { chunks_added: 0 }

  if (replace) {
    await supabase.from('knowledge_base').delete().eq('tenant_id', tenantId)
  }

  const chunks = chunkText(text)
  let success = 0
  for (const chunk of chunks) {
    try {
      const embedding = await embed(chunk)
      const { error } = await supabase
        .from('knowledge_base')
        .insert({ tenant_id: tenantId, content: chunk, embedding, source })
      if (!error) success++
      else console.error('[INGEST] insert error:', error.message)
    } catch (e) {
      console.error('[INGEST] chunk error:', e.message)
    }
  }
  return { chunks_added: success }
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