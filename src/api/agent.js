// api/agent.js — Agent builder endpoints (client self-serve)
// - List/get pre-built templates
// - Generate a system prompt from a plain-English description (Auto Build)
// - Test the agent in the browser (no phone call) using its real config + RAG
// - Save (draft) and publish the client's agent config

import { Router } from 'express'
import OpenAI from 'openai'
import multer from 'multer'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { TEMPLATES, getTemplate } from './templates.js'
import { buildSystemPrompt, streamAIReply, clearHistory } from '../services/llm.js'
import { retrieveKnowledge } from '../services/rag.js'
import { ingestText } from '../ingest.js'
import {
  ingestDataset,
  listDatasets,
  deleteDataset,
  parseCSV,
  sanitizeName,
} from '../services/lookups.js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const router = Router()

// In-memory upload handling for knowledge files (we parse the buffer, never
// write it to disk). 15MB cap keeps a stray huge file from exhausting memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

// Extract plain text from an uploaded file based on its type:
//   PDF   → pdf-parse        DOCX → mammoth
//   image → OpenAI vision    everything else → treat as UTF-8 text
async function extractTextFromFile(file) {
  const name = (file.originalname || '').toLowerCase()
  const mime = file.mimetype || ''
  const buf = file.buffer

  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buf })
    const result = await parser.getText()
    return result?.text || ''
  }

  if (name.endsWith('.docx') ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.extractRawText({ buffer: buf })
    return value || ''
  }

  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
    // OCR via a vision model — handles scanned docs, screenshots, photos.
    const dataUrl = `data:${mime || 'image/png'};base64,${buf.toString('base64')}`
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL text and useful information from this image as plain text for a knowledge base — include prices, names, numbers, and details. Output only the extracted text, no commentary.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 1500,
    })
    return completion.choices[0]?.message?.content || ''
  }

  // .txt / .md / .csv / .json / unknown → best-effort UTF-8
  return buf.toString('utf8')
}

// ─── Templates are public-ish (any logged-in client can browse them) ──────────
router.get('/templates', requireClient(), (req, res) => {
  // Return lightweight list (no need to send full prompts for the picker)
  res.json(TEMPLATES.map(t => ({
    id: t.id,
    label: t.label,
    description: t.description,
    icon: t.icon,
    suggested_kb_topics: t.suggested_kb_topics,
  })))
})

router.get('/templates/:id', requireClient(), (req, res) => {
  const t = getTemplate(req.params.id)
  if (!t) return res.status(404).json({ error: 'Template not found' })
  res.json(t)  // full template incl. config + system_prompt
})

