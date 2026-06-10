// api/agent.js — Agent builder endpoints (client self-serve)
// - List/get pre-built templates
// - Generate a system prompt from a plain-English description (Auto Build)
// - Test the agent in the browser (no phone call) using its real config + RAG
// - Save (draft) and publish the client's agent config

import { Router } from 'express'
import OpenAI from 'openai'
import { supabase } from './db.js'
import { requireClient } from './auth.js'
import { TEMPLATES, getTemplate } from './templates.js'
import { buildSystemPrompt, streamAIReply, clearHistory } from '../services/llm.js'
import { retrieveKnowledge } from '../services/rag.js'
import { ingestText } from '../ingest.js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const router = Router()

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
router.get('/voices', requireClient(), (req, res) => {
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

export default router