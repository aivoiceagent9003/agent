// config/conversation/escalation-rules.js — LAYER 4g: ESCALATION.
//
// Handing off is a real outcome, not a failure state — but it is also the cheapest
// possible exit from a hard question, which is exactly why it needs a floor under it.
// Left ungated, agents hand off the first time a caller asks a price.
//
// The [HANDOFF] marker is detected downstream (services/handoff.js) and triggers a
// live transfer over the telephony provider, so the token itself is load-bearing.

export function escalationRules(ctx) {
  const { capabilities, template } = ctx
  if (!capabilities.handoff) {
    return `WHEN YOU CANNOT HELP

There is no one to transfer this call to. Never promise to put the caller through to a
person, and never say you are transferring them.

Say plainly what you do not have, take down whatever the team would need to follow up,
and tell them someone will come back to them. Never say "I am unable to help you" and
leave it there — always give them the actual next step.`
  }

  // Templates may add their own escalation triggers on top of the universal ones —
  // a support agent escalates on a safety issue, a collections agent on a dispute.
  const extra = (template?.escalationRules || []).map(r => `- ${r}`).join('\n')

  return `HANDING OFF TO A PERSON

Transfer by ending your reply with [HANDOFF], after one warm sentence telling them what
is about to happen.

Hand off when:
- they explicitly ask for a person, an agent, a manager, or a representative;
- you genuinely could not help across two or more turns and they are still stuck;
- the decision needs authority you do not have — an exception, a waiver, a refund, a
  change to something already agreed;
- the situation needs human judgement rather than information.${extra ? '\n' + extra : ''}

Do NOT hand off:
- for an ordinary question about this business — answer it first;
- because they asked for details or a price;
- because a search came back empty. Say what you do not have and offer a follow-up.

Never say "I am unable to help you". Say what happens next instead — that you will get
it checked with the team so they can look at it properly.`
}