// ─── Available voices (for the "Choose what voice to speak" picker) ───────────
// Provider-aware: the voice IDs differ between Sarvam and Smallest AI, so return
// the set that matches the active TTS_PROVIDER. Each voice's `label` is a human
// name the UI also uses as the suggested agent name when that voice is picked.
router.get('/voices', requireClient(), (req, res) => {
  const provider = (process.env.TTS_PROVIDER || 'sarvam').toLowerCase()

  if (provider === 'smallest') {
    // Smallest AI (Waves) voices we ship by default, plus any extra IDs added via
    // SMALLEST_VOICES_AVAILABLE (comma-separated) so the catalog can grow without
    // a code change. Label = capitalized id (e.g. sameera → Sameera).
    const known = [
      { id: 'sameera', gender: 'female', note: 'Indian English (default)' },
      { id: 'padmaja', gender: 'female', note: 'Telugu' },
    ]
    const extra = (process.env.SMALLEST_VOICES_AVAILABLE || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(id => ({ id, gender: 'unknown', note: 'Smallest AI voice' }))

    const byId = new Map()
    for (const v of [...known, ...extra]) {
      if (!byId.has(v.id)) {
        byId.set(v.id, { ...v, label: v.id.charAt(0).toUpperCase() + v.id.slice(1) })
      }
    }
    return res.json([...byId.values()])
  }

  res.json([
    { id: 'priya',  label: 'Priya',  gender: 'female', note: 'Warm, natural (default)' },
    { id: 'ritu',   label: 'Ritu',   gender: 'female', note: 'Clear, professional' },
    { id: 'neha',   label: 'Neha',   gender: 'female', note: 'Friendly' },
    { id: 'kavya',  label: 'Kavya',  gender: 'female', note: 'Soft' },
    { id: 'shreya', label: 'Shreya', gender: 'female', note: 'Energetic' },
    { id: 'simran', label: 'Simran', gender: 'female', note: 'Calm' },
    { id: 'pooja',  label: 'Pooja',  gender: 'female', note: 'Bright' },
    { id: 'aditya', label: 'Aditya', gender: 'male',   note: 'Confident' },
    { id: 'rohan',  label: 'Rohan',  gender: 'male',   note: 'Friendly' },
    { id: 'kabir',  label: 'Kabir',  gender: 'male',   note: 'Professional' },
    { id: 'dev',    label: 'Dev',    gender: 'male',   note: 'Warm' },
    { id: 'rahul',  label: 'Rahul',  gender: 'male',   note: 'Clear' },
  ])
})

// ─── Auto Build: generate a system prompt from a plain-English description ─────
// Body mirrors the "Auto Build Agent" form:
// { agent_name, languages: ['English','Hindi'], goal, next_steps, faqs, sample_transcript }
router.post('/generate-prompt', requireClient(), async (req, res) => {
  const { agent_name, languages, goal, next_steps, faqs, sample_transcript } = req.body || {}
  if (!goal?.trim()) {
    return res.status(400).json({ error: 'Please describe what the agent should achieve (goal).' })
  }

  const instruction = `You write system prompts for AI voice agents that answer phone calls for a business.
Given the description below, write a clear, concise system prompt (the ROLE/persona and behaviour)
for the agent. Write in second person ("You are..."). Keep it 4-8 sentences. Do NOT include
formatting rules, language rules, or handoff rules — those are added separately. Focus on WHO the
agent is, WHAT it helps callers with, what information it should collect, and the tone.

Agent name: ${agent_name || 'the agent'}
Languages: ${(languages || ['English']).join(', ')}
Goal of the call: ${goal}
Ideal next steps after the call: ${next_steps || 'not specified'}
Known FAQs / business info: ${faqs || 'none provided'}
Sample conversation (for tone): ${sample_transcript || 'none provided'}

Output ONLY the system prompt text, nothing else.`

  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: instruction }],
      max_tokens: 400,
      temperature: 0.5,
    })
    const system_prompt = (completion.choices[0]?.message?.content || '').trim()

    // Return a ready-to-save config draft
    res.json({
      system_prompt,
      config: {
        agent_name: agent_name || 'Agent',
        allow_multilingual: (languages || []).length > 1 || (languages || []).includes('Hindi'),
        enable_handoff: true,
        enable_kb: true,
        use_sarvam_stt: true,
        language_hint: 'unknown',   // auto-detect; client can override
        translate_replies: true,    // translate LLM replies to caller's language
        system_prompt,
        filler_phrases: ['Let me check that for you.', 'One moment, please.'],
      },
    })
  } catch (e) {
    console.error('[AGENT] generate-prompt error:', e.message)
    res.status(500).json({ error: 'Could not generate prompt. Try again.' })
  }
})

// ─── Recommendations for the custom builder (sector-aware hints) ──────────────
router.get('/recommendations', requireClient(), (req, res) => {
  const sector = (req.query.sector || '').toLowerCase()
  const match = TEMPLATES.find(t => t.id.includes(sector) || t.label.toLowerCase().includes(sector))
  res.json({
    suggested_kb_topics: match?.suggested_kb_topics || [
      'What your business offers',
      'Pricing or service details',
      'Common customer questions',
      'What info to collect from callers',
    ],
    tip: match
      ? `For ${match.label}, make sure your knowledge base covers: ${match.suggested_kb_topics.slice(0,3).join(', ')}.`
      : 'Describe clearly what the agent should achieve and what it should collect from callers.',
  })
})

// ─── Get the client's current agent (to populate the builder) ─────────────────
router.get('/', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { data, error } = await supabase
    .from('tenants').select('id, name, phone_number, config').eq('id', t).single()
  if (error || !data) return res.status(404).json({ error: 'Agent not found' })
  res.json(data)
})

