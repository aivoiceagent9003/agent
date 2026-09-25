import { describe, it, expect } from 'vitest'
import { voiceTurnMessages, compactHistory, TOOL_RESULT_STUB } from '../src/services/voice-turn-context.js'

describe('voice turn context', () => {
  it('remembers recent questions without modifying stored conversation', () => {
    const history = [{ role: 'assistant', content: 'Does this fit your budget?' }, { role: 'user', content: 'Explain the benefit first.' }]
    const result = voiceTurnMessages(history)
    expect(history).toHaveLength(2)
    expect(result).toHaveLength(3)
    expect(result[0].content).toContain('Does this fit your budget?')
    expect(result[0].content).toContain('Do not repeat these questions or paraphrases')
  })
  it('recognises the correction structure without replacing the unclear amount', () => {
    const result = voiceTurnMessages([{ role: 'user', content: 'నేను ఫోర్ కోట్స్ cover అన్నాను. మీరు one crore అనుకున్నారు.' }])
    expect(result[0].content).toContain('This looks like a correction')
    expect(result[1].content).toContain('ఫోర్ కోట్స్')
    expect(result[0].content).toContain('confirm that value')
  })
  it('keeps context bounded and ignores tool preambles', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: `Question ${i}?` }))
    history.push({ role: 'assistant', content: 'Search now?', tool_calls: [{}] })
    const context = voiceTurnMessages(history)[0].content
    expect(context).not.toContain('Question 4?')
    expect(context).toContain('Question 9?')
    expect(context).not.toContain('Search now?')
  })
  it('preserves grounding in a single system message for compatibility endpoints', () => {
    const history = [{ role: 'system', content: 'Only use supplied facts.' }, { role: 'user', content: 'What are my options?' }]
    const result = voiceTurnMessages(history)
    expect(result.filter(m => m.role === 'system')).toHaveLength(1)
    expect(result[0].content).toContain('Only use supplied facts.')
    expect(history[0].content).toBe('Only use supplied facts.')
    expect(result.at(-1)).toEqual(history.at(-1))
  })
})

describe('voice-turn-context — language', () => {
  it('never names a language in the per-turn guidance', () => {
    // It is the last thing the model reads before answering. A real call: the caller
    // asked in plain English and got Telugu back, then said "wow".
    const guidance = voiceTurnMessages([{ role: 'user', content: 'Why are you asking me instead of suggesting a best plan?' }])[0].content
    const tail = guidance.slice(guidance.indexOf('THIS TURN'))
    expect(tail).not.toMatch(/Telugu\/Hindi grammar/)
    expect(tail).toMatch(/caller's own language/)
  })
})

describe('compactHistory', () => {
  const longResult = 'premium table '.repeat(100)
  const toolTurn = (q, id) => [
    { role: 'user', content: q },
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'search_knowledge', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: longResult },
    { role: 'assistant', content: `Answer to ${q}.` },
  ]

  it('shrinks old lookup results but keeps the recent ones and what the agent said', () => {
    const h = [{ role: 'system', content: 'S' }, ...toolTurn('q1', 'a'), ...toolTurn('q2', 'b'), ...toolTurn('q3', 'c')]
    compactHistory(h)
    const tools = h.filter(m => m.role === 'tool')
    expect(tools.map(m => m.content === TOOL_RESULT_STUB)).toEqual([true, false, false])
    expect(h).toContainEqual({ role: 'assistant', content: 'Answer to q1.' })
    expect(tools[0].tool_call_id).toBe('a')
  })

  it('leaves short tool results alone', () => {
    const h = [
      { role: 'user', content: 'send it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'send_whatsapp', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'w', content: 'WhatsApp sent.' },
      { role: 'user', content: 'ok' }, { role: 'user', content: 'thanks' }, { role: 'user', content: 'bye' },
    ]
    compactHistory(h)
    expect(h[2].content).toBe('WhatsApp sent.')
  })

  it('drops the oldest whole turns past the cap, never orphaning a tool result', () => {
    const h = [{ role: 'system', content: 'S' }, { role: 'assistant', content: 'Namaste' }]
    for (let i = 0; i < 5; i++) h.push(...toolTurn(`q${i}`, `id${i}`))
    compactHistory(h, { maxTurns: 3 })
    expect(h[0]).toEqual({ role: 'system', content: 'S' })
    expect(h[1]).toEqual({ role: 'user', content: 'q2' })
    expect(h.filter(m => m.role === 'user')).toHaveLength(3)
    const callIds = new Set(h.flatMap(m => m.tool_calls?.map(c => c.id) || []))
    for (const m of h.filter(m => m.role === 'tool')) expect(callIds.has(m.tool_call_id)).toBe(true)
  })

  it('does nothing to a short call', () => {
    const h = [{ role: 'system', content: 'S' }, ...toolTurn('q1', 'a')]
    const before = structuredClone(h)
    compactHistory(h)
    expect(h).toEqual(before)
  })
})
