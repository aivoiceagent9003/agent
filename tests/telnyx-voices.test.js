import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const RAMYA = 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'
// The languages a caller can choose (call-language.js), by the accent names the picker shows.
const CHOOSABLE_ACCENTS = ['Indian English', 'Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali']

let mod
beforeEach(async () => {
  vi.stubEnv('TELNYX_TTS_VOICE', '')
  vi.resetModules()
  globalThis.fetch = vi.fn()
  mod = await import('../src/services/telnyx-voices.js')
})
afterEach(() => vi.unstubAllEnvs())

// The picker used to list every Indian voice on the account — ~120, 58 of them Hindi,
// storytellers and film actors among them. Too many choices, many wrong for a phone line.
describe('the voices a tenant can pick', () => {
  it('offers at most three per language', async () => {
    const counts = {}
    for (const v of await mod.listTelnyxVoices()) counts[v.accent] = (counts[v.accent] || 0) + 1
    for (const [accent, n] of Object.entries(counts)) expect(n, accent).toBeLessThanOrEqual(3)
  })

  it('offers only the languages a caller can choose, every one of them', async () => {
    const accents = new Set((await mod.listTelnyxVoices()).map(v => v.accent))
    expect([...accents].sort()).toEqual([...CHOOSABLE_ACCENTS].sort())
  })

  it('keeps Ramya for Telugu, marked as the default', async () => {
    const voices = await mod.listTelnyxVoices()
    expect(voices.find(v => v.id === RAMYA)).toMatchObject({ label: 'Ramya', accent: 'Telugu', isDefault: true })
    expect(voices.filter(v => v.isDefault)).toHaveLength(1)
  })

  it('offers only Ultra voices, each once, with what the picker reads', async () => {
    const voices = await mod.listTelnyxVoices()
    expect(new Set(voices.map(v => v.id)).size).toBe(voices.length)
    for (const v of voices) {
      expect(v.id).toMatch(/^Telnyx\.Ultra\.[0-9a-f-]{36}$/)
      expect(v).toMatchObject({ label: expect.any(String), note: expect.any(String), kind: 'built-in' })
      expect(['female', 'male']).toContain(v.gender)
    }
  })

  it('needs no call to Telnyx to render the picker', async () => {
    await mod.listTelnyxVoices()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('the voice a call is spoken in', () => {
  it('is the tenant\'s pick when it is a Telnyx voice', () => {
    expect(mod.resolveVoice({ tts_voice: 'Telnyx.Ultra.07bc462a-c644-49f1-baf7-82d5599131be' }))
      .toBe('Telnyx.Ultra.07bc462a-c644-49f1-baf7-82d5599131be')
  })

  it('keeps a voice picked before the list was trimmed', () => {
    // Shortening the picker must not change what anyone's calls already sound like.
    expect(mod.resolveVoice({ tts_voice: 'Telnyx.Ultra.aaa' })).toBe('Telnyx.Ultra.aaa')
  })

  it('falls back to Ramya for anything Telnyx would refuse mid-call', () => {
    // Soniox and Gemini voice names from earlier engines are still in tenant configs —
    // and `voice` is not the key a call reads at all.
    for (const cfg of [{}, { tts_voice: 'Ishita' }, { tts_voice: 'Kore' }, { voice: 'Kore' }, { voice: 'Telnyx.Ultra.aaa' }, undefined]) {
      expect(mod.resolveVoice(cfg)).toBe(RAMYA)
    }
  })

  it('takes the server default from TELNYX_TTS_VOICE, and marks it in the picker', async () => {
    const sindhu = 'Telnyx.Ultra.07bc462a-c644-49f1-baf7-82d5599131be'
    vi.stubEnv('TELNYX_TTS_VOICE', sindhu)
    vi.resetModules()
    const fresh = await import('../src/services/telnyx-voices.js')
    expect(fresh.resolveVoice({})).toBe(sindhu)
    expect((await fresh.listTelnyxVoices()).find(v => v.isDefault)?.id).toBe(sindhu)
  })
})