// ─── Save the client's agent config (draft) ───────────────────────────────────
// Stores config into tenants.config (handoff_number, voice, system_prompt, etc.
// all live inside config). phone_number is a top-level tenant column — the
// "mobile number they want to automate" — so it's handled separately here.
router.patch('/', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { config, phone_number } = req.body || {}
  if ((!config || typeof config !== 'object') && phone_number === undefined) {
    return res.status(400).json({ error: 'config object or phone_number required' })
  }

  // Read existing config, merge new config, mark as draft
  const { data: tenant } = await supabase
    .from('tenants').select('config').eq('id', t).single()
  const merged = { ...(tenant?.config || {}), ...(config || {}), status: 'draft' }

  const patch = { config: merged }
  if (phone_number !== undefined) patch.phone_number = phone_number  // number to automate

  const { data, error } = await supabase
    .from('tenants').update(patch).eq('id', t)
    .select('id, phone_number, config').single()
  if (error) {
    console.error('[AGENT] save error:', error)
    return res.status(500).json({ error: 'Could not save agent', detail: error.message })
  }
  res.json(data)
})

// ─── Publish (make the agent live for real calls) ─────────────────────────────
router.post('/publish', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { data: tenant } = await supabase
    .from('tenants').select('config').eq('id', t).single()
  const merged = { ...(tenant?.config || {}), status: 'published' }
  const { error } = await supabase.from('tenants').update({ config: merged }).eq('id', t)
  if (error) return res.status(500).json({ error: 'Could not publish agent' })
  res.json({ success: true, status: 'published' })
})

// ─── Test the agent (browser test — behaves like a real call, no telephony) ───
// Body: { message, session_id, config? }
// If config is passed (unsaved draft), test against it; else use the saved config.
// Uses the SAME llm + RAG pipeline as a real call, so the test matches live behaviour.
router.post('/test', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { message, session_id, config } = req.body || {}
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })

  // Use the provided draft config, or fall back to the saved tenant config
  let tenantConfig = config
  if (!tenantConfig) {
    const { data: tenant } = await supabase
      .from('tenants').select('config').eq('id', t).single()
    tenantConfig = tenant?.config || {}
  }
  // Always include tenant_id so RAG searches the right knowledge base
  tenantConfig = { ...tenantConfig, tenant_id: t }

  // Unique session per test conversation so multi-turn context works
  const sid = `test-${t}-${session_id || 'default'}`

  try {
    // Retrieve knowledge exactly like a real call
    let knowledge = ''
    if (tenantConfig.enable_kb !== false) {
      knowledge = await retrieveKnowledge(t, message)
    }

    // Stream the reply (collect into a string for the HTTP response)
    let reply = ''
    for await (const token of streamAIReply(sid, message, tenantConfig, undefined, knowledge)) {
      reply += token
    }

    res.json({ reply: reply.trim(), used_knowledge: !!knowledge })
  } catch (e) {
    console.error('[AGENT] test error:', e.message)
    res.status(500).json({ error: 'Test failed' })
  }
})

// Reset a test conversation (clears multi-turn memory)
router.post('/test/reset', requireClient(), (req, res) => {
  const t = req.auth.tenantId
  const { session_id } = req.body || {}
  clearHistory(`test-${t}-${session_id || 'default'}`)
  res.json({ success: true })
})

// ─── Knowledge base (client-scoped, self-serve) ───────────────────────────────
// All scoped to the client's OWN tenant (from the token) — a client can only
// ever touch their own knowledge.

// List the client's knowledge chunks
router.get('/knowledge', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('id, content, source, created_at')
    .eq('tenant_id', t)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Could not load knowledge' })
  res.json(data || [])
})

// Add knowledge (paste text or send file contents as text)
// Body: { text, source?, replace? }
router.post('/knowledge', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { text, source, replace } = req.body || {}
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })
  try {
    const result = await ingestText(t, text, source || 'client-upload', { replace: !!replace })
    res.json(result)  // { chunks_added }
  } catch (e) {
    console.error('[AGENT] client ingest error:', e.message)
    res.status(500).json({ error: 'Could not save knowledge' })
  }
})

// Upload a file (pdf/txt/docx/image/…) → extract text → ingest into this
// client's knowledge base. Field name: "file".
router.post('/knowledge/upload', requireClient(), upload.single('file'), async (req, res) => {
  const t = req.auth.tenantId
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const text = await extractTextFromFile(req.file)
    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'Could not extract any text from this file' })
    }
    const result = await ingestText(t, text, req.file.originalname || 'upload', { replace: false })
    res.json({ ...result, filename: req.file.originalname || 'upload', chars: text.length })
  } catch (e) {
    console.error('[AGENT] kb upload error:', e.message)
    res.status(500).json({ error: 'Could not process file' })
  }
})

