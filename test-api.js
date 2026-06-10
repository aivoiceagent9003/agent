// test-api.js — Full backend test script
// Run from the project root: node test-api.js
//
// What this tests (in order):
//   1. Signup        → creates a test account + tenant
//   2. Login         → gets an auth token
//   3. Agent builder → templates, voices, generate-prompt, save config
//   4. Knowledge     → upload, list, delete
//   5. Test call     → multi-turn browser test (RAG + LLM, no phone)
//   6. Client views  → overview, calls list, leads list
//   7. Admin         → overview, tenants list
//   8. Cleanup       → deletes the test tenant + user
//
// CONFIG: edit the three lines below, everything else is automatic.

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BASE       = 'http://localhost:3000'
const TEST_EMAIL = `test_${Date.now()}@voiceagent.dev`  // unique each run
const TEST_PASS  = 'TestPass123!'
const TEST_PHONE = `+1999${Date.now().toString().slice(-7)}`  // unique test number
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL    = process.env.SUPABASE_URL
const ANON_KEY        = process.env.SUPABASE_ANON_KEY
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('\n❌  SUPABASE_URL and SUPABASE_ANON_KEY must be in .env\n')
  process.exit(1)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
let TOKEN   = null
let TENANT_ID = null
let TEST_USER_ID = null

