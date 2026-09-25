// api/agent.js — Agent builder endpoints (client self-serve)
// - List/get pre-built templates
// - Generate a system prompt from a plain-English description (Auto Build)
// - Test the agent in the browser (no phone call) using its real config + RAG
// - Save (draft) and publish the client's agent config

import { Router } from 'express'
import OpenAI from 'openai'
import { makeUpload, sniff, KINDS, uploadErrorHandler } from './uploads.js'
import { ingestLimiter } from './rate-limits.js'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { requirePermission } from './permissions.js'
import { TEMPLATES, getTemplate } from './templates.js'
import { streamAIReply, clearHistory } from '../services/llm.js'
import { buildContext, describeLayers } from '../config/conversation/index.js'
import { retrieveKnowledge, invalidateKnowledge } from '../services/rag.js'
import { listTelnyxVoices } from '../services/telnyx-voices.js'
import { ingestText } from '../ingest.js'
import {
  createDocument,
  listDocuments,
  deleteDocument,
  getDocumentUrl,
  clearAllDocuments,
} from '../services/documents.js'
import {
  ingestDataset,
  listDatasets,
  deleteDataset,
  listDatasetRows,
  createDatasetRow,
  updateDatasetRow,
  deleteDatasetRow,
  parseCSV,
  parseSheetFile,
  sanitizeName,
} from '../services/lookups.js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const router = Router()

// In-memory upload handling (we parse the buffer, never write it to disk). The
// caps keep a stray huge file from exhausting memory; the kind allow-list keeps
// arbitrary binaries out of the extractor and, more expensively, out of the
// vision OCR path.
const upload = makeUpload({ limitMb: 15, kinds: KINDS.knowledge })
// Data sheets get more room than knowledge files. A tenant's customer export is
// one wide CSV that grows with their business, where a knowledge file is a
// document someone wrote — 20MB of loan rows is ordinary, 20MB of PDF is not.
const datasetUpload = makeUpload({ limitMb: 20, kinds: KINDS.tabular })

// Per-tenant ceiling on knowledge volume. Embedding spend is otherwise unbounded:
// nothing stopped one tenant from ingesting ten thousand documents on a plan that
// assumes fifty.
const MAX_DOCUMENTS = Number(process.env.MAX_DOCUMENTS_PER_TENANT || 200)

async function knowledgeCapReached(tenantId) {
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
  if (error) return false   // never block ingest because the count query failed
  return (count || 0) >= MAX_DOCUMENTS
}

// ─── Authorization ───────────────────────────────────────────────────────────
// Every route in this router is covered by the matrix below. It lives in ONE place
// on purpose: this file mixes two very different sensitivities — the agent's
// identity/persona (owner-only; changing it changes what customers hear on every
// call) and the knowledge base (any manager should be able to keep it current) —
// and a per-route annotation scattered across 22 handlers is far easier to get
// wrong than a table you can read in one screen.
//
// GET is a read, anything else is a write. Unmatched paths FAIL CLOSED to
// agent:write (owner-only), so a route added later can never silently be public.
const ROUTE_PERMISSIONS = [
  // Knowledge base, uploaded documents, and live-data lookup tables.
  { match: /^\/(knowledge|documents|lookups)(\/|$)/, read: 'knowledge:read', write: 'knowledge:write' },
  // Read-only catalogues used to render the builder.
  { match: /^\/(templates|voices|recommendations)(\/|$)/, read: 'agent:read', write: 'agent:write' },
  // The agent config itself.
  { match: /^\/$/, read: 'agent:read', write: 'agent:write' },
]

function permissionForRequest(req) {
  const isRead = req.method === 'GET'
  for (const rule of ROUTE_PERMISSIONS) {
    if (rule.match.test(req.path)) return isRead ? rule.read : rule.write
  }
  return 'agent:write'   // /publish, /test, /generate-prompt — owner only
}

router.use(requireClient())
router.use((req, res, next) => requirePermission(permissionForRequest(req))(req, res, next))

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
router.get('/templates', (req, res) => {
  // Return lightweight list (no need to send full prompts for the picker)
  // The picker now shows what an agent actually DOES — its goals, what it finds
  // out, and how a call can end — instead of a label and an icon. That is only
  // possible because templates are structured data rather than a prompt blob.
  res.json(TEMPLATES.map(t => ({
    id: t.id,
    label: t.label,
    description: t.description,
    icon: t.icon,
    category: t.category,
    strategy: t.strategy,
    goals: t.goals,
    collects: t.collects,
    outcomes: t.outcomes,
    suggested_kb_topics: t.suggested_kb_topics,
  })))
})

