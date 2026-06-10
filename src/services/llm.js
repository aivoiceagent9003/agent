// llm.js

import OpenAI from 'openai'
import 'dotenv/config'

const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// ─── Warmup ───────────────────────────────────────────────────────────────
// Fire a tiny completion when the call starts so the first REAL request isn't
// a cold start (which was taking ~1700ms vs ~640ms warm). Best-effort.
async function warmupLLM() {
  try {
    await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })
    console.log('[LLM] Warmed up ✅')
  } catch {
    /* ignore — warmup is best-effort */
  }
}

// ─────────────────────────────────────────────────────────────
// MEMORY
// ─────────────────────────────────────────────────────────────

const conversations = new Map()

function getHistory(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, [])
  }
  return conversations.get(callSid)
}

function clearHistory(callSid) {
  conversations.delete(callSid)
}

// ─────────────────────────────────────────────────────────────
// PROMPT
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(tenantConfig = {}) {
  const {
    business_name = 'Our Company',
    agent_name = 'Alex',
    purpose = 'assist callers',
    response_language = process.env.RESPONSE_LANGUAGE || 'English',
    allow_multilingual = true,
    enable_handoff = true,
    system_prompt = null,   // from a template or the prompt generator
  } = tenantConfig

  const languageRule = allow_multilingual
    ? 'Reply in the same language as the user. If they speak Telugu, reply in natural Telugu. If Hindi, reply in Hindi. Never transliterate or split words.'
    : `Always reply only in ${response_language}`

  // Universal voice rules + handoff are ALWAYS appended, whether the role text
  // comes from a stored system_prompt (template/generated) or the built fields.
  const handoffRule = enable_handoff
    ? `
HUMAN HANDOFF:
- If the caller explicitly asks for a human, agent, manager, or representative, OR
- If the caller is frustrated, angry, or you genuinely cannot help with their request, OR
- If the request is outside your role (refunds, legal, complaints you can't resolve),
THEN respond with a brief polite sentence AND include the exact token [HANDOFF] at the end.
Example: "Let me connect you with a team member who can help. [HANDOFF]"
Only use [HANDOFF] when truly needed — not for normal questions you can answer.`
    : ''

  const voiceRules = `
RULES:
- Reply in ONE short sentence. Be brief and direct.
- Give only the specific fact asked for — a price, a location, a date — not everything
- Do NOT add a follow-up question or "would you like to know more" at the end
- Do NOT volunteer extra details the caller didn't ask for
- Only state facts from the knowledge base. If a detail isn't there, say you'll connect them to the team — never guess numbers or dates
- ${languageRule}
- No markdown, no lists, no preamble, no filler
- Confirm numbers carefully
- If user says bye:
  "Happy to help, goodbye!"
${handoffRule}`.trim()

  // If a full system_prompt is stored (template or generated), use it as the
  // ROLE/persona, then append the universal voice + handoff rules so behaviour
  // stays consistent across all agents.
  if (system_prompt && system_prompt.trim()) {
    return `${system_prompt.trim()}\n\n${voiceRules}`
  }

  // Otherwise build from the individual fields (legacy / simple path).
  return `
You are ${agent_name}, a realtime AI voice agent for ${business_name}.

ROLE:
${purpose}

${voiceRules}
`.trim()
}

// ─────────────────────────────────────────────────────────────
// OPENAI FORMAT
// ─────────────────────────────────────────────────────────────

function toOpenAIMessages(systemPrompt, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
  ]

  for (const msg of history) {
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    })
  }

  return messages
}

// ─────────────────────────────────────────────────────────────
// CLEAN TEXT
// ─────────────────────────────────────────────────────────────

function cleanText(text = '') {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\.\.+/g, '.')
    .replace(/\s([?.!,])/g, '$1')
    .trim()
}

// ─────────────────────────────────────────────────────────────
// STREAMING LLM
// ─────────────────────────────────────────────────────────────

async function* streamAIReply(
  callSid,
  userText,
  tenantConfig = {},
  signal,
  knowledge = ''
) {
  const history = getHistory(callSid)

  history.push({
    role: 'user',
    content: userText,
  })

  let fullText = ''

  try {
    let systemPrompt = buildSystemPrompt(tenantConfig)

    // ── RAG: inject retrieved knowledge into the system prompt ──────────────
    // If relevant knowledge was found for this tenant, give it to the LLM and
    // instruct it to answer from that knowledge. Empty knowledge = no change.
    if (knowledge && knowledge.trim()) {
      systemPrompt += `

KNOWLEDGE BASE (use this to answer the caller's question accurately):
${knowledge}

When the answer is in the knowledge base above, use it. If the caller asks
something not covered, say you'll connect them to someone who can help.`
    }
    // ────────────────────────────────────────────────────────────────────────

    const messages = toOpenAIMessages(systemPrompt, history.slice(-6))
    const t0 = Date.now()

    const stream = await ai.chat.completions.create({
      model:
        tenantConfig.openai_model ||
        process.env.OPENAI_MODEL ||
        'gpt-4o-mini',
      messages,
      max_tokens: 50,
      temperature: 0.3,
      top_p: 0.8,
      stream: true,
    }, { signal })

    console.log(`[LLM] Request sent in ${Date.now() - t0}ms`)

    let firstToken = true

    for await (const chunk of stream) {
      if (signal?.aborted) {
        console.log('[LLM] Stream interrupted')
        break
      }

      const token = chunk.choices[0]?.delta?.content || ''
      if (!token) continue

      if (firstToken) {
        console.log(`[LLM] TTFT: ${Date.now() - t0}ms`)
        firstToken = false
      }

      // Yield raw tokens (Telugu/Hindi safe — no per-token spacing)
      fullText += token
      yield token
    }

    fullText = cleanText(fullText)
    console.log(`[LLM] Agent: "${fullText}" (${Date.now() - t0}ms total)`)

  } catch (err) {
    if (signal?.aborted) {
      console.log('[LLM] Aborted safely')
      return
    }

    console.error('[LLM] OpenAI error:', err.message)
    fullText = 'Could you repeat that?'
    yield fullText

  } finally {
    if (!signal?.aborted && fullText.trim()) {
      history.push({
        role: 'assistant',
        content: cleanText(fullText),
      })
    }
  }
}

export {
  streamAIReply,
  clearHistory,
  getHistory,
  buildSystemPrompt,
  warmupLLM,
}