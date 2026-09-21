import { describe, it, expect } from 'vitest'
import { toGeminiContents } from '../src/services/gemini-native.js'

describe('OpenAI messages → Gemini contents', () => {
  it('lifts system messages out, because Gemini takes them separately', () => {
    const { system, contents } = toGeminiContents([
      { role: 'system', content: 'You are Aruna.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(system).toBe('You are Aruna.')
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }])
  })

  it('joins several system messages rather than dropping the earlier ones', () => {
    // Losing one would silently strip the voice rules or the tenant's grounding.
    const { system } = toGeminiContents([
      { role: 'system', content: 'Rules.' },
      { role: 'system', content: 'More rules.' },
      { role: 'user', content: 'Hi' },
    ])
    expect(system).toBe('Rules.\n\nMore rules.')
  })

  it('calls the assistant "model", which is what Gemini names that role', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Namaste' },
    ])
    expect(contents.map(c => c.role)).toEqual(['user', 'model'])
  })

  it('turns a tool call into a functionCall part with parsed arguments', () => {
    const { contents } = toGeminiContents([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'gcall_0_search_knowledge', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"premium"}' } }],
      },
    ])
    expect(contents).toEqual([{
      role: 'model',
      parts: [{ functionCall: { name: 'search_knowledge', args: { query: 'premium' } } }],
    }])
  })

  it('survives malformed tool arguments instead of throwing mid-call', () => {
    const { contents } = toGeminiContents([
      { role: 'assistant', content: null, tool_calls: [{ id: 'gcall_0_x', function: { name: 'x', arguments: '{not json' } }] },
    ])
    expect(contents[0].parts[0].functionCall).toEqual({ name: 'x', args: {} })
  })

  it('matches a tool RESULT back to the function that produced it', () => {
    // Gemini identifies a result by the function NAME, while OpenAI uses an opaque id.
    // The id is synthesised with the name inside it precisely so this works without
    // carrying state between requests.
    const { contents } = toGeminiContents([
      { role: 'tool', tool_call_id: 'gcall_0_search_knowledge', content: 'six chunks of KB text' },
    ])
    expect(contents).toEqual([{
      role: 'user',
      parts: [{ functionResponse: { name: 'search_knowledge', response: { result: 'six chunks of KB text' } } }],
    }])
  })

  it('keeps a tool call that also carried text, in order', () => {
    const { contents } = toGeminiContents([
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'gcall_0_lookup', function: { name: 'lookup', arguments: '{}' } }] },
    ])
    expect(contents[0].parts).toEqual([
      { text: 'Let me check.' },
      { functionCall: { name: 'lookup', args: {} } },
    ])
  })

  it('drops an assistant turn with neither text nor a tool call', () => {
    // Gemini rejects a content entry with an empty parts array.
    const { contents } = toGeminiContents([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: null },
    ])
    expect(contents).toHaveLength(1)
  })

  it('carries a whole call through: question, search, result, answer', () => {
    const { system, contents } = toGeminiContents([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'What is the premium?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'gcall_0_search_knowledge', function: { name: 'search_knowledge', arguments: '{"query":"premium"}' } }] },
      { role: 'tool', tool_call_id: 'gcall_0_search_knowledge', content: '21000 rupees' },
      { role: 'assistant', content: 'It is 21,000 rupees.' },
      { role: 'user', content: 'And for Supreme?' },
    ])
    expect(system).toBe('SYSTEM')
    expect(contents.map(c => c.role)).toEqual(['user', 'model', 'user', 'model', 'user'])
    expect(contents[2].parts[0].functionResponse.name).toBe('search_knowledge')
  })
})
