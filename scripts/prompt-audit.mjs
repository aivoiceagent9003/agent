// scripts/prompt-audit.mjs — what is actually in the 12K tokens we send every turn?
//
// The hot prompt is the largest single thing on every LLM request of every turn, and
// measured against a near-empty prompt it costs ~380ms of first-token latency. Before
// any of it is cut, this says where the tokens are — because "shorten the prompt" is
// how an agent quietly loses the behaviour somebody spent months tuning.
//
// Token counts are ESTIMATES. Gemini is not tokenised locally here, so this uses a
// chars-per-token ratio and says so; the ratio is worse for Telugu and Devanagari
// than for English, which is why the script reports characters too. Use it to rank
// sections, not to quote an exact bill.
//
// Usage: node scripts/prompt-audit.mjs [tenantName]

import 'dotenv/config'
import { supabase } from '../src/api/db.js'
import { buildSystemPrompt } from '../src/services/llm.js'
import { whatsappReady } from '../src/services/whatsapp.js'
import { buildAgentTools } from '../src/services/agent-tools.js'
import { VOICE_OUTPUT_RULES } from '../src/services/cascade.js'

const tenantName = process.argv.slice(2).find(a => !a.startsWith('--')) || 'GSK insurance'
const { data: tenant, error } = await supabase.from('tenants').select('*').ilike('name', tenantName).single()
if (error || !tenant) { console.log(`tenant "${tenantName}" not found`); process.exit(1) }
const tenantConfig = { ...(tenant.config || {}), tenant_id: tenant.id }

// Latin text runs ~4 chars/token; Telugu and Devanagari are far worse because they
// fall back to byte-level pieces. Counted separately so the estimate is not silently
// dominated by whichever script happens to appear.
const INDIC = /[ऀ-ॿఀ-౿ঀ-৿஀-௿ಀ-೿ഀ-ൿ]/g
function estTokens(s) {
  const text = String(s || '')
  const indic = (text.match(INDIC) || []).length
  const latin = text.length - indic
  return Math.round(latin / 4 + indic / 1.2)
}

const systemPrompt = buildSystemPrompt(tenantConfig, {
  channel: 'voice', whatsapp: whatsappReady(tenantConfig), language: { modelLed: true },
})
const full = systemPrompt + '\n\n' + VOICE_OUTPUT_RULES
const toolDecls = buildAgentTools(tenantConfig)[0]?.functionDeclarations || []
const toolsJson = JSON.stringify(toolDecls)

console.log(`tenant "${tenant.name}"`)
console.log(`system prompt      ${String(systemPrompt.length).padStart(7)} chars  ~${estTokens(systemPrompt)} tokens`)
console.log(`VOICE_OUTPUT_RULES ${String(VOICE_OUTPUT_RULES.length).padStart(7)} chars  ~${estTokens(VOICE_OUTPUT_RULES)} tokens`)
console.log(`tool schemas       ${String(toolsJson.length).padStart(7)} chars  ~${estTokens(toolsJson)} tokens  (${toolDecls.length} tools)`)
console.log(`─────────────────────────────────────────────────────────────`)
console.log(`HOT TOTAL          ${String(full.length + toolsJson.length).padStart(7)} chars  ~${estTokens(full) + estTokens(toolsJson)} tokens\n`)

