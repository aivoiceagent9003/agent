// List Gemini models available to GOOGLE_AI_API_KEY that support the Live API
// (bidiGenerateContent). Run: node scripts/list-gemini-models.js
import 'dotenv/config'

const key = process.env.GOOGLE_AI_API_KEY
if (!key) { console.error('GOOGLE_AI_API_KEY not set in .env'); process.exit(1) }

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1000`)
const data = await res.json()
if (!res.ok) { console.error('API error:', JSON.stringify(data)); process.exit(1) }

const models = data.models || []
const live = models.filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))

console.log(`\n${models.length} models total; ${live.length} support the Live API (bidiGenerateContent):\n`)
for (const m of live) console.log(`  ${m.name}    —  ${m.displayName || ''}`)
console.log('\nUse one of the ids above (drop the "models/" prefix) as GEMINI_LIVE_MODEL.\n')