router.get('/templates/:id', (req, res) => {
  const t = getTemplate(req.params.id)
  if (!t) return res.status(404).json({ error: 'Template not found' })
  res.json(t)  // full template incl. config + system_prompt
})

// ─── Prompt layer inspection (debugging) ──────────────────────────────────────
// Which layers this tenant's agent is composed from, and how big each one is —
// never the prompt text itself. That distinction matters: the composed instruction
// contains the caller's own record on an outbound call, so it is not something to
// hand back over an API. Sizes and names are enough to answer the question this
// endpoint exists for, which is "why is my agent behaving like that?".
router.get('/prompt-layers', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants').select('id, name, config').eq('id', req.auth.tenantId).single()
  if (error || !data) return res.status(404).json({ error: 'Agent not found' })
  const cfg = { ...(data.config || {}), tenant_id: data.id, business_name: (data.config || {}).business_name || data.name }
  res.json({
    live: describeLayers(buildContext(cfg, { channel: 'speech' })),
    cascade: describeLayers(buildContext(cfg, { channel: 'text' })),
  })
})

// ─── Available voices (for the "Choose what voice to speak" picker) ───────────
// Calls are spoken by Telnyx Ultra, so these are its Indian-language voices (see
// telnyx-voices.js). The chosen id belongs in `tts_voice`, NOT the older `voice`
// field, which still holds Gemini Live names for tenants created before the switch.
router.get('/voices', async (_req, res) => {
  try {
    res.json(await listTelnyxVoices())
  } catch {
    res.status(502).json({ error: 'voice list unavailable' })
  }
})

// ─── Auto Build: generate a system prompt from a plain-English description ─────
// Body mirrors the "Auto Build Agent" form:
// { agent_name, languages: ['English','Hindi'], goal, next_steps, faqs, sample_transcript }
router.post('/generate-prompt', async (req, res) => {
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
        // A generated agent has no template — its description IS its business layer.
        system_prompt,
      },
    })
  } catch (e) {
    console.error('[AGENT] generate-prompt error:', e.message)
    res.status(500).json({ error: 'Could not generate prompt. Try again.' })
  }
})

// ─── Compile company-specific rules from the owner's plain English ────────────
// The test screen asks "is the agent doing what you need?" and this turns the answer
// into rules for the COMPANY layer (config/conversation/company-rules.js).
//
// The important half of this endpoint is the REFUSAL. A business will ask for things
// the layers above them forbid — "always tell them the price", "keep pushing until
// they book" — and a compiler that silently wrote those into the prompt would produce
// an agent that visibly disobeys its owner, who would reasonably conclude the feature
// is broken. Catching the conflict here means we can say so in their own words, at
// the moment they ask, and offer the closest thing we CAN do.
//
// Body: { feedback, config? }  →  { rules: [{text, source}], rejected: [{text, reason, suggestion}] }

// What no business instruction is allowed to loosen. Each line corresponds to a rule
// that really is enforced above this layer — keep them in step.
const IMMUTABLE_RULES = `1. The agent may never state a price, figure, date, plan name or term from its own
   memory. Every fact must come from the business's knowledge base, a live data
   lookup, or the caller themselves. "Always quote X" cannot be followed as written.
2. The agent may never deny being an AI, skip a recording notice, or call someone
   who has opted out.
3. The agent must stop speaking the moment the caller interrupts.
4. The agent must accept "no" the first time and close warmly. It cannot be told to
   push, insist, or keep selling past a refusal.
5. The agent follows the caller's own language. It cannot be pinned to one language
   regardless of who rings.
6. The agent may never say something is sent, booked or done before it actually is.
7. The agent never names its own machinery — no "system", "database", "lookup".`

const MAX_RULES_PER_SUBMISSION = 8

