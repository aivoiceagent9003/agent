// llm.js

import OpenAI from 'openai'
import { buildLookupTools, runLookup } from './lookups.js'
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

function buildSystemPrompt(tenantConfig = {}, opts = {}) {
  const {
    business_name = 'Our Company',
    agent_name = 'Alex',
    purpose = 'assist callers',
    response_language = process.env.RESPONSE_LANGUAGE || 'English',
    allow_multilingual = true,
    enable_handoff = true,
    system_prompt = null,   // from a template or the prompt generator
  } = tenantConfig

  // In speech-to-speech mode the model hears + speaks directly (no translation
  // layer), so it must mirror the caller's language itself. In the legacy
  // pipeline, translation is external, so the LLM always works in English.
  const languageRule = opts.speechToSpeech
    ? 'Reply in the SAME base language the caller speaks and mirror it every turn — Telugu→Telugu, Hindi→Hindi, English→English; never switch your whole reply back to English on your own. BUT speak the natural, everyday CODE-MIXED register real Indians use on the phone (Tinglish / Hinglish), NOT formal literary language: keep common English business and technical words IN ENGLISH — "units", "price", "size", "sq ft", "crore", "lakhs", "booking", "site visit", "clubhouse", "swimming pool", "amenities", "3BHK", "loan", "EMI", "possession", "RERA" — plus all project and place names. Do NOT translate these into bookish Telugu/Hindi words. The grammar and connective words stay in the caller\'s language; the English terms stay in English. Example (Telugu caller): "My Home Apas lo 3BHK units 2400 to 2800 sq ft untayi, price 2.8 crore nunchi start avutundi" — not a fully translated literary sentence.'
    : allow_multilingual
      ? 'Caller speech is translated to English before reaching you. Always reply in clear, natural English — translation back to the caller\'s language is handled automatically.'
      : `Always reply only in ${response_language}`

  // Universal voice rules + handoff are ALWAYS appended, whether the role text
  // comes from a stored system_prompt (template/generated) or the built fields.
  // ── Live data lookups ──────────────────────────────────────────────────────
  // If the tenant configured any lookups (orders, dues, bookings…), tell the LLM
  // to USE the tools for caller-specific facts instead of guessing. Tools are
  // exposed separately in streamAIReply; this is just the behavioural rule.
  const hasLookups =
    tenantConfig.enable_lookups !== false &&
    Array.isArray(tenantConfig.lookups) &&
    tenantConfig.lookups.length > 0
  const lookupRule = hasLookups
    ? `
LIVE DATA LOOKUPS:
- You can look up real-time, caller-specific details (orders, payments, bookings, etc.) using the available tools.
- When a caller asks about THEIR specific record, call the matching tool — never guess or invent details.
- Order numbers and other alphanumeric IDs are easily misheard on a phone line. The FIRST time a caller gives one, read it back character-by-character to confirm BEFORE looking it up, e.g. "Let me confirm, that's O-R-D-1-0-0-2, is that correct?" Only call the tool once they confirm.
- A lookup that returns nothing almost always means the ID was misheard. Apologise, read back what you heard, and ask the caller to repeat it slowly, one character at a time. Then retry the lookup with the corrected value before giving up.
- Names are the exception to "don't make them repeat it" — see NAME CAPTURE below. Always read a name back once.
- Only ask a question if a needed detail is genuinely missing, and ask for just that ONE detail.
- After the tool returns a match, read back only the relevant facts in one or two short sentences.
- If repeated attempts still fail, apologise briefly and offer to take down their details or hand off.`
    : ''

  const handoffRule = enable_handoff
    ? `
HUMAN HANDOFF:
- Use [HANDOFF] ONLY if the caller explicitly asks for a human/agent/manager/representative
- Use [HANDOFF] if the caller is clearly frustrated after 2+ turns where you genuinely could not help
- Do NOT use [HANDOFF] for normal property/product questions — answer from the knowledge base first
- Do NOT use [HANDOFF] just because a caller asks for details, prices, or configurations
- If a specific detail isn't in the knowledge base, ask a clarifying question or offer what you do know
Example: "Let me connect you with our team. [HANDOFF]"
Never use [HANDOFF] for questions you can answer or partially answer.`
    : ''

  // Name capture is UNIVERSAL — it lives here rather than in the templates because
  // the templates only asked for a name inside their closing/booking step, so any
  // call that didn't reach a booking ended anonymously. Every call needs a name.
  //
  // The read-back rule matters as much as the asking: Indian names over an 8kHz
  // phone line are the single most misheard thing on a call, and the model's
  // instinct is to "repair" an unfamiliar name into a familiar-sounding word.
  const nameRule = `
NAME CAPTURE (every call — not only bookings):
- The caller's name is a REQUIRED outcome of EVERY call. A call that ends without a name has failed, even if you answered every question perfectly.
- Ask EARLY — right after you've understood what they want, NOT at the end of the call. Waiting until the close means you lose the name entirely whenever the caller hangs up early.
- Ask ONCE, warmly, as its own short question: "And may I know your name?" / "Mee peru cheppagalara?" / "Aapka naam jaan sakta hoon?"
- Never interrogate. If they dodge or decline, drop it instantly and continue helping. You may ask once more near the end, never a third time.
- If they already gave their name, NEVER ask again.

GETTING THE NAME RIGHT (names are the most misheard thing on a phone call):
- Expect INDIAN names. Do NOT "repair" what you heard into a similar-sounding English word or a more familiar name — if it sounded like an unusual name, it IS an unusual name. Never turn a name into an English word that happens to sound like it.
- ALWAYS read the name back immediately, as its own beat, to confirm: "Madhusudhan — did I get that right?" Do this EVERY time, even when you think you heard it clearly. This one read-back is what makes the captured name usable.
- If the caller corrects you, take their correction EXACTLY as given and read it back once more. Never re-substitute your original guess afterwards.
- If you still can't catch it after two attempts, ask them to say it slowly, one part at a time: "Could you say it slowly for me, part by part?" Then read back what you assembled.
- If it remains unclear after that, use what you have and move on — never let a name block the conversation or make the caller feel interrogated.
- Once confirmed, USE the name naturally through the rest of the call — it is warmer than any honorific, and it proves to the caller you heard them.
- Write the name as it is SPOKEN in the caller's own language. Never translate a name.`

  const voiceRules = `
VOICE CALL RULES (apply to every response, regardless of topic):
- Speak naturally — warm, consultative, never robotic or scripted
- Keep each sentence SHORT (under 12 words) — callers on a phone call cannot re-read
- Ask ONE question per response — never list multiple questions in a single turn
- No markdown, no bullet points, no numbered lists — voice cannot render them
- No paragraph breaks or blank lines — replies must be continuous flowing sentences
- NEVER give a number range — not for price, not for size: "starts at 2.8 crore" not "2.8 to 3.4 crore"; "from 2400 sq ft" not "2400 to 2800 sq ft"
- NEVER use comma-formatted numbers: write "2400 sq ft" not "2,400 sq ft"
- Do NOT assume the caller's gender. NEVER say "sir" or "madam" unless the caller has clearly revealed their gender. When you do address them, use a GENDER-NEUTRAL honorific in their language — Telugu "andi", Hindi/Urdu "ji". Use it SPARINGLY and naturally — at most once in a while (e.g. the greeting or one key question), NEVER at the end of every sentence. MOST sentences should carry no honorific at all; tone alone keeps it respectful. Prefer the caller's name once you know it. (Never use "garu".)
- Give facts from the knowledge base only — never guess or make up numbers/details
- NEVER re-ask something the caller already answered — always read the full conversation history before asking a question
${tenantConfig.generic_agent ? '' : `- Once location, apartment type, and budget are known, stop asking discovery questions and start recommending projects
- NEVER ask about timeline, move-in date, or purpose — go straight to recommending once location, type, and budget are known
- When recommending projects, skip any intro sentence and use exactly this 3-sentence format: "[Project A] in [location] starts at [price]. [Project B] starts at [price]. Which one interests you?" (no "sir/madam"; a gentle "andi"/"ji" is fine only occasionally, not every line)`}
- ${languageRule}
- If user says bye: "Thank you for calling. Have a wonderful day!"
${nameRule}
${lookupRule}
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
    let systemPrompt = buildSystemPrompt(tenantConfig)

    // ── RAG: inject retrieved knowledge into the system prompt ──────────────
    // If relevant knowledge was found for this tenant, give it to the LLM and
    // instruct it to answer from that knowledge. Empty knowledge = no change.
    if (knowledge && knowledge.trim()) {
      systemPrompt += `

KNOWLEDGE BASE (use this to answer the caller's question accurately):
${knowledge}

When the answer is in the knowledge base above, use it. If the caller asks
something not covered, warmly say you'll find out — never say you "can only" do something.`
    }
    // ────────────────────────────────────────────────────────────────────────

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