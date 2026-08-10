// Backfill recognition vocabulary (kb_keyterms) for tenants that already have a
// knowledge base, by re-deriving proper nouns from their stored chunks.
// New uploads do this automatically; this is a one-time pass for existing data.
//   Run: node scripts/backfill-keyterms.js
import 'dotenv/config'
import { supabase } from '../src/api/db.js'
import { extractKeyterms, mergeKeyterms } from '../src/ingest.js'

const { data: tenants, error } = await supabase.from('tenants').select('id, name')
if (error) { console.error('Could not load tenants:', error.message); process.exit(1) }

console.log(`\nBackfilling keyterms for ${tenants?.length || 0} tenants…\n`)
for (const t of tenants || []) {
  const { data: chunks } = await supabase
    .from('knowledge_base').select('content').eq('tenant_id', t.id).limit(60)
  const text = (chunks || []).map(c => c.content).join('\n').slice(0, 8000)
  if (!text.trim()) { console.log(`  ${t.name}: no KB — skipped`); continue }
  const terms = await extractKeyterms(text)
  await mergeKeyterms(t.id, terms)
  console.log(`  ${t.name}: ${terms.length} terms${terms.length ? ' → ' + terms.slice(0, 8).join(', ') + (terms.length > 8 ? '…' : '') : ''}`)
}
console.log('\nDone.\n')
process.exit(0)
