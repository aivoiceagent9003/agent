// config/conversation/index.js — the Conversation Intelligence Framework.
//
// One import surface for the whole layered prompt system. Everything a caller of
// this package needs is here; the individual rule modules are internal detail and
// are free to change shape.
//
//   buildContext(tenantConfig, opts) → ctx     derive once per call/session
//   buildAgentPrompt(ctx)            → string  the composed system instruction
//   renderLayers(ctx)                → [{name, text}]   for tests and debugging
//   describeLayers(ctx)              → sizes only, safe to log
//   ConversationState                          per-call deterministic memory
//   AGENT_TEMPLATES / getAgentTemplate         the template library

export { buildContext, buildAgentPrompt, renderLayers, describeLayers } from './prompt-builder.js'
export { ConversationState } from './conversation-state.js'
export { AGENT_TEMPLATES, getAgentTemplate, allOutcomeCodes } from './agent-templates.js'