// Delete one chunk (must belong to this tenant)
router.delete('/knowledge/:chunkId', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { error } = await supabase
    .from('knowledge_base').delete()
    .eq('id', req.params.chunkId).eq('tenant_id', t)
  if (error) return res.status(500).json({ error: 'Could not delete chunk' })
  res.json({ success: true })
})

// Clear all of the client's knowledge
router.delete('/knowledge', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { error } = await supabase
    .from('knowledge_base').delete().eq('tenant_id', t)
  if (error) return res.status(500).json({ error: 'Could not clear knowledge' })
  res.json({ success: true })
})

// ─── Live data lookups (orders, dues, bookings…) ─────────────────────────────
// The dynamic counterpart to the knowledge base: per-caller data the agent fetches
// at call time. A lookup is either backed by the client's own REST API ('http')
// or by a data sheet they upload here ('table'). Config lives in tenants.config.lookups;
// uploaded sheets live in the lookup_rows table.

// Get the client's lookup config + a summary of any uploaded datasets.
router.get('/lookups', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { data: tenant } = await supabase
    .from('tenants').select('config').eq('id', t).single()
  const lookups = Array.isArray(tenant?.config?.lookups) ? tenant.config.lookups : []
  const datasets = await listDatasets(t)
  res.json({
    enable_lookups: tenant?.config?.enable_lookups !== false,
    lookups,
    datasets,
  })
})

// Save the client's lookup config (the array of lookups + the on/off toggle).
// Body: { lookups: [...], enable_lookups?: boolean }
router.patch('/lookups', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  const { lookups, enable_lookups } = req.body || {}
  if (!Array.isArray(lookups)) {
    return res.status(400).json({ error: 'lookups must be an array' })
  }

  // Normalise: ensure every lookup has a sanitized, unique tool name.
  const seen = new Set()
  const clean = lookups.map((lk, i) => {
    let name = sanitizeName(lk?.name || `lookup_${i + 1}`) || `lookup_${i + 1}`
    while (seen.has(name)) name = `${name}_${i + 1}`
    seen.add(name)
    return { ...lk, name }
  })

  const { data: tenant } = await supabase
    .from('tenants').select('config').eq('id', t).single()
  const merged = {
    ...(tenant?.config || {}),
    lookups: clean,
    ...(enable_lookups !== undefined ? { enable_lookups: !!enable_lookups } : {}),
  }
  const { error } = await supabase.from('tenants').update({ config: merged }).eq('id', t)
  if (error) {
    console.error('[AGENT] save lookups error:', error.message)
    return res.status(500).json({ error: 'Could not save lookups' })
  }
  res.json({ lookups: clean, enable_lookups: merged.enable_lookups !== false })
})

// Upload a data sheet for the 'table' backend. Accepts either a CSV file
// (multipart field "file") or pasted CSV text in the JSON body.
// Body/Query: { dataset } — the dataset name the table lookups reference.
router.post('/lookups/dataset', requireClient(), upload.single('file'), async (req, res) => {
  const t = req.auth.tenantId
  const dataset = (req.body?.dataset || req.query?.dataset || '').toString().trim()
  if (!dataset) return res.status(400).json({ error: 'dataset name is required' })

  let csv = ''
  if (req.file) csv = req.file.buffer.toString('utf8')
  else if (req.body?.csv) csv = String(req.body.csv)
  if (!csv.trim()) return res.status(400).json({ error: 'Provide a CSV file or csv text' })

  const rows = parseCSV(csv)
  if (!rows.length) {
    return res.status(422).json({ error: 'Could not read any rows. Use a header row + comma-separated values.' })
  }

  try {
    const { rows_added } = await ingestDataset(t, dataset, rows, { replace: true })
    res.json({ dataset, rows_added, columns: Object.keys(rows[0]) })
  } catch (e) {
    console.error('[AGENT] dataset upload error:', e.message)
    res.status(500).json({ error: 'Could not save dataset' })
  }
})

// Delete an uploaded dataset.
router.delete('/lookups/dataset/:dataset', requireClient(), async (req, res) => {
  const t = req.auth.tenantId
  await deleteDataset(t, req.params.dataset)
  res.json({ success: true })
})

export default router