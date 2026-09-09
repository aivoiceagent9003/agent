// llm.js

import OpenAI from 'openai'
import { buildLookupTools, runLookup } from './lookups.js'
import { buildContext, buildAgentPrompt } from '../config/conversation/index.js'
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
//
// The prompt itself lives in src/config/conversation — a layered, modular rule set
// (safety → core → conversation → speech → template → business → call context →
// knowledge → tools). This function is now just the adapter that maps the legacy
// call signature onto that framework, and it is kept because the whole codebase and
// the tests call it.
//
// Everything that used to be inline here — the voice rules, the name rules, the
// lookup rules, the handoff block, the compliance block, and the real-estate/generic
// sector switch — moved into those modules. The sector switch is gone entirely:
// property behaviour now lives only in the real-estate TEMPLATE, so no tenant can
// inherit square footage and RERA by accident.

/**
 * @param {object} tenantConfig merged tenant + campaign config
 * @param {object} opts
 * @param {boolean} [opts.speechToSpeech] the live engine speaks directly
 * @param {string}  [opts.knowledge] retrieved text to inline (cascade path only)
 * @param {object}  [opts.language] { modelLed, locked, opening }
 * @param {object}  [opts.conversationState] a ConversationState, for reconnects
 * @param {boolean} [opts.whatsapp] WhatsApp sending is wired for this tenant
 * @returns {string} the composed system instruction
 */
function buildSystemPrompt(tenantConfig = {}, opts = {}) {
  return buildAgentPrompt(buildContext(tenantConfig, {
    channel: opts.speechToSpeech ? 'speech' : 'text',
    knowledge: opts.knowledge,
    language: opts.language,
    conversationState: opts.conversationState,
    whatsapp: opts.whatsapp,
  }))
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
  knowledge = '',
  onToolCall = null   // fired when the model decides to run a lookup (a real
                      // multi-second round-trip) — lets the caller play a
                      // contextual "let me check that" filler ONLY then.
) {
  const history = getHistory(callSid)

  history.push({
    role: 'user',
    content: userText,
  })

  let fullText = ''

  try {
    // RAG text is a LAYER, not an append. The builder places it after the
    // business instructions and before the tool rules, so it can never outrank a
    // safety rule by virtue of being the last thing in the prompt.
    const systemPrompt = buildSystemPrompt(tenantConfig, { knowledge })

    const messages = toOpenAIMessages(systemPrompt, history.slice(-12))
    const t0 = Date.now()

    const model =
      tenantConfig.openai_model ||
      process.env.OPENAI_MODEL ||
      'gpt-4o-mini'

    // Expose the tenant's configured lookups as tools. Empty for tenants that
    // don't use the feature — in which case this behaves exactly like before.
    const tools = buildLookupTools(tenantConfig)
    const useTools = tools.length > 0

    let firstToken = true

    // ── Agentic loop ──────────────────────────────────────────────────────────
    // Most turns finish in one round (model streams the spoken answer). When the
    // model needs live data it emits tool_calls instead of text; we run the
    // lookup, append the result, and loop so it can answer with the real data.
    // A filler ("one moment, let me check") plays automatically while this extra
    // round-trip happens — see deepgram.js fillerTimer.
    const MAX_TOOL_ROUNDS = 4
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const params = {
        model,
        messages,
        max_tokens: 150,
        temperature: 0.3,
        top_p: 0.8,
        stream: true,
      }
      // Offer tools on every round except the last — on the final round we force
      // a text answer so the turn never ends on an unanswered tool request.
      if (useTools && round < MAX_TOOL_ROUNDS - 1) {
        params.tools = tools
        params.tool_choice = 'auto'
      }

      const stream = await ai.chat.completions.create(params, { signal })
      if (round === 0) console.log(`[LLM] Request sent in ${Date.now() - t0}ms`)

      const toolCalls = []   // accumulated across deltas, indexed by tc.index
      let finishReason = null
      let roundText = ''

      for await (const chunk of stream) {
        if (signal?.aborted) {
          console.log('[LLM] Stream interrupted')
          break
        }

        const choice = chunk.choices[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta || {}

        // Accumulate streamed tool-call deltas (id/name arrive first, arguments
        // stream in fragments that must be concatenated).
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }
            }
            if (tc.id) toolCalls[idx].id = tc.id
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
          }
        }

        const token = delta.content || ''
        if (!token) continue

        if (firstToken) {
          console.log(`[LLM] TTFT: ${Date.now() - t0}ms`)
          firstToken = false
        }

        // Yield raw tokens (Telugu/Hindi safe — no per-token spacing)
        fullText += token
        roundText += token
        yield token
      }

      // Model wants to call tools → run them, append results, and loop so it can
      // answer using the real data. If we hit the round cap the model just
      // answers without further tools.
      const calls = toolCalls.filter(Boolean)
      if (finishReason === 'tool_calls' && calls.length && round < MAX_TOOL_ROUNDS - 1) {
        // A lookup is about to run (extra ~1-2s). Signal the caller so it can play
        // a short, honest "let me check" filler — the one moment a filler helps.
        if (onToolCall) { try { onToolCall() } catch { /* never break the turn */ } }
        messages.push({ role: 'assistant', content: roundText || null, tool_calls: calls })
        for (const tc of calls) {
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed args */ }
          const result = await runLookup(tenantConfig, tc.function.name, args)
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) })
        }
        continue
      }

      // No tool call (or cap reached) — the spoken answer is fully streamed.
      break
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