// Sections are ALL-CAPS headings in the assembled prompt. Attributing them back to the
// module that emitted them is what makes this actionable — a heading tells you the
// rule, the file tells you where to go and change it.
const SECTION_RE = /\n(?=[A-Z][A-Z0-9 ,'’/&#—-]{8,}\n)/
const blocks = full.split(SECTION_RE).filter(b => b.trim())

// Which conversation module a heading came from, so a cut has an owner.
const layerFiles = {
  'core-rules': /WHO YOU ARE|RULE PRECEDENCE|BEING HONEST|HOW THE CALL GOES/,
  'language-rules': /LANGUAGE|CODE-MIXING|SCRIPT|SEARCH IN ENGLISH/,
  'speech-rules': /HOW TO SPEAK|SAYING NUMBERS|PRONUNC|READ ALOUD|TRANSCRIPT/,
  'human-conversation-rules': /READING THE CALLER|ONE THING AT A TIME|ADDRESSING THE CALLER|INTERRUPT/,
  'response-length-rules': /HOW LONG TO SPEAK/,
  'tool-usage-rules': /WHAT YOU KNOW|PICK THE RIGHT SOURCE|LOOKUP|A LOOKUP RESULT/,
  'escalation-rules': /HANDING OFF|ENDING THE CALL/,
  'template/sales': /HELP THEM CHOOSE|DISCOVER BEFORE|QUALIFYING|OFFER ONCE|WHAT YOU HAVE HEARD/,
}
const owner = (heading) => Object.entries(layerFiles).find(([, re]) => re.test(heading))?.[0] || '—'

const rows = blocks.map(b => {
  const heading = b.split('\n')[0].trim()
  return { heading, chars: b.length, tokens: estTokens(b), owner: owner(heading), body: b }
}).sort((a, b) => b.tokens - a.tokens)

console.log('  tokens   chars  owner                       section')
for (const r of rows) {
  console.log(`  ${String(r.tokens).padStart(6)} ${String(r.chars).padStart(7)}  ${r.owner.padEnd(26)} ${r.heading.slice(0, 62)}`)
}

const total = rows.reduce((n, r) => n + r.tokens, 0)
console.log(`  ${String(total).padStart(6)} ${String(full.length).padStart(7)}  TOTAL (${rows.length} sections)\n`)

// Grouped the way the task asks for it.
const GROUPS = {
  'CORE SYSTEM RULES': ['core-rules'],
  'LANGUAGE RULES': ['language-rules'],
  'SPEECH / VOICE RULES': ['speech-rules'],
  'CONVERSATION RULES': ['human-conversation-rules', 'response-length-rules'],
  'TOOL RULES': ['tool-usage-rules'],
  'ESCALATION': ['escalation-rules'],
  'TEMPLATE / SALES': ['template/sales'],
  'UNATTRIBUTED': ['—'],
}
console.log('  GROUP                       tokens   share')
for (const [group, owners] of Object.entries(GROUPS)) {
  const n = rows.filter(r => owners.includes(r.owner)).reduce((s, r) => s + r.tokens, 0)
  if (n) console.log(`  ${group.padEnd(26)} ${String(n).padStart(6)}   ${(n / total * 100).toFixed(1)}%`)
}
console.log(`  ${'TOOL SCHEMAS'.padEnd(26)} ${String(estTokens(toolsJson)).padStart(6)}   (sent alongside, not in the text)`)

// Duplication is the safest thing to cut: the same instruction stated twice costs
// tokens twice and changes nothing if one copy goes. Reported as evidence, not acted on.
console.log('\n── repeated instruction lines (same rule stated more than once) ──')
const lines = full.split('\n').map(l => l.trim()).filter(l => l.length > 45 && /^[-•]/.test(l))
const seen = new Map()
for (const l of lines) {
  const norm = l.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(w => w.length > 3).sort().join(' ')
  if (!seen.has(norm)) seen.set(norm, [])
  seen.get(norm).push(l)
}
let dupTokens = 0
for (const [, group] of seen) {
  if (group.length < 2) continue
  dupTokens += estTokens(group[0]) * (group.length - 1)
  console.log(`  ×${group.length}  ${group[0].slice(0, 88)}`)
}
console.log(`  ~${dupTokens} tokens in exact-ish repeats`)

// The other half of the hot prompt: what grows per turn rather than per call.
console.log('\n── what grows DURING the call ──')
console.log('  Conversation history is appended verbatim, turn after turn, and every')
console.log('  turn re-sends all of it. At ~60 tokens per exchange a 20-turn call adds')
console.log(`  ~1200 tokens on top of the ~${estTokens(full) + estTokens(toolsJson)} static tokens above.`)
console.log('  Run scripts/ttft-bench.mjs to see whether that is where the cliff is.')
