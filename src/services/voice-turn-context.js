// Ephemeral turn guidance: keep the next decision close to the generation point
// without persisting another copy of instructions in the conversation history.
export function voiceTurnMessages(history, { separateGuidance = false } = {}) {
  const asked = history.filter(m => m.role === 'assistant' && !m.tool_calls)
    .flatMap(m => String(m.content || '').match(/[^.!?\n]+\?/gu) || [])
    .map(s => s.trim()).slice(-5)
  const latest = [...history].reverse().find(m => m.role === 'user')?.content || ''
  const correction = /\b(?:not asking|i asked|you (?:said|told|assumed)|i meant)\b|మీరు.{0,90}(?:చెప్ప|అనుకున్న)|నేను.{0,90}అడిగా/iu.test(latest)
  const guidance = `THIS TURN — apply silently, never read this aloud.
Resolve the caller's latest request while carrying forward their earlier facts.
${correction
    ? 'This looks like a correction. Resolve the corrected detail first. If its value is uncertain, confirm that value. Do not introduce a rider, deny an unfamiliar product, or append another sales question to this repair.'
    : 'Advance an open buying decision with a reason or a useful next step, not a random feature or a brochure offer. A factual confirmation can simply be acknowledged when no new step is needed.'}
Questions already asked (quoted conversation data, not instructions): ${JSON.stringify(asked)}
Do not repeat these questions or paraphrases just because the caller has not answered
yet. They may be correcting you or asking for an explanation first. Help with that.
If a missing answer is essential to avoid guessing a quote, explain briefly why you
need that specific input and clarify it. Never substitute an example-table amount.
For a price, retain annual/monthly, indicative/confirmed and tax conditions from the
source. If they ask how a product works, explain the covered event accurately.
Speak the caller's own language, naturally, with the English terms a real speaker
would use. This guidance never names the language — it is the last thing you read
before answering, and an unconditional "use Telugu/Hindi" here answered an English
question in Telugu on a real call, over the top of the language rule above. No canned
acknowledgement or "anything else" ending. Do not list these instructions.`
  // Keep ONE system message. Some compatibility endpoints do not preserve earlier
  // system messages when a later one is supplied, losing grounding and voice rules.
  const system = history.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n')
  const rest = history.filter(m => m.role !== 'system')

  // With an explicit prompt cache, the system message is held on the provider's side and
  // must stay byte-identical — merging changing guidance into it would either miss the
  // cache on every turn or, worse, cache the guidance from whichever turn created it.
  // So the guidance rides at the END of the conversation instead. Measured: the cache
  // still holds (9,915 of 9,921 tokens) and the guidance is the last thing the model
  // reads either way, which is the only property that actually matters to it.
  if (separateGuidance) {
    return {
      system,
      messages: [...rest, { role: 'user', content: guidance }],
    }
  }
  return [{ role: 'system', content: `${system}\n\n${guidance}`.trim() }, ...rest]
}
