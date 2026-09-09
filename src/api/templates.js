// api/templates.js — the "Pre built Agents" library, as served to the client UI.
//
// This file used to BE the templates: six agents, each a two-hundred-line markdown
// prompt. Every one of them restated the universal rules — how to speak, how to
// handle an interrupt, when to hand off, what to do about a do-not-call request —
// so a fix to those rules reached one agent and silently missed the other five, and
// a template could contradict the safety layer just by being out of date.
//
// The templates now live in src/config/conversation/agent-templates.js as DATA, and
// carry only what is specific to their kind of call. The universal behaviour is
// composed underneath them by the prompt builder, for every agent, always.
//
// This module is now the API shape: it adapts those structured templates to what the
// UI and the stored tenant config expect. Ids, the exported names and the response
// shape are unchanged, so nothing downstream had to move.
//
// WHAT A CLIENT STORES when they pick a template: `template_id`. Not a prompt. The
// builder resolves the id at call time, which means template improvements reach every
// tenant that picked one, instead of being frozen into whatever their config was
// copied from on the day they signed up.
//
// `system_prompt` stays in the config and stays empty — it is the client's own
// business instructions, and it is now a genuinely optional extra layer rather than
// the whole prompt. Tenants created before this change still have a full prompt in
// there and keep working: it renders as their business layer.

import { AGENT_TEMPLATES, getAgentTemplate } from '../config/conversation/agent-templates.js'

/** The config a tenant stores when it picks this template. */
function templateConfig(t) {
  return {
    ...t.config,
    template_id: t.id,
    // The client's own business instructions. Empty by default — the template
    // supplies the behaviour, the knowledge base supplies the facts.
    system_prompt: '',
  }
}

export const TEMPLATES = AGENT_TEMPLATES.map(t => ({
  id: t.id,
  label: t.label,
  description: t.description,
  icon: t.icon,
  category: t.category,
  config: templateConfig(t),
  suggested_kb_topics: t.suggested_kb_topics || [],

  // The structured behaviour, exposed so the UI can show a client what an agent will
  // actually do before they pick it — which a wall of prompt text never could.
  strategy: t.conversationStrategy,
  goals: t.primaryGoals,
  collects: (t.informationPriorities || []).map(p => p.field),
  outcomes: Object.keys(t.successOutcomes || {}),
  never: t.prohibitedBehavior,
}))

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null
}

/** The structured template behind an id, for the prompt builder. */
export { getAgentTemplate }