function log(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✅  ${label}`) }
  else     { failed++; console.log(`  ❌  ${label}${detail ? ' — ' + detail : ''}`) }
}

async function api(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth && TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { _raw: text } }
  return { status: res.status, ok: res.ok, json }
}

function section(title) {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(50))
}

// ─── Test runner ──────────────────────────────────────────────────────────────
async function run() {
  console.log('\n🚀  Voice Agent API Test')
  console.log(`    Base URL : ${BASE}`)
  console.log(`    Test user: ${TEST_EMAIL}\n`)

  // ── 1. Public ──────────────────────────────────────────────────────────────
  section('1 / Public endpoints')

  const contact = await api('POST', '/api/public/contact', {
    name: 'Test User', email: TEST_EMAIL, company: 'Test Co', message: 'API test'
  }, false)
  log('POST /api/public/contact', contact.ok, JSON.stringify(contact.json))

  // ── 2. Signup ──────────────────────────────────────────────────────────────
  section('2 / Signup (creates tenant)')

  if (!SERVICE_KEY) {
    log('POST /api/signup', false, 'SUPABASE_SERVICE_ROLE_KEY not in .env — skipping signup')
    console.log('     ⚠️  Add the service role key to .env to test signup')
  } else {
    const signup = await api('POST', '/api/signup', {
      email: TEST_EMAIL, password: TEST_PASS, business_name: 'Test Realty'
    }, false)
    log('POST /api/signup', signup.ok, JSON.stringify(signup.json))
    if (signup.ok) {
      TENANT_ID = signup.json.tenant_id
      console.log(`     tenant_id: ${TENANT_ID}`)
    }
  }

  // ── 3. Login (get token) ───────────────────────────────────────────────────
  section('3 / Login (get auth token)')

  const loginRes = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
    }
  )
  const loginData = await loginRes.json()
  TOKEN = loginData.access_token || null

  log('Supabase login', !!TOKEN,
    TOKEN ? `token obtained (${TOKEN.slice(0,20)}...)` : JSON.stringify(loginData))

  if (!TOKEN) {
    console.log('\n  ⚠️  Cannot proceed without a token.')
    console.log('      If signup was skipped, create a user manually in Supabase Auth')
    console.log('      and set TEST_EMAIL/TEST_PASS at the top of this file.\n')
    summarise(); return
  }

  // Store user id for cleanup
  const admin = SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null
  if (admin) {
    const { data } = await admin.auth.admin.listUsers()
    const match = data?.users?.find(u => u.email === TEST_EMAIL)
    if (match) TEST_USER_ID = match.id
  }

  // ── 4. Templates & voices ──────────────────────────────────────────────────
  section('4 / Templates & voices')

  const tplList = await api('GET', '/api/client/agent/templates')
  log('GET /templates (list)',
    tplList.ok && Array.isArray(tplList.json) && tplList.json.length > 0,
    `${tplList.json?.length} templates`)

  const tplOne = await api('GET', '/api/client/agent/templates/real_estate_sales')
  log('GET /templates/real_estate_sales',
    tplOne.ok && tplOne.json?.id === 'real_estate_sales',
    tplOne.json?.label)

  const voices = await api('GET', '/api/client/agent/voices')
  log('GET /voices', voices.ok && Array.isArray(voices.json) && voices.json.length > 0,
    `${voices.json?.length} voices`)

  const recs = await api('GET', '/api/client/agent/recommendations?sector=real_estate')
  log('GET /recommendations?sector=real_estate', recs.ok && recs.json?.tip,
    recs.json?.tip?.slice(0, 50))

  // ── 5. Generate prompt (Auto Build) ───────────────────────────────────────
  section('5 / Generate prompt (Auto Build path)')

  const gen = await api('POST', '/api/client/agent/generate-prompt', {
    agent_name: 'Priya',
    languages: ['English', 'Hindi'],
    goal: 'Help callers explore property options, share pricing, and book site visits',
    next_steps: 'Book a site visit or transfer to sales team',
    faqs: 'We have projects in Kokapet and Kollur. 3BHK from 2.8 crore.',
    sample_transcript: 'Caller: I need a 3BHK. Agent: Sure, let me help you.',
  })
  log('POST /generate-prompt', gen.ok && !!gen.json?.system_prompt,
    gen.json?.system_prompt?.slice(0, 60) + '...')

  // ── 6. Save agent config ───────────────────────────────────────────────────
  section('6 / Save agent config')

  const savedPrompt = gen.json?.system_prompt || 'You are a helpful real estate agent.'
  const save = await api('PATCH', '/api/client/agent', {
    config: {
      agent_name: 'Priya',
      system_prompt: savedPrompt,
      voice: 'priya',
      handoff_number: '+919441232246',
      enable_handoff: true,
      enable_kb: true,
    },
    phone_number: TEST_PHONE,
  })
  log('PATCH /agent (save draft)', save.ok && save.json?.config?.status === 'draft',
    `HTTP ${save.status} | ${save.json?.detail || save.json?.error || JSON.stringify(save.json)}`)

  const getAgent = await api('GET', '/api/client/agent')
  log('GET /agent (read back)', getAgent.ok && getAgent.json?.config?.agent_name === 'Priya',
    `HTTP ${getAgent.status} | full response: ${JSON.stringify(getAgent.json)}`)

  // ── 7. Knowledge base ──────────────────────────────────────────────────────
  section('7 / Knowledge base (upload + list + delete)')

  const kbAdd = await api('POST', '/api/client/agent/knowledge', {
    text: `My Home Apas in Kokapet offers 3BHK luxury apartments.
Sizes range from 2400 to 2800 square feet.
Prices between 2.8 crore and 3.4 crore rupees.
Possession expected by December 2026.
Amenities include clubhouse, pool, gym, and 24x7 security.`,
    source: 'test-upload',
  })
  log('POST /knowledge (upload)', kbAdd.ok && kbAdd.json?.chunks_added > 0,
    `chunks_added: ${kbAdd.json?.chunks_added}`)

  const kbList = await api('GET', '/api/client/agent/knowledge')
  log('GET /knowledge (list)', kbList.ok && Array.isArray(kbList.json),
    `${kbList.json?.length} chunks in KB`)

  if (kbList.ok && kbList.json?.length > 0) {
    const chunkId = kbList.json[0].id
    const kbDel = await api('DELETE', `/api/client/agent/knowledge/${chunkId}`)
    log('DELETE /knowledge/:chunkId', kbDel.ok, JSON.stringify(kbDel.json))
  }

  // ── 8. Test call (the big one) ─────────────────────────────────────────────
  section('8 / Test call (browser simulation — RAG + LLM, no phone)')
  console.log('     (this calls OpenAI so may take 2-3 seconds per turn)\n')

  const SESSION = `test-${Date.now()}`

  // Re-add some knowledge before testing
  await api('POST', '/api/client/agent/knowledge', {
    text: 'My Home Apas in Kokapet offers 3BHK from 2.8 crore to 3.4 crore. Possession December 2026.',
    source: 'test-reupload',
  })

  const turn1 = await api('POST', '/api/client/agent/test', {
    message: 'I am looking for a 3BHK in Kokapet',
    session_id: SESSION,
  })
  log('Test turn 1 — property query',
    turn1.ok && !!turn1.json?.reply,
    `used_kb: ${turn1.json?.used_knowledge} | reply: "${turn1.json?.reply}"`)

  const turn2 = await api('POST', '/api/client/agent/test', {
    message: 'What is the price?',
    session_id: SESSION,
  })
  log('Test turn 2 — follow-up (context-aware)',
    turn2.ok && !!turn2.json?.reply,
    `used_kb: ${turn2.json?.used_knowledge} | reply: "${turn2.json?.reply}"`)

  const turn3 = await api('POST', '/api/client/agent/test', {
    message: 'Thank you, goodbye',
    session_id: SESSION,
  })
  log('Test turn 3 — goodbye',
    turn3.ok && turn3.json?.reply?.toLowerCase().includes('goodbye'),
    `reply: "${turn3.json?.reply}"`)

  const reset = await api('POST', '/api/client/agent/test/reset', { session_id: SESSION })
  log('POST /test/reset', reset.ok, JSON.stringify(reset.json))

  // ── 9. Publish ─────────────────────────────────────────────────────────────
  section('9 / Publish agent')

  const pub = await api('POST', '/api/client/agent/publish')
  log('POST /publish', pub.ok && pub.json?.status === 'published',
    `status: ${pub.json?.status}`)

  // ── 10. Client dashboard views ─────────────────────────────────────────────
  section('10 / Client dashboard views')

  const overview = await api('GET', '/api/client/overview')
  log('GET /client/overview', overview.ok,
    `calls: ${overview.json?.total_calls}, leads: ${overview.json?.total_leads}`)

  const calls = await api('GET', '/api/client/calls?page=1&limit=5')
  log('GET /client/calls', calls.ok,
    `returned ${calls.json?.calls?.length ?? 0} calls (total: ${calls.json?.total})`)

  const leads = await api('GET', '/api/client/leads?page=1&limit=5')
  log('GET /client/leads', leads.ok,
    `returned ${leads.json?.leads?.length ?? 0} leads (total: ${leads.json?.total})`)

  const csvRes = await fetch(`${BASE}/api/client/leads/export`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  log('GET /client/leads/export (CSV)', csvRes.ok,
    `content-type: ${csvRes.headers.get('content-type')}`)

  // ── 11. Admin views ────────────────────────────────────────────────────────
  section('11 / Admin views')
  console.log('     (these will fail with 403 if logged in as a client — expected)\n')

  const adminOverview = await api('GET', '/api/admin/overview')
  if (adminOverview.status === 403) {
    log('GET /admin/overview (403 — client token, expected)', true, 'correctly blocked')
  } else {
    log('GET /admin/overview', adminOverview.ok,
      `tenants: ${adminOverview.json?.total_tenants}`)
  }

  // ── 12. Cleanup ────────────────────────────────────────────────────────────
  section('12 / Cleanup')

  if (admin && TENANT_ID) {
    await admin.from('knowledge_base').delete().eq('tenant_id', TENANT_ID)
    await admin.from('leads').delete().eq('tenant_id', TENANT_ID)
    await admin.from('calls').delete().eq('tenant_id', TENANT_ID)
    await admin.from('profiles').delete().eq('tenant_id', TENANT_ID)
    await admin.from('tenants').delete().eq('id', TENANT_ID)
    log('Deleted test tenant from DB', true, TENANT_ID)
  }
  if (admin && TEST_USER_ID) {
    await admin.auth.admin.deleteUser(TEST_USER_ID)
    log('Deleted test auth user', true, TEST_EMAIL)
  }
  if (!admin) {
    console.log('     ⚠️  Skipped cleanup (no service role key) — delete manually:')
    console.log(`         email: ${TEST_EMAIL}  tenant_id: ${TENANT_ID}`)
  }

  summarise()
}

function summarise() {
  const total = passed + failed
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  Results: ${passed}/${total} passed   ${failed > 0 ? `(${failed} failed)` : ''}`)
  console.log('═'.repeat(50))
  if (failed === 0) console.log('  🎉  All tests passed — backend is working!')
  else console.log('  ⚠️  Some tests failed — check the details above.')
  console.log()
}

run().catch(err => {
  console.error('\n❌  Test script crashed:', err.message)
  process.exit(1)
})