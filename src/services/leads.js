// leads.js — Day 8: Lead extraction
// After a call ends, send the full conversation to the LLM to extract
// structured lead data, then save it to the Supabase `leads` table.
// Runs POST-call so it adds ZERO latency to the live conversation.

import OpenAI from 'openai'
import { toCode } from './language-manager.js'
import 'dotenv/config'

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── Extraction prompt ────────────────────────────────────────────────────────
// We ask the LLM to return STRICT JSON only — no prose, no markdown.

// The LanguageManager is canonical in ISO codes now, but calls recorded before
// that change persisted full names ('Telugu'). toCode() accepts either, so a
// call started on the old build still resolves correctly.

function buildExtractionPrompt(tenantConfig = {}, knownLanguage = null) {
  const businessName = tenantConfig.business_name || 'the business'
  const knownCode = toCode(knownLanguage)
  // When the live classifier reached a verdict it is a direct measurement of the
  // audio. Asking the model to re-derive it from a transcript can only be worse,
  // and in practice was: a call conducted entirely in English came back as "hi".
  const languageRule = knownCode
    ? 'a live classifier already MEASURED this call as "' + knownCode + '". Copy that value exactly. Do NOT re-infer it from the transcript.'
    : "infer the caller's real language from what the AGENT chose to speak (the agent mirrors the caller), NOT from the caller transcription."

  return `You are a data extraction assistant for ${businessName}.
Analyze the call transcript and extract structured lead information.

Return ONLY a valid JSON object (no markdown, no backticks, no explanation) with these exact fields:
{
  "name": "caller's name in ENGLISH/Latin script, else null",
  "intent": "short snake_case category (e.g. order_complaint, product_inquiry, booking_request, support, billing, general_inquiry)",
  "summary": "one-sentence summary of what the caller wanted",
  "sentiment": "positive | neutral | frustrated | angry",
  "language": "${knownCode || 'primary language used: en | hi | te | ta | kn | other'}",
  "key_details": ["array", "of", "important facts mentioned"],
  "follow_up_needed": true or false,
  "handed_off": true or false,
  "contact_info": "an ALTERNATE phone number or email the caller gives to be reached at, else null",
  "is_lead": true or false,
  "interest_score": 0 to 100 integer,
  "interest_reason": "one short phrase explaining the interest_score"
}

Lead qualification — MOST IMPORTANT:
A LEAD is a potential customer who showed IDENTIFIABLE INTEREST in ${businessName}'s
product or service. NOT every call is a lead. Judge interest from the whole call:
- "interest_score": 0-100, how likely this caller is a genuine potential customer.
  * Asks about products/services, pricing, availability, features, timings to buy,
    wants a demo/quote/callback, tries to book/order, gives contact to be reached,
    or expresses any buying/hiring intent → HIGH (40-100).
  * Existing customer with a genuine service/order issue who may buy again, or a
    vague-but-real enquiry → MODERATE/LOW (10-40).
  * Wrong number, dialed by mistake, telemarketer/spam/robocall, silent/no words,
    pure gibberish with no engagement, someone who explicitly says "not interested"
    / "just testing" / "remove me", or an idle chit-chat with zero business intent
    → NONE (0-9).
- "is_lead": set TRUE only if interest_score >= 10 (i.e. at least a slight, real
  sign of interest — a low bar, roughly 5-10%+). Otherwise FALSE.
- Be honest and conservative: when the caller shows NO real interest, is_lead MUST
  be false even though the other fields are still filled in. A missed/empty/wrong
  call is NOT a lead.

Rules:
- Output ONLY the JSON object, nothing else
- Use null for missing fields, not empty strings
- TRANSCRIPTION RELIABILITY: the "Caller:" lines are the speech recogniser's
  own transcription of the caller. They are usually accurate, though Indic speech
  and heavy code-mixing can still come through imperfectly. Read them as the
  primary record of what the caller actually said.
- The "Agent:" lines CORROBORATE, they do not replace. The agent restates the
  caller's name, location, budget and any booking ("Got it Madhusudhan sir",
  "Saturday 11 AM", "WhatsApp 9003503664"), so use them to confirm or correct a
  caller line you have real reason to doubt — not to overwrite one you simply
  find surprising.
- If a caller line is genuinely unintelligible, leave the fact it would have
  supplied as null. Do NOT reconstruct what they "probably" meant. A missing fact
  is useful; an invented one is worse than useless, because it will be acted on.
- NEVER assert anything neither side actually said. If the call is too short or
  too empty to summarise, say exactly that in "summary" (e.g. "Caller said almost
  nothing; no request identified") instead of composing a plausible-sounding one.
- Pull names, phone numbers, locations, and appointment dates/times from wherever
  they appear MOST CLEARLY — usually the agent's confirmations.
- The agent READS THE NAME BACK to confirm it ("Madhusudhan — did I get that
  right?"). That confirmed spelling is the BEST source for "name". If the caller
  corrected the agent and the agent read back a DIFFERENT name afterwards, the
  LAST confirmed version is the correct one — never the agent's first guess.
- For "language": ${languageRule}
- The "name" is the CALLER's name ONLY — NEVER the agent's name from the greeting
  (e.g. the agent says "Sameera here from..."; that is NOT the caller). If the
  caller never states their own name, use null.
- The "name" field MUST be in English/Latin script. If a name appears in another
  script (e.g. "మధుసూదన్"/"मधुसूदन"), transliterate it as ONE word: "Madhusudhan".
  Do NOT split an Indian given name into two words, and do NOT anglicise it into a
  similar-sounding English word or a more common name.
- Write "summary" and "key_details" in English regardless of the call language.
- Keep summary under 20 words; key_details should be 2-5 short factual points`
}

