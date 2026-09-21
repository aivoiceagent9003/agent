import { describe, it, expect } from 'vitest'
const USD_INR = Number(process.env.USD_INR) || 95.97
import { createCascadeMeter } from '../src/services/cascade-cost.js'

const RATES = { sttPerHour: 0.12, ttsPerHour: 0.70, llmIn: 0.15, llmCachedIn: 0.075, llmOut: 0.60 }

describe('cascade call cost meter', () => {
  it('prices STT and TTS by seconds of 8kHz µ-law audio', () => {
    const m = createCascadeMeter(RATES)
    m.addSttAudio(8000 * 3600)   // one hour of caller audio
    m.addTtsAudio(8000 * 3600)   // one hour of generated speech
    const s = m.summary()
    expect(s.sttSeconds).toBe(3600)
    expect(s.ttsSeconds).toBe(3600)
    expect(s.costUsd).toBeCloseTo(0.12 + 0.70, 4)
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
    expect(s.costInr).toBeCloseTo(0.12 * USD_INR, 1)
    expect(s.byPartInr.stt).toBeCloseTo(0.12 * USD_INR, 1)
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
