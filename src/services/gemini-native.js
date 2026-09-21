// gemini-native.js — Gemini's own streaming API, wearing the OpenAI chat interface.
//
// The cascade talks to its brain through `chat.completions.create({stream: true})` and
// reads OpenAI-shaped chunks. That is worth keeping: the turn loop in soniox-cascade.js
// handles tool-call accumulation, abort, usage and finish reasons, and none of that
// should have to learn a second dialect.
//
// So why not just keep using Google's OpenAI-compatible endpoint? Because it refuses the
// one thing we came for: `cached_content` is rejected with a 400 there, and explicit
// caching is the only caching gemini-3.5-flash-lite does. Measured, the native endpoint
// is also slightly faster than the compatibility shim (~1007ms vs ~1160ms to first
// token, streaming, same prompt).
//
// This module converts in both directions and nothing else:
//   OpenAI messages  → Gemini contents + systemInstruction
//   Gemini SSE       → OpenAI chunks
//
// Tool calls are the fiddly part. OpenAI streams tool arguments as string fragments and
// identifies each call by an id it invents; Gemini hands over a whole `functionCall` at
// once and uses the function NAME as the identity. The ids here are synthesised and
// carry the name inside them, so a later tool RESULT can be matched back to the call it
// answers without keeping state between requests.

const API = 'https://generativelanguage.googleapis.com/v1beta'

/** Ids are synthesised, and the tool name is carried inside so results can be matched. */
const callId = (name, i) => `gcall_${i}_${name}`
const nameFromCallId = (id) => String(id || '').replace(/^gcall_\d+_/, '')

/**
 * OpenAI messages → Gemini contents.
 *
 * System messages are returned separately: Gemini takes them as `systemInstruction`,
 * and when a cache is in play they are dropped entirely because the cache already holds
 * them (passing both is an error).
 */
export function toGeminiContents(messages) {
  const system = messages.filter(m => m.role === 'system')
    .map(m => String(m.content || '')).join('\n\n')
  const contents = []

  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // A tool result is a user-role turn in Gemini. The name has to be the one that
      // was called, which is why the id carries it.
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: nameFromCallId(m.tool_call_id),
            // Gemini requires an object here; the tools return plain strings.
            response: { result: String(m.content ?? '') },
          },
        }],
      })
      continue
    }

    const parts = []
    if (m.content) parts.push({ text: String(m.content) })
    for (const tc of m.tool_calls || []) {
      let args = {}
      try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* malformed — send empty */ }
      parts.push({ functionCall: { name: tc.function?.name, args } })
    }
    if (!parts.length) continue
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }

  return { system, contents }
}

/**
 * Stream a completion, yielding OpenAI-shaped chunks.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {object[]} p.messages          OpenAI-shaped
 * @param {object[]} [p.tools]           OpenAI-shaped tool definitions
 * @param {string} [p.cachedContent]     'cachedContents/...' — replaces system + tools
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 */
export async function* streamGemini({
  apiKey, model, messages, tools, cachedContent,
  temperature = 0.3, maxTokens = 400, signal,
}) {
  const { system, contents } = toGeminiContents(messages)
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  }
  if (cachedContent) {
    // The cache already holds the system instruction and the tool declarations. Sending
    // either again alongside it is rejected.
    body.cachedContent = cachedContent
  } else {
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    if (tools?.length) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }]
    }
  }

  const res = await fetch(`${API}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`)
    err.status = res.status
    err.cachedContent = cachedContent || null
    throw err
  }

  let buf = ''
  let toolIndex = 0
  for await (const part of res.body) {
    if (signal?.aborted) return
    buf += Buffer.from(part).toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      let j
      try { j = JSON.parse(line.slice(5).trim()) } catch { continue }

      const cand = j.candidates?.[0]
      for (const p of cand?.content?.parts || []) {
        if (p.text) yield { choices: [{ index: 0, delta: { content: p.text } }] }
        if (p.functionCall) {
          const i = toolIndex++
          // Emitted whole rather than in fragments — the accumulator on the other side
          // concatenates, so one complete piece is a valid special case of that.
          yield {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: callId(p.functionCall.name, i),
                  type: 'function',
                  function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
                }],
              },
            }],
          }
        }
      }

      if (cand?.finishReason) {
        yield {
          choices: [{
            index: 0,
            delta: {},
            // Gemini says STOP for a tool round too; the cascade keys off the presence
            // of tool calls rather than this, so a straight mapping is honest enough.
            finish_reason: cand.finishReason === 'STOP' ? 'stop' : String(cand.finishReason).toLowerCase(),
          }],
        }
      }

      if (j.usageMetadata) {
        const u = j.usageMetadata
        yield {
          choices: [],
          usage: {
            prompt_tokens: u.promptTokenCount || 0,
            completion_tokens: u.candidatesTokenCount || 0,
            total_tokens: u.totalTokenCount || 0,
            prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount || 0 },
          },
        }
      }
    }
  }
}
