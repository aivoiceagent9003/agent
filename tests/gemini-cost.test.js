import { describe, it, expect } from 'vitest'
import { createUsageMeter, RATES, USD_INR } from '../src/services/gemini-cost.js'

// The three turns below are the usageMetadata a real gemini-3.1-flash-live-preview
// session sent: one per turn, per-turn numbers, with the agent's own previous reply
// coming back as input AUDIO on the next turn.
const REAL_TURNS = [
  { promptTokenCount: 1365, responseTokenCount: 118, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1342 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 118 }] },
  { promptTokenCount: 1521, responseTokenCount: 111, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1368 }, { modality: 'AUDIO', tokenCount: 118 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 111 }] },
  { promptTokenCount: 1666, responseTokenCount: 55, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1390 }, { modality: 'AUDIO', tokenCount: 229 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 55 }] },
]

describe('gemini call cost meter', () => {
  it('sums per-turn usage by modality', () => {
    const m = createUsageMeter()
    REAL_TURNS.forEach(u => m.add(u))
    const s = m.summary()
    expect(s.turns).toBe(3)
    expect(s.textIn).toBe(1342 + 1368 + 1390)
    expect(s.audioIn).toBe(118 + 229)
    expect(s.audioOut).toBe(118 + 111 + 55)
    expect(s.peakPrompt).toBe(1666)
  })

  it('prices each modality at its own rate', () => {
    const m = createUsageMeter()
    m.add({ promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1e6 }, { modality: 'AUDIO', tokenCount: 1e6 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 1e6 }] })
    const s = m.summary()
    expect(s.costUsd).toBeCloseTo(RATES.textIn + RATES.audioIn + RATES.audioOut, 4)
    expect(s.costInr).toBeCloseTo((RATES.textIn + RATES.audioIn + RATES.audioOut) * USD_INR, 1)
  })

  it('treats a prompt with no modality breakdown as text, and ignores empty messages', () => {
    const m = createUsageMeter()
    m.add(null)
    m.add({ promptTokenCount: 500, responseTokenCount: 0 })
    const s = m.summary()
    expect(s.turns).toBe(1)
    expect(s.textIn).toBe(500)
    expect(s.audioIn).toBe(0)
  })

  it('reports billed input audio in minutes (25 tokens per second)', () => {
    const m = createUsageMeter()
    m.add({ promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 25 * 60 * 3 }] })
    expect(m.summary().audioInMinutesBilled).toBe(3)
  })
})
