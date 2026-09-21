// What the agent is told when a knowledge search finds nothing, and how it is told
// to search in the first place. Both rules exist because of specific failures on real
// calls, and both are easy to "simplify" away later.

import { describe, it, expect } from 'vitest'
import { noKnowledgeInstruction, buildAgentTools } from '../src/services/agent-tools.js'
import { buildContext, renderLayers } from '../src/config/conversation/index.js'

const flat = (s) => String(s).replace(/\s+/g, ' ')
const layer = (ctx, name) => renderLayers(ctx).find(l => l.name === name)?.text || ''
const withKb = { business_name: 'GSK insurance', agent_name: 'Aruna', tenant_id: 't1' }
const withLookups = { ...withKb, lookups: [{ name: 'policy_status' }] }

describe('searching in the language of the KB, not the caller', () => {
  it('tells the agent to search in English and answer in the caller\'s language', () => {
    // Real call: the caller asked in Telugu, the agent searched in Telugu, the search
    // scored 0.18 and the caller was told the business had no term insurance.
    const rules = flat(layer(buildContext(withKb, { channel: 'speech' }), 'tools'))
    expect(rules).toMatch(/SEARCH IN ENGLISH/i)
    expect(rules).toMatch(/matches nothing/i)
    expect(rules).toMatch(/What you SAY stays in the caller's language/i)
  })

  it('says it on the search tool itself, where the model reads it while calling', () => {
    const decls = buildAgentTools(withKb)[0].functionDeclarations
    const search = decls.find(d => d.name === 'search_knowledge')
    expect(flat(search.parameters.properties.query.description)).toMatch(/IN ENGLISH/)
  })
})

describe('never denying what was never searched for', () => {
  const rules = () => flat(layer(buildContext(withKb, { channel: 'speech' }), 'tools'))

  it('forbids saying the business does not have something without searching for it', () => {
    // Real call: one search returned a single company's pages, and the agent told the
    // caller three times that the business had nothing else. It carries ten companies.
    expect(rules()).toMatch(/NEVER SAY "WE DO NOT HAVE IT" WITHOUT LOOKING FOR IT/)
    expect(rules()).toMatch(/Finding one plan is not evidence that the others do not exist/)
  })

  it('tells the agent to search again when the caller says it missed something', () => {
    expect(rules()).toMatch(/they are usually right/)
    expect(rules()).toMatch(/Never repeat your denial without searching/)
  })

  it('puts no real plan or company name in the search examples', () => {
    // A tenant's plan name in the tool description got copied into a search the caller
    // never asked for, and the agent answered about the wrong product.
    const search = buildAgentTools(withKb)[0].functionDeclarations.find(d => d.name === 'search_knowledge')
    const description = flat(search.parameters.properties.query.description)
    expect(description).toMatch(/caller's request and established conversation context/)
    expect(description).toMatch(/without inventing a company/)
    for (const name of ['Sanjeevani', 'LifeShield', 'Bharat Suraksha', 'Vaayu']) {
      expect(description).not.toContain(name)
    }
  })
})

describe('what a knowledge miss tells the agent to do', () => {
  it('never turns a general question into a demand for the caller ID', () => {
    const miss = flat(noKnowledgeInstruction(withLookups))
    expect(miss).toMatch(/GENERAL question/)
    expect(miss).toMatch(/do NOT ask for a customer ID/)
    expect(miss).toMatch(/Search ONCE more with different ENGLISH words/)
  })

  it('still routes a question about the caller\'s own account to the lookup', () => {
    const miss = flat(noKnowledgeInstruction(withLookups))
    expect(miss).toMatch(/THEIR OWN account/)
    expect(miss).toContain('policy_status')
    expect(miss).toMatch(/do NOT offer a callback, until you have actually tried it/i)
  })

  it('offers no lookup path at all to a tenant that has none', () => {
    const miss = flat(noKnowledgeInstruction(withKb))
    expect(miss).not.toMatch(/customer ID/)
    expect(miss).toMatch(/don't have that detail to hand/)
  })

  it('always forbids inventing a figure, whichever branch applies', () => {
    for (const cfg of [withKb, withLookups]) {
      expect(flat(noKnowledgeInstruction(cfg))).toMatch(/Do NOT state any amount, date, number/)
    }
  })
})
