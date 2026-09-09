// Ending the call from our side.
//
// The risk here is entirely one-sided. Staying on a line nobody needed is mildly
// impolite; cutting a caller off mid-sentence is the thing you get complained about.
// So every test below is really asking the same question: does this ever close the
// line before the caller has heard the words we already sent?

import { describe, it, expect } from 'vitest'
import { createPlayoutTracker } from '../src/telephony/playout.js'
import { hangupUrl } from '../src/telephony/provider.js'
import { buildGeminiTools } from '../src/services/gemini-live.js'

// A controllable clock, so the drain behaviour is testable without waiting for it.
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

// G.711 μ-law at 8kHz: 8000 bytes per second of speech.
const secondsOfAudio = (s) => 8000 * s

describe('how much the caller has not heard yet', () => {
  it('reports nothing outstanding before anything is sent', () => {
    expect(createPlayoutTracker().msRemaining()).toBe(0)
  })

  it('converts bytes of mulaw into milliseconds of speech', () => {
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(3))
    expect(p.msRemaining()).toBe(3000)
  })

  it('counts down in real time', () => {
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(3))
    c.advance(1200)
    expect(p.msRemaining()).toBe(1800)
  })

  it('queues a second burst behind the first', () => {
    // The model produces far faster than real time, so a whole reply arrives in a
    // few bursts within milliseconds. They must accumulate, not overwrite.
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(2))
    c.advance(10)
    p.queued(secondsOfAudio(2))
    expect(p.msRemaining()).toBe(3990)
  })

  it('does not queue behind audio that already finished', () => {
    // A quiet stretch mid-call must not make every later estimate too long — that
    // would delay the hangup by the length of every silence in the call.
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(1))
    c.advance(30_000)
    p.queued(secondsOfAudio(1))
    expect(p.msRemaining()).toBe(1000)
  })

  it('drops to nothing once it has all played', () => {
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(1))
    c.advance(5000)
    expect(p.msRemaining()).toBe(0)
  })

  it('forgets everything the provider discarded on a barge-in', () => {
    // On an interrupt we send clearAudio and the provider throws the buffer away.
    // Continuing to count it would hold the line open for speech nobody will hear.
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(10))
    p.cleared()
    expect(p.msRemaining()).toBe(0)
  })

  it('starts cleanly after a barge-in', () => {
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(10))
    p.cleared()
    p.queued(secondsOfAudio(2))
    expect(p.msRemaining()).toBe(2000)
  })

  it('ignores empty and nonsense byte counts', () => {
    const p = createPlayoutTracker()
    p.queued(0); p.queued(-500); p.queued(undefined); p.queued(NaN)
    expect(p.msRemaining()).toBe(0)
  })

  it('never reports a negative remainder', () => {
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    p.queued(secondsOfAudio(1))
    c.advance(60_000)
    expect(p.msRemaining()).toBe(0)
  })
})

describe('a realistic closing line', () => {
  it('holds the line for the whole goodbye, not the moment generation stops', () => {
    // "Thank you andi, bye" is roughly two seconds of speech, produced by the model
    // in a burst that takes almost no wall-clock time. Closing when generation ends
    // would cut the caller off after the first syllable.
    const c = fakeClock()
    const p = createPlayoutTracker({ now: c.now })
    for (let i = 0; i < 10; i++) { p.queued(secondsOfAudio(0.2)); c.advance(4) }
    expect(p.msRemaining()).toBeGreaterThan(1900)
  })
})

describe('the provider hangup endpoint', () => {
  it('addresses the per-call resource', () => {
    const url = hangupUrl('MAXXXX', 'b09ad6b5-9438-43d6-b823-3e9e29e2bd55')
    expect(url).toMatch(/\/Account\/MAXXXX\/Call\/b09ad6b5-9438-43d6-b823-3e9e29e2bd55\/$/)
  })

  it('escapes a call id rather than pasting it into a path', () => {
    expect(hangupUrl('MA1', 'a/../b')).not.toContain('/../')
  })
})

describe('the end_call tool', () => {
  const decls = (cfg) => buildGeminiTools(cfg)[0]?.functionDeclarations || []
  const endCall = (cfg = {}) => decls(cfg).find(d => d.name === 'end_call')

  it('is offered to every agent, whatever else they have', () => {
    // A tenant with no knowledge base, no lookups and no handoff still needs to be
    // able to finish a call politely.
    expect(endCall({})).toBeTruthy()
    expect(endCall({ tenant_id: 't', enable_kb: false })).toBeTruthy()
    expect(endCall({ tenant_id: 't', lookups: [{ name: 'loan_status' }] })).toBeTruthy()
  })

  it('takes no required arguments, so it can never fail for want of one', () => {
    expect(endCall().parameters.required ?? []).toEqual([])
  })

  it('says plainly when NOT to use it', () => {
    const d = endCall().description
    expect(d).toMatch(/never call it mid-conversation/i)
    expect(d).toMatch(/NEVER on a turn you could not make out/i)
    expect(d).toMatch(/If you are not sure/i)
  })

  it('requires the closing line to have been said first', () => {
    expect(endCall().description).toMatch(/you have said your own closing line/i)
  })
})
