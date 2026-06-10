// leads.js — Day 8: Lead extraction
// After a call ends, send the full conversation to the LLM to extract
// structured lead data, then save it to the Supabase `leads` table.
// Runs POST-call so it adds ZERO latency to the live conversation.

import OpenAI from 'openai'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── Extraction prompt ────────────────────────────────────────────────────────
// We ask the LLM to return STRICT JSON only — no prose, no markdown.

function buildExtractionPrompt(tenantConfig = {}) {
  const businessName = tenantConfig.business_name || 'the business'

  return `You are a data extraction assistant for ${businessName}.
Analyze the call transcript and extract structured lead information.

Return ONLY a valid JSON object (no markdown, no backticks, no explanation) with these exact fields:
{
  "name": "caller's name in ENGLISH/Latin script, else null",
  "intent": "short snake_case category (e.g. order_complaint, product_inquiry, booking_request, support, billing, general_inquiry)",
  "summary": "one-sentence summary of what the caller wanted",
  "sentiment": "positive | neutral | frustrated | angry",
  "language": "primary language used: en | hi | te | ta | kn | other",
  "key_details": ["array", "of", "important facts mentioned"],
  "follow_up_needed": true or false,
  "handed_off": true or false,
  "contact_info": "any phone/email/order number mentioned, else null"
}

Rules:
- Output ONLY the JSON object, nothing else
- Use null for missing fields, not empty strings
- IMPORTANT: The "name" field MUST be in English/Latin script. If the transcript
  shows the name in Devanagari or another script (e.g. "मधु सुधन"), transliterate
  it to English/Roman letters (e.g. "Madhu Sudhan"). Never output a name in a
  non-Latin script.
- Write "summary" and "key_details" in English regardless of the call language.
- Keep summary under 20 words
- key_details should be 2-5 short factual points`
}

// ─── Extract lead from conversation history ───────────────────────────────────
// `history` is the array from llm.js getHistory(callSid): [{role, content}, ...]

export async function extractLead(history, tenantConfig = {}) {
  // Build a readable transcript from the conversation history
  if (!history || history.length === 0) {
    console.log('[LEAD] No conversation to extract from')
    return null
  }

  const transcript = history
    .map(m => `${m.role === 'assistant' ? 'Agent' : 'Caller'}: ${m.content}`)
    .join('\n')

  console.log('[LEAD] Extracting from transcript...')
  const t0 = Date.now()

  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildExtractionPrompt(tenantConfig) },
        { role: 'user', content: `Call transcript:\n\n${transcript}` },
      ],
      max_tokens: 300,
      temperature: 0.2,  // low temp for consistent structured output
      response_format: { type: 'json_object' },  // forces valid JSON
    })

    const raw = completion.choices[0]?.message?.content || '{}'
    const lead = JSON.parse(raw)

    console.log(`[LEAD] ✅ Extracted in ${Date.now() - t0}ms:`, JSON.stringify(lead))
    return lead

  } catch (err) {
    console.error('[LEAD] ❌ Extraction failed:', err.message)
    return null
  }
}

// ─── Save lead to Supabase ────────────────────────────────────────────────────

export async function saveLead(supabase, { tenantId, callId, callerNumber, lead }) {
  if (!lead) return

  try {
    const { error } = await supabase
      .from('leads')
      .insert({
        tenant_id: tenantId,
        call_id: callId,
        caller_number: callerNumber,
        name: lead.name || null,
        intent: lead.intent || null,
        summary: lead.summary || null,
        sentiment: lead.sentiment || null,
        language: lead.language || null,
        key_details: lead.key_details || [],
        follow_up_needed: lead.follow_up_needed ?? false,
        handed_off: lead.handed_off ?? false,
        contact_info: lead.contact_info || null,
        raw_data: lead,  // store the full JSON too
      })

    if (error) {
      console.error('[LEAD] ❌ Save failed:', error.message)
    } else {
      console.log('[LEAD] 💾 Saved to Supabase')
    }
  } catch (err) {
    console.error('[LEAD] ❌ Save error:', err.message)
  }
}