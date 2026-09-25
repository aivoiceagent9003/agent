import { describe, it, expect, vi } from 'vitest'
const USD_INR = Number(process.env.USD_INR) || 95.97
import { createCascadeMeter, telephonyCost } from '../src/services/cascade-cost.js'

const RATES = { sttPerHour: 0.30, ttsPerChar: 0.000032, llmIn: 0.15, llmCachedIn: 0.075, llmOut: 0.60 }

describe('cascade call cost meter', () => {
  it('prices STT by seconds of 8kHz µ-law audio and TTS by characters', () => {
    const m = createCascadeMeter(RATES)
    m.addSttAudio(8000 * 3600)   // one hour of caller audio
    m.addTtsAudio(8000 * 3600)   // one hour of generated speech — reported, not billed
    m.addTtsChars(10_000)
    const s = m.summary()
    expect(s.sttSeconds).toBe(3600)
    expect(s.ttsSeconds).toBe(3600)
    expect(s.costUsd).toBeCloseTo(0.30 + 10_000 * 0.000032, 4)
  })

  it('charges cached prompt tokens at the cached rate, not twice', () => {
    const m = createCascadeMeter(RATES)
    m.addLlmUsage({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 400_000 } })
    const s = m.summary()
    // 600K uncached × 0.15 + 400K cached × 0.075 + 1M out × 0.60
    expect(s.costUsd).toBeCloseTo(0.09 + 0.03 + 0.60, 4)
    expect(s.llmCalls).toBe(1)
  })

  it('reports rupees at the configured rate, split by component', () => {
    const m = createCascadeMeter(RATES)
    m.addSttAudio(8000 * 3600)
    const s = m.summary()
    expect(s.costInr).toBeCloseTo(0.30 * USD_INR, 1)
    expect(s.byPartInr.stt).toBeCloseTo(0.30 * USD_INR, 1)
    expect(s.byPartInr.tts).toBe(0)
  })

  it('adds the carrier bill when its rate is known, so the total matches reality', () => {
    // The engine's estimate read ₹1.91/min while the real bill was ₹2.55/min — the
    // difference was the carrier, which bills separately and in rupees per minute.
    const m = createCascadeMeter({ ...RATES, telephonyInrPerMin: 0.64 })
    m.addSttAudio(8000 * 60)
    const s = m.summary(1.5)
    expect(s.telephonyInr).toBeCloseTo(0.96, 2)
    expect(s.allInInr).toBeCloseTo(s.costInr + 0.96, 2)
  })

  it('reports no telephony when no rate is configured', () => {
    const m = createCascadeMeter(RATES)
    m.addSttAudio(8000 * 60)
    const s = m.summary(2)
    expect(s.telephonyInr).toBe(0)
    expect(s.allInInr).toBe(s.costInr)
  })

  it('ignores missing usage and negative byte counts', () => {
    const m = createCascadeMeter(RATES)
    m.addLlmUsage(null)
    m.addSttAudio(-5)
    expect(m.summary().costUsd).toBe(0)
  })
})

describe('a browser call is not billed like a phone call', () => {
  // The demo and the builder test call run 16kHz PCM16 in and 24kHz PCM16 out. Counting
  // those bytes at the µ-law rate reads 4× the STT seconds and 6× the TTS seconds, which
  // is not a rounding error — it is an invented bill. A real demo call reported 650s of
  // TTS for 1658 characters of speech, roughly eleven minutes of talking that never
  // happened.
  const BROWSER = { sttBytesPerSecond: 32000, ttsBytesPerSecond: 48000 }

  it('counts caller seconds at 16kHz PCM16, not µ-law', () => {
    const m = createCascadeMeter(RATES, BROWSER)
    m.addSttAudio(32000 * 60)
    expect(m.summary().sttSeconds).toBe(60)
  })

  it('counts agent speech at 24kHz PCM16, not µ-law', () => {
    const m = createCascadeMeter(RATES, BROWSER)
    m.addTtsAudio(48000 * 60)
    expect(m.summary().ttsSeconds).toBe(60)
  })

  it('bills the two directions at different rates in the same call', () => {
    // The bug that shipped: one shared bytes-per-second for both legs. It cannot be
    // right for a browser, because the two legs do not run at the same sample rate.
    const m = createCascadeMeter(RATES, BROWSER)
    m.addSttAudio(32000 * 10)
    m.addTtsAudio(48000 * 10)
    const s = m.summary()
    expect(s.sttSeconds).toBe(10)
    expect(s.ttsSeconds).toBe(10)
  })

  it('still assumes a phone line when no profile is given', () => {
    const m = createCascadeMeter(RATES)
    m.addSttAudio(8000 * 30)
    expect(m.summary().sttSeconds).toBe(30)
  })
})

// Carriers bill in blocks, not minutes. Plivo's India inbound rate is ₹0.19 per 30
// seconds and every block a call touches is charged in full — so a 31-second call pays
// for 60. Priced as a flat per-minute rate the same call reads ₹0.20 against a real
// ₹0.38, and the error lands hardest on short calls, which already carry the worst
// margin because the greeting and first prompt amortise over nothing.
describe('what the carrier actually charges', () => {
  const blockRates = { ...RATES, telephonyInrPerBlock: 0.19, telephonyBlockSeconds: 30 }

  it.each([
    [10, 0.19],    // a call that barely connected still costs a whole block
    [30, 0.19],
    [31, 0.38],    // one second into the second block
    [53, 0.38],
    [60, 0.38],
    [90, 0.57],
    [168.2, 1.14], // a real call from the logs
  ])('bills %ss as ₹%s', (seconds, expected) => {
    expect(telephonyCost(blockRates, seconds / 60)).toBeCloseTo(expected, 2)
  })

  it('rounds up, never down — the carrier does not give back part of a block', () => {
    for (let s = 1; s <= 120; s++) {
      const billed = telephonyCost(blockRates, s / 60)
      expect(billed).toBeGreaterThanOrEqual(+((s / 60) * 0.38).toFixed(2) - 0.001)
    }
  })

  it('charges nothing for a call that never happened', () => {
    expect(telephonyCost(blockRates, 0)).toBe(0)
  })

  // Kept for a carrier that genuinely bills per second or per minute.
  it('falls back to a flat per-minute rate when no block rate is set', () => {
    expect(telephonyCost({ ...RATES, telephonyInrPerMin: 0.64 }, 1.5)).toBeCloseTo(0.96, 2)
  })

  it('prefers the block rate when both are configured', () => {
    const both = { ...blockRates, telephonyInrPerMin: 99 }
    expect(telephonyCost(both, 1)).toBeCloseTo(0.38, 2)
  })

  it('reaches the summary line, not just the helper', () => {
    const m = createCascadeMeter(blockRates)
    m.addSttAudio(8000 * 31)
    expect(m.summary(31 / 60).telephonyInr).toBeCloseTo(0.38, 2)
  })
})

describe('the list prices the engine runs on', () => {
  it('prices Sarvam per hour, Telnyx per character and the Gemini model by name', async () => {
    const { ratesFor, createCascadeMeter } = await import('../src/services/cascade-cost.js')
    const rates = ratesFor('gemini-3.5-flash-lite')
    expect(rates.sttPerHour).toBe(0.30)
    expect(rates.ttsPerChar).toBe(0.000032)
    expect([rates.llmIn, rates.llmCachedIn, rates.llmOut]).toEqual([0.30, 0.03, 2.50])
    const m = createCascadeMeter(rates, { sttBytesPerSecond: 8000, ttsBytesPerSecond: 8000 })
    m.addTtsChars(1566)
    m.addTtsAudio(8000 * 115)                               // 115s of speech costs nothing extra
    expect(m.summary().byPartInr.tts).toBeCloseTo(1566 * 0.000032 * USD_INR, 1)
  })

  it('warns once, and prices at the default model, when a model has no list price', async () => {
    const { ratesFor } = await import('../src/services/cascade-cost.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rates = ratesFor('gemini-9-unpriced')
    ratesFor('gemini-9-unpriced')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(rates.llmIn).toBe(0.30)
    warn.mockRestore()
  })
})

describe('billableChars counts the way Telnyx bills', () => {
  // Each pair is a real request and the character count on Telnyx's own billing record.
  // Vowel signs and viramas ride free on their letter; .length counts them and
  // over-billed a real Telugu call by 29%.
  it('matches Telnyx billing records exactly', async () => {
    const { billableChars } = await import('../src/services/cascade-cost.js')
    expect(billableChars('The indicative annual premium is thirty nine thousand rupees')).toBe(60)
    expect(billableChars('మీకు ఏ రకమైన ఇన్సూరెన్స్ కావాలి అండి')).toBe(23)
    expect(billableChars('Supreme variant లో మీకు extra benefits వస్తాయి అండి')).toBe(43)
  })
})