// ─── Extract lead from conversation history ───────────────────────────────────
// `history` is the call's turns as [{role, content}, ...] — the callers build it from
// the transcript they collected during the call. It used to come from llm.js
// getHistory(); that store is written by nothing since the speech-to-speech engine was
// retired, so reading it here returned an empty conversation and no lead.

// knownLanguage: the LanguageManager verdict for this call, when there was one.
// It is a measurement of the audio, so it WINS over anything the model infers
// from the transcript — see the override after parsing.
export async function extractLead(history, tenantConfig = {}, { knownLanguage = null } = {}) {
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
        { role: 'system', content: buildExtractionPrompt(tenantConfig, knownLanguage) },
        { role: 'user', content: `Call transcript:\n\n${transcript}` },
      ],
      max_tokens: 300,
      temperature: 0.2,  // low temp for consistent structured output
      response_format: { type: 'json_object' },  // forces valid JSON
    })

    const raw = completion.choices[0]?.message?.content || '{}'
    const lead = JSON.parse(raw)

    // The prompt already asks for the measured value, but asking is not the same
    // as getting: this same model was told to read the language off the agent's
    // turns and still returned "hi" for a call conducted entirely in English.
    // Where a measurement exists it is not a hint to the model, it is the answer.
    const measured = toCode(knownLanguage)
    if (measured) {
      const guessed = lead.language
      lead.language = measured
      if (guessed && guessed !== lead.language) {
        console.warn(`[LEAD] language guess ${JSON.stringify(guessed)} overridden by measured ${lead.language}`)
      }
    }

    console.log(`[LEAD] ✅ Extracted in ${Date.now() - t0}ms:`, JSON.stringify(lead))
    return lead

  } catch (err) {
    console.error('[LEAD] ❌ Extraction failed:', err.message)
    return null
  }
}

// ─── REMOVED: cleanTranscript() ───────────────────────────────────────────────
// A post-call LLM pass that rewrote every caller turn. It existed because Gemini
// Live's inputAudioTranscription mangled Indic speech — its prompt began "the
// Caller: lines are almost always WRONG ... INFER each caller turn from the agent's
// replies", i.e. it threw the caller's words away and reconstructed them.
//
// Soniox transcribes the caller directly and accurately, so that pass would now
// paraphrase good data and quietly invent the difference. It had no callers when it
// was deleted. If a translation layer is wanted later it is a NEW function that only
// TRANSLATES — never one that reconstructs what the caller said.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Lead qualification ───────────────────────────────────────────────────────
// A lead is a potential customer who showed at least a slight identifiable
// interest — NOT every call. The extractor returns is_lead + interest_score
// (0-100); we require ~10%+ interest before a call becomes a lead.
export const MIN_INTEREST_SCORE = 10

export function isQualifiedLead(lead) {
  if (!lead) return false
  const score = Number(lead.interest_score)
  const hasScore = Number.isFinite(score)
  // Prefer the explicit boolean; fall back to the score. If the model gave us
  // neither signal (older/degraded output), don't silently drop it — keep it.
  if (typeof lead.is_lead === 'boolean') return lead.is_lead
  if (hasScore) return score >= MIN_INTEREST_SCORE
  return true
}

// ─── Save lead to Supabase ────────────────────────────────────────────────────
// Only persists calls that qualify as leads (see isQualifiedLead). Returns true
// if a lead row was written, false if the call was skipped as a non-lead.
export async function saveLead(supabase, { tenantId, callId, callerNumber, lead }) {
  if (!lead) return false

  if (!isQualifiedLead(lead)) {
    console.log(`[LEAD] Not a lead — skipping (score=${lead.interest_score ?? 'n/a'}, reason="${lead.interest_reason || 'no interest'}")`)
    return false
  }

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
      return false
    }
    console.log('[LEAD] 💾 Saved to Supabase')
    return true
  } catch (err) {
    console.error('[LEAD] ❌ Save error:', err.message)
    return false
  }
}