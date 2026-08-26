// G.711 μ-law conversion and resampling.
//
// This is the narrowest, most load-bearing code in the product: every byte of
// every call passes through it. A regression here does not throw — it produces
// noise, or silence, on every call at once, and the first report is a customer
// saying "the agent didn't say anything."

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8to16,
  downsample24to8,
} from '../src/services/gemini-live.js'

describe('μ-law ↔ PCM16', () => {
  it('round-trips all 256 μ-law codes but the signed-zero alias', () => {
    // μ-law is lossy against arbitrary PCM, but decoding a code yields exactly one
    // quantisation level, so re-encoding it MUST return the code you started with.
    // Drift here means the encoder and decoder disagree about the companding curve
    // — audible as distortion rather than as a crash, which is why nothing ever
    // reported it. This assertion caught exactly that: 238 of 256 codes were wrong
    // because the decoder used bias 33 and shifted by exp-1 instead of G.711's
    // bias 132 and exp.
    //
    // 0x7F is the one legitimate exception. G.711 has two zeros — 0x7F (+0) and
    // 0xFF (−0) — both decoding to 0, and encoding 0 yields 0xFF. So 0x7F cannot
    // survive a round trip in any correct implementation.
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const back = pcm16ToMulaw(mulawToPcm16(all))
    const wrong = []
    for (let i = 0; i < 256; i++) if (back[i] !== all[i]) wrong.push({ code: i, got: back[i] })
    expect(wrong).toEqual([{ code: 0x7f, got: 0xff }])
  })

  it('decodes to the G.711 peak magnitude of 32124', () => {
    // The specific number matters. The previous decoder peaked at 20383, and being
    // wrong by a constant would merely have been quiet — it was wrong by a factor
    // varying from 0.25x to 1.94x across the range, which reshapes the waveform.
    // Pinning the peak is the cheapest guard against that class of drift returning.
    const pcm = mulawToPcm16(Buffer.from([0x80, 0x00]))
    expect(pcm.readInt16LE(0)).toBe(32124)
    expect(pcm.readInt16LE(2)).toBe(-32124)
  })

  it('decodes to twice the byte length and encodes back to half', () => {
    const mulaw = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x55])
    const pcm = mulawToPcm16(mulaw)
    expect(pcm.length).toBe(mulaw.length * 2)
    expect(pcm16ToMulaw(pcm).length).toBe(mulaw.length)
  })

  it('spans the full signed range and keeps sign symmetry', () => {
    const pcm = mulawToPcm16(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
    const vals = []
    for (let i = 0; i < 256; i++) vals.push(pcm.readInt16LE(i * 2))
    const max = Math.max(...vals)
    const min = Math.min(...vals)
    expect(max).toBeGreaterThan(30000)
    expect(min).toBeLessThan(-30000)
    // Codes 0x00 and 0x80 differ only in the sign bit, so must mirror each other.
    expect(pcm.readInt16LE(0x00 * 2)).toBe(-pcm.readInt16LE(0x80 * 2))
  })

  it('clamps rather than wrapping when PCM exceeds the μ-law range', () => {
    // Wrapping would turn the loudest samples into the quietest — a loud caller
    // would come through as crackle. Clamping is the only safe failure.
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(32767, 0)
    pcm.writeInt16LE(-32768, 2)
    const encoded = pcm16ToMulaw(pcm)
    const decoded = mulawToPcm16(encoded)
    expect(decoded.readInt16LE(0)).toBeGreaterThan(30000)
    expect(decoded.readInt16LE(2)).toBeLessThan(-30000)
  })

  it('survives empty input from either direction', () => {
    expect(mulawToPcm16(Buffer.alloc(0)).length).toBe(0)
    expect(pcm16ToMulaw(Buffer.alloc(0)).length).toBe(0)
  })

  it('ignores a trailing half-sample instead of reading past the buffer', () => {
    // Frames arrive off the wire and are not guaranteed to be even-length. Reading
    // a 16-bit sample from the final odd byte would throw and kill the call.
    const odd = Buffer.alloc(5)
    expect(() => pcm16ToMulaw(odd)).not.toThrow()
    expect(pcm16ToMulaw(odd).length).toBe(2)
  })
})

describe('resampling', () => {
  it('upsamples 8k→16k by doubling the sample count', () => {
    const pcm8 = Buffer.alloc(6) // 3 samples
    pcm8.writeInt16LE(1000, 0)
    pcm8.writeInt16LE(2000, 2)
    pcm8.writeInt16LE(3000, 4)
    const out = upsample8to16(pcm8)
    expect(out.length).toBe(pcm8.length * 2)
    // Originals preserved at even positions, interpolations between them.
    expect(out.readInt16LE(0)).toBe(1000)
    expect(out.readInt16LE(2)).toBe(1500)
    expect(out.readInt16LE(4)).toBe(2000)
    expect(out.readInt16LE(6)).toBe(2500)
    expect(out.readInt16LE(8)).toBe(3000)
  })

  it('holds the last sample rather than interpolating toward zero at the tail', () => {
    // Interpolating the final sample toward 0 injects a click at every frame
    // boundary — 50 times a second, which is audible as a buzz.
    const pcm8 = Buffer.alloc(2)
    pcm8.writeInt16LE(4000, 0)
    const out = upsample8to16(pcm8)
    expect(out.readInt16LE(0)).toBe(4000)
    expect(out.readInt16LE(2)).toBe(4000)
  })

  it('downsamples 24k→8k by averaging each group of three', () => {
    const pcm24 = Buffer.alloc(6)
    pcm24.writeInt16LE(300, 0)
    pcm24.writeInt16LE(600, 2)
    pcm24.writeInt16LE(900, 4)
    const out = downsample24to8(pcm24)
    expect(out.length).toBe(2)
    expect(out.readInt16LE(0)).toBe(600) // (300+600+900)/3
  })

  it('preserves duration through a 24k→8k→16k pipeline', () => {
    // 30ms at 24kHz = 720 samples → 240 at 8kHz → 480 at 16kHz.
    const pcm24 = Buffer.alloc(720 * 2)
    for (let i = 0; i < 720; i++) pcm24.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), i * 2)
    const at8 = downsample24to8(pcm24)
    expect(at8.length / 2).toBe(240)
    expect(upsample8to16(at8).length / 2).toBe(480)
  })

  it('does not throw on buffers that are not a whole group of three', () => {
    for (const bytes of [0, 2, 4, 8, 10]) {
      expect(() => downsample24to8(Buffer.alloc(bytes))).not.toThrow()
    }
  })
})

describe('real captured audio', () => {
  const fixture = readFileSync(new URL('../test_output.mulaw', import.meta.url))

  it('round-trips a real μ-law capture byte-for-byte', () => {
    expect(fixture.length).toBeGreaterThan(1000)
    const back = pcm16ToMulaw(mulawToPcm16(fixture))
    expect(back.equals(fixture)).toBe(true)
  })

  it('decodes to something with actual signal in it, not silence', () => {
    // A conversion that returns all zeros passes every length assertion above
    // while producing a dead call, so assert the audio is not flat.
    const pcm = mulawToPcm16(fixture)
    let peak = 0
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)))
    expect(peak).toBeGreaterThan(500)
  })
})