router.post('/company-rules/compile', async (req, res) => {
  const { feedback, config } = req.body || {}
  if (!feedback?.trim()) {
    return res.status(400).json({ error: 'Tell us what the agent should do differently.' })
  }

  const cfg = (config && typeof config === 'object') ? config : {}
  const businessName = String(cfg.business_name || '').trim() || 'this business'
  const agentName = String(cfg.agent_name || '').trim() || 'the agent'

  const instruction = `You convert a business owner's plain-English feedback about their AI phone agent
into precise behavioural rules that are added to that agent's instructions.

THE BUSINESS: ${businessName}. Their agent is called ${agentName}.

HOW TO WRITE A RULE
- One instruction per rule. Split compound feedback into separate rules.
- Imperative and concrete: "Ask which project they are calling about before discussing
  price", never "be more focused on projects".
- Under about 20 words. No markdown, no bullet character, no heading, no preamble.
- Only what the owner actually asked for. Never invent a number, name, policy or
  detail they did not give you.
- It must still make sense read on its own, with none of their feedback around it.

WHAT YOU CANNOT ACCEPT
These already govern the agent and outrank anything a business asks for. If the
feedback can only be satisfied by breaking one, do NOT write it as a rule — reject it:
${IMMUTABLE_RULES}

Reject vague feedback too ("make it better", "sound nicer") — there is no behaviour
to write down. Put the question you need answered in the suggestion.

For every rejection give: what they asked for, a one-sentence reason in plain English
that a non-technical owner will accept without feeling blocked, and the closest thing
the agent CAN do instead.

Feedback from the owner:
"""
${String(feedback).slice(0, 4000)}
"""

Return JSON only, in exactly this shape:
{"rules":[{"text":"...","source":"..."}],"rejected":[{"text":"...","reason":"...","suggestion":"..."}]}
"source" is the part of their own feedback that produced the rule, quoted in their words.`

  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: instruction }],
      max_tokens: 900,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}')
    const str = (v, max) => String(v || '').trim().slice(0, max)

    const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
      .map(r => ({
        // The bullet is added when the layer renders; a model that includes one
        // anyway would otherwise produce "- - Ask which project…".
        text: str(r?.text, 300).replace(/^[-•*]\s*/, ''),
        source: str(r?.source, 500),
      }))
      .filter(r => r.text)
      .slice(0, MAX_RULES_PER_SUBMISSION)

    const rejected = (Array.isArray(parsed.rejected) ? parsed.rejected : [])
      .map(r => ({
        text: str(r?.text, 300),
        reason: str(r?.reason, 400),
        suggestion: str(r?.suggestion, 400),
      }))
      .filter(r => r.text && r.reason)
      .slice(0, MAX_RULES_PER_SUBMISSION)

    res.json({ rules, rejected })
  } catch (e) {
    console.error('[AGENT] company-rules compile error:', e.message)
    res.status(500).json({ error: 'Could not read that just now. Try again.' })
  }
})

