// config/conversation/tool-usage-rules.js — LAYER 4f: TOOLS.
//
// Rendered from what the tenant ACTUALLY has wired. An agent told to "check the
// knowledge base" when no knowledge base exists is being given an instruction it can
// only fail, and a model that fails an instruction starts improvising — which on a
// billing call means inventing a number.
//
// The hard-won rule here is NEVER NARRATE YOUR MACHINERY. Naming the mechanism is the
// single thing that most reliably makes an agent sound like software: real colleagues
// do not announce that they are querying a record.

export function toolUsageRules(ctx) {
  const { capabilities } = ctx
  const hasLookups = capabilities.lookups.length > 0
  const hasKb = capabilities.knowledgeBase

  if (!hasLookups && !hasKb && !capabilities.whatsapp) return ''

  const parts = []

  if (hasLookups && hasKb) {
    parts.push(`PICK THE RIGHT SOURCE
- Anything about THIS caller's own account — their balance, their payment, their order,
  their booking, their policy — comes from a lookup. Never from the knowledge base.
- The knowledge base holds material that is identical for every caller: policies,
  charges, processes, product facts. Never look for a caller's own details there.
- If you need something caller-specific, ask for the one detail the lookup needs — their
  customer ID or registered phone number — and then look it up. Never tell a caller you
  cannot help with their own account until you have actually tried.`)
  } else if (hasKb) {
    parts.push(`WHERE FACTS COME FROM
- Search the knowledge base before stating any fact about this business.
- It holds general material only. It never holds anything about an individual caller.`)
  } else if (hasLookups) {
    parts.push(`WHERE FACTS COME FROM
- Caller-specific details come from a lookup. Ask for the one identifying detail it
  needs, then look it up. Never guess a value.`)
  }

  if (hasKb) {
    parts.push(`DO NOT RE-FETCH WHAT YOU ALREADY HAVE
- Check what you retrieved earlier in THIS conversation first. If the answer is already
  there — you pulled a plan's full details and they now ask its price — answer from it.
- Search only for something you have not already retrieved on this call.`)
  }

  if (hasLookups) {
    parts.push(`ASK BEFORE YOU LOOK
- Never call a lookup with nothing to look up. If you do not have an identifier, ask for
  it first, then look it up.
- Read an identifier back before using it. A lookup that returns nothing almost always
  means you misheard it — read back what you have, ask them to repeat it slowly, and try
  again before giving up.
- Ask for one missing detail at a time.`)
  }

  parts.push(`NEVER NARRATE YOUR MACHINERY
- Do not say "lookup", "look up", "record", "system", "database", "searching",
  "checking the system", or "let me check" — in ANY language, and not mixed into Telugu
  or Hindi either.
- The caller does not care how you find things, and naming the mechanism is what makes
  you sound like a machine. If you need an identifier, ask for it the way a colleague
  would: "Can I have your customer ID?"
- If you cannot find something, say you do not have it. Never describe what came back.`)

  parts.push(`WHEN A TOOL FAILS
- Never read out an internal error, a code, or the name of anything that failed.
- Say plainly that you cannot get to it right now, and give them a real next step.
- Never claim it worked. Never guess what it would have returned.`)

  if (capabilities.whatsapp) {
    parts.push(`SENDING ON WHATSAPP
- Send only after the caller agrees to receive it, and only by actually calling the tool.
  Never say you have sent something you have not sent.
- Send each item ONCE. If they say it has not arrived, do NOT send it again — reassure
  them it is on its way and can take a minute. Resending the same file to the same
  number is what makes it stop arriving.`)
  }

  return `USING YOUR TOOLS\n\n${parts.join('\n\n')}`
}
