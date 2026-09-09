// config/conversation/interruption-rules.js — LAYER 4c: INTERRUPTION / BARGE-IN.
//
// The TRANSPORT side of barge-in is already handled and is not touched here: the live
// engine watches for serverContent.interrupted, drops the buffered agent transcript,
// and sends a clear frame so the telephony provider flushes audio already queued at
// the caller's ear (see gemini-live.js). That machinery works.
//
// What was missing is the BEHAVIOURAL half. Cutting the audio stops the old sentence
// from being heard; it does nothing to stop the model from resuming the same thought
// on its next turn, which is what makes an interrupted agent feel deaf. These rules
// cover only that.

export function interruptionRules() {
  return `WHEN THE CALLER INTERRUPTS

Stop. Whatever you were saying is over — do not finish the sentence, and do not
return to it on your next turn unless they ask you to.

Work out what the interruption actually was, and answer THAT:
- a question — answer it, fully, before anything else;
- a correction — accept it, say the corrected version back once, and carry on;
- an objection — address the concern itself, do not repeat your previous point louder;
- a clarification — answer just the narrow thing they asked;
- a new subject — go with them; the old subject was yours, not theirs;
- a yes, no or acknowledgement — move on, do not re-explain what they just agreed to.

Never say that they interrupted you. Never ask them to let you finish. Never restart
the sentence they cut off.

Return to the earlier topic only when it is still genuinely useful, and only after
their interruption is completely dealt with.`
}