// ─── Recommendations for the custom builder (sector-aware hints) ──────────────
router.get('/recommendations', (req, res) => {
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
router.get('/', async (req, res) => {
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
router.patch('/', async (req, res) => {
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
  // Keep the top-level tenant name in sync with the business name they type in
  // onboarding (this column, not config, is what admin views show). Overwrites the
  // "New Business" placeholder seeded for Google signups.
  if (typeof merged.business_name === 'string' && merged.business_name.trim()) {
    patch.name = merged.business_name.trim()
  }

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
router.post('/publish', async (req, res) => {
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
router.post('/test', async (req, res) => {
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
router.post('/test/reset', (req, res) => {
  const t = req.auth.tenantId
  const { session_id } = req.body || {}
  clearHistory(`test-${t}-${session_id || 'default'}`)
  res.json({ success: true })
})

// ─── Knowledge base (client-scoped, self-serve) ───────────────────────────────
// All scoped to the client's OWN tenant (from the token) — a client can only
// ever touch their own knowledge.

// Add knowledge by pasting text. Stored as a 'paste' document (no raw file) so
// it shows up in the documents list and can be deleted like any other.
// Body: { text, source? }
router.post('/knowledge', ingestLimiter, async (req, res) => {
  const t = req.auth.tenantId
  const { text, source } = req.body || {}
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })
  if (await knowledgeCapReached(t)) {
    return res.status(402).json({
      error: `You've reached the limit of ${MAX_DOCUMENTS} documents. Delete some, or contact us to raise it.`,
    })
  }
  try {
    const doc = await createDocument(t, {
      filename: source || 'Pasted text',
      text,
      source: 'paste',
    })
    res.json({ chunks_added: doc.chunk_count, document_id: doc.id })
  } catch (e) {
    console.error('[AGENT] client ingest error:', e.message)
    res.status(500).json({ error: 'Could not save knowledge' })
  }
})

// Upload a file (pdf/txt/docx/image/…) → store the raw file → extract text →
// ingest into this client's knowledge base as a document. Field name: "file".
router.post('/knowledge/upload', ingestLimiter, upload.single('file'), uploadErrorHandler, async (req, res) => {
  const t = req.auth.tenantId
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  // Check the real bytes, not the name the browser sent. fileFilter already
  // screened the declared type, but only this looks at the contents.
  const check = sniff(req.file, KINDS.knowledge)
  if (!check.ok) return res.status(400).json({ error: check.error })

  if (await knowledgeCapReached(t)) {
    return res.status(402).json({
      error: `You've reached the limit of ${MAX_DOCUMENTS} documents. Delete some, or contact us to raise it.`,
    })
  }

  try {
    const text = await extractTextFromFile(req.file)
    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'Could not extract any text from this file' })
    }
    const doc = await createDocument(t, {
      filename: req.file.originalname || 'upload',
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      text,
      source: 'upload',
    })
    res.json({
      document_id: doc.id,
      filename: doc.filename,
      chunks_added: doc.chunk_count,
      chars: text.length,
    })
  } catch (e) {
    console.error('[AGENT] kb upload error:', e.message)
    // Return the real reason. "Could not process file" gave the client nothing to
    // act on — an upload that embedded zero chunks was indistinguishable from one
    // that worked, and the only explanation lived in a server log.
    res.status(500).json({ error: e.message || 'Could not process file' })
  }
})

// ── Documents (file-level management) ────────────────────────────────────────

// List the client's uploaded documents (files + pastes).
router.get('/documents', async (req, res) => {
  try {
    res.json(await listDocuments(req.auth.tenantId))
  } catch (e) {
    console.error('[AGENT] list documents error:', e.message)
    res.status(500).json({ error: 'Could not load documents' })
  }
})

// Short-lived signed URL to view/download the original file.
router.get('/documents/:id/url', async (req, res) => {
  const url = await getDocumentUrl(req.auth.tenantId, req.params.id)
  if (!url) return res.status(404).json({ error: 'No file for this document' })
  res.json({ url })
})

// Delete a document — cascades to its chunks and removes the Storage file.
router.delete('/documents/:id', async (req, res) => {
  try {
    const result = await deleteDocument(req.auth.tenantId, req.params.id)
    if (!result.success) return res.status(404).json({ error: 'Document not found' })
    res.json({ success: true })
  } catch (e) {
    console.error('[AGENT] delete document error:', e.message)
    res.status(500).json({ error: 'Could not delete document' })
  }
})

// ── Chunk-level (kept for inspection / backward compatibility) ───────────────

// List the client's knowledge chunks
router.get('/knowledge', async (req, res) => {
  const t = req.auth.tenantId
  const { data, error } = await supabase
    .from('knowledge_base')
    .select('id, content, source, created_at, document_id')
    .eq('tenant_id', t)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Could not load knowledge' })
  res.json(data || [])
})

// Delete one chunk (must belong to this tenant)
router.delete('/knowledge/:chunkId', async (req, res) => {
  const t = req.auth.tenantId
  const { error } = await supabase
    .from('knowledge_base').delete()
    .eq('id', req.params.chunkId).eq('tenant_id', t)
  if (error) return res.status(500).json({ error: 'Could not delete chunk' })
  invalidateKnowledge(t)
  res.json({ success: true })
})

// Clear all of the client's knowledge (documents + chunks + Storage files)
router.delete('/knowledge', async (req, res) => {
  try {
    await clearAllDocuments(req.auth.tenantId)
    res.json({ success: true })
  } catch (e) {
    console.error('[AGENT] clear knowledge error:', e.message)
    res.status(500).json({ error: 'Could not clear knowledge' })
  }
})

// ─── Live data lookups (orders, dues, bookings…) ─────────────────────────────
// The dynamic counterpart to the knowledge base: per-caller data the agent fetches
// at call time. A lookup is either backed by the client's own REST API ('http')
// or by a data sheet they upload here ('table'). Config lives in tenants.config.lookups;
// uploaded sheets live in the lookup_rows table.

// Get the client's lookup config + a summary of any uploaded datasets.
router.get('/lookups', async (req, res) => {
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
router.patch('/lookups', async (req, res) => {
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
// Body/Query: { dataset, mode? } — mode 'append' adds to what is already there;
// the default 'replace' wipes the dataset first, which is what a full re-export
// wants but is destructive of anything added since.
router.post('/lookups/dataset', ingestLimiter, datasetUpload.single('file'), uploadErrorHandler, async (req, res) => {
  const t = req.auth.tenantId
  if (req.file) {
    const check = sniff(req.file, KINDS.tabular)
    if (!check.ok) return res.status(400).json({ error: check.error })
  }
  const dataset = (req.body?.dataset || req.query?.dataset || '').toString().trim()
  if (!dataset) return res.status(400).json({ error: 'dataset name is required' })
  const mode = (req.body?.mode || req.query?.mode || 'replace').toString()

  // Parsed by format, not by assuming CSV: the type check above accepts Excel,
  // and decoding an .xlsx as text yields rows of zip binary that then REPLACE the
  // client's real data without erroring.
  let rows = []
  try {
    if (req.file) {
      rows = await parseSheetFile(req.file.buffer, req.file.originalname, req.file.mimetype)
    } else if (String(req.body?.csv || '').trim()) {
      rows = parseCSV(String(req.body.csv))
    } else {
      return res.status(400).json({ error: 'Provide a CSV or Excel file, or csv text' })
    }
  } catch (e) {
    console.error('[AGENT] dataset parse error:', e.message)
    return res.status(422).json({ error: 'Could not read that file. Save it as CSV or Excel and try again.' })
  }

  if (!rows.length) {
    return res.status(422).json({ error: 'Could not read any rows. The first row must be the column names.' })
  }

  try {
    const { rows_added } = await ingestDataset(t, dataset, rows, { replace: mode !== 'append' })
    res.json({ dataset, rows_added, mode: mode === 'append' ? 'append' : 'replace', columns: Object.keys(rows[0]) })
  } catch (e) {
    console.error('[AGENT] dataset upload error:', e.message)
    res.status(500).json({ error: 'Could not save dataset' })
  }
})

// Delete an uploaded dataset.
router.delete('/lookups/dataset/:dataset', async (req, res) => {
  const t = req.auth.tenantId
  await deleteDataset(t, req.params.dataset)
  res.json({ success: true })
})

// ─── Editing the rows of an uploaded dataset ─────────────────────────────────
// Without these, correcting one wrong phone number means re-uploading the entire
// sheet — and since upload replaces, anything added since the last export is lost.
//
// Every handler passes the tenant id down to the query; the service keeps it in
// the WHERE clause of both reads and writes. These routes sit under /lookups, so
// the permission table at the top of this file already covers them: GET needs
// knowledge:read, the rest need knowledge:write.

// Browse/search a dataset. Query: { q?, limit?, offset? }
router.get('/lookups/dataset/:dataset/rows', async (req, res) => {
  try {
    const out = await listDatasetRows(req.auth.tenantId, req.params.dataset, {
      q: req.query.q, limit: req.query.limit, offset: req.query.offset,
    })
    res.json(out)
  } catch (e) {
    console.error('[AGENT] list dataset rows error:', e.message)
    res.status(500).json({ error: 'Could not load rows' })
  }
})

// Add one row.
router.post('/lookups/dataset/:dataset/rows', async (req, res) => {
  try {
    const created = await createDatasetRow(req.auth.tenantId, req.params.dataset, req.body?.row)
    res.status(201).json(created)
  } catch (e) {
    // Only a refusal normalizeRow raised is safe to echo back; a DB error is not.
    if (!e.invalid) {
      console.error('[AGENT] create dataset row error:', e.message)
      return res.status(500).json({ error: 'Could not add the row' })
    }
    res.status(400).json({ error: e.message })
  }
})

// Replace one row's contents.
router.patch('/lookups/dataset/:dataset/rows/:id', async (req, res) => {
  try {
    const updated = await updateDatasetRow(
      req.auth.tenantId, req.params.dataset, req.params.id, req.body?.row,
    )
    if (!updated) return res.status(404).json({ error: 'That row no longer exists' })
    res.json(updated)
  } catch (e) {
    if (!e.invalid) {
      console.error('[AGENT] update dataset row error:', e.message)
      return res.status(500).json({ error: 'Could not save the row' })
    }
    res.status(400).json({ error: e.message })
  }
})

// Remove one row.
router.delete('/lookups/dataset/:dataset/rows/:id', async (req, res) => {
  try {
    const removed = await deleteDatasetRow(req.auth.tenantId, req.params.dataset, req.params.id)
    if (!removed) return res.status(404).json({ error: 'That row no longer exists' })
    res.json({ success: true })
  } catch (e) {
    console.error('[AGENT] delete dataset row error:', e.message)
    res.status(500).json({ error: 'Could not delete the row' })
  }
})

export default router