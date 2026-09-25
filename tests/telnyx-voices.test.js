import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const RAMYA = 'Telnyx.Ultra.cf061d8b-a752-4865-81a2-57570a6e0565'

// A slice of what GET /v2/text-to-speech/voices returns. Note `label` is Telnyx's
// DESCRIPTION, and `name` carries the display name before " - ".
const VOICES = [
  { id: RAMYA, name: 'Ramya - Welcoming Host', gender: 'Female', language: 'te', label: 'Warm, welcoming Telugu female.' },
  { id: 'Telnyx.Ultra.aaa', name: 'Arjun - Steady Guide', gender: 'Male', language: 'hi', label: 'Calm Hindi male.' },
  { id: 'Telnyx.Ultra.bbb', name: 'Priya', gender: 'Female', language: 'en-IN', label: 'Indian English.' },
  { id: 'Telnyx.Ultra.ccc', name: 'Katie - Friendly', gender: 'Female', language: 'en', label: 'American English.' },
  { id: 'Telnyx.NaturalHD.ddd', name: 'Asha', gender: 'Female', language: 'hi', label: 'Not an Ultra voice.' },
]

let mod
beforeEach(async () => {
  vi.stubEnv('TELNYX_API_KEY', 'tx-key')
  vi.stubEnv('TELNYX_TTS_VOICE', '')
  vi.resetModules()
  mod = await import('../src/services/telnyx-voices.js')
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ voices: VOICES }) }))
})
afterEach(() => vi.unstubAllEnvs())

describe('the voices a tenant can pick', () => {
  it('offers only Ultra voices that speak an Indian language or Indian English', async () => {
    const voices = await mod.listTelnyxVoices()
    expect(voices.map(v => v.id)).toEqual([RAMYA, 'Telnyx.Ultra.aaa', 'Telnyx.Ultra.bbb'])
    expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tx-key')
  })

  it('maps Telnyx fields onto the ones the picker reads', async () => {
    const [ramya, , priya] = await mod.listTelnyxVoices()
    expect(ramya).toEqual({ id: RAMYA, label: 'Ramya', gender: 'female', accent: 'Telugu', note: 'Warm, welcoming Telugu female.', kind: 'built-in' })
    expect(priya).toMatchObject({ label: 'Priya', accent: 'Indian English' })
  })

  it('asks Telnyx once, not on every page load', async () => {
    await mod.listTelnyxVoices()
    await mod.listTelnyxVoices()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('still renders the picker when Telnyx cannot be reached', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect((await mod.listTelnyxVoices()).map(v => v.id)).toEqual([RAMYA])
  })

  it('does not call Telnyx without a key', async () => {
    vi.stubEnv('TELNYX_API_KEY', '')
    expect((await mod.listTelnyxVoices()).map(v => v.id)).toEqual([RAMYA])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('the voice a call is spoken in', () => {
  it('is the tenant\'s pick when it is a Telnyx voice', () => {
    expect(mod.resolveVoice({ tts_voice: 'Telnyx.Ultra.aaa' })).toBe('Telnyx.Ultra.aaa')
  })

  it('falls back to Ramya for anything Telnyx would refuse mid-call', () => {
    // Soniox and Gemini voice names from earlier engines are still in tenant configs.
    for (const cfg of [{}, { tts_voice: 'Ishita' }, { tts_voice: 'Kore' }, { voice: 'Kore' }, undefined]) {
      expect(mod.resolveVoice(cfg)).toBe(RAMYA)
    }
  })

  it('takes the server default from TELNYX_TTS_VOICE', async () => {
    vi.stubEnv('TELNYX_TTS_VOICE', 'Telnyx.Ultra.aaa')
    vi.resetModules()
    const fresh = await import('../src/services/telnyx-voices.js')
    expect(fresh.resolveVoice({})).toBe('Telnyx.Ultra.aaa')
  })
})
