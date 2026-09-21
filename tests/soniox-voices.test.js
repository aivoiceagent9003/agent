import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listSonioxVoices, resolveSonioxVoice, _resetVoiceCache } from '../src/services/soniox-voices.js'

const MODELS = {
  models: [{
    id: 'tts-rt-v2',
    voices: [
      { id: 'Arjun', gender: 'male', description: 'Indian English.' },
      { id: 'Kavya', gender: 'female', description: 'Hindi.' },
    ],
  }],
}
const CLONES = {
  voices: [
    { id: 'b3b44c31-d781-40c1-a140-ad374ab299d7', name: 'Madhu', models: [{ model: 'tts-rt-v2', status: 'ready' }] },
    { id: 'not-ready-uuid', name: 'Half baked', models: [{ model: 'tts-rt-v2', status: 'training' }] },
  ],
}

beforeEach(() => {
  _resetVoiceCache()
  vi.stubEnv('SONIOX_API_KEY', 'k')
  globalThis.fetch = vi.fn(async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/tts-models') ? MODELS : CLONES),
  }))
})
afterEach(() => vi.unstubAllEnvs())

describe('the voices a tenant can choose', () => {
  it('offers built-in voices and the account\'s own clones', async () => {
    const v = await listSonioxVoices()
    expect(v.map(x => x.name)).toEqual(['Madhu', 'Arjun', 'Kavya'])
    expect(v[0].kind).toBe('cloned')
    expect(v[1].kind).toBe('built-in')
  })

  it('puts clones first — someone who cloned a voice is looking for it', async () => {
    expect((await listSonioxVoices())[0].name).toBe('Madhu')
  })

  it('hides a clone Soniox has not finished training', async () => {
    const v = await listSonioxVoices()
    expect(v.some(x => x.name === 'Half baked')).toBe(false)
  })

  it('identifies a clone by its UUID, which is what goes in the config', async () => {
    const clone = (await listSonioxVoices()).find(v => v.kind === 'cloned')
    expect(clone.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('still renders a picker when Soniox is unreachable', async () => {
    // An empty dropdown is a broken page; a slightly stale name is not.
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') })
    _resetVoiceCache()
    const v = await listSonioxVoices()
    expect(v.length).toBeGreaterThan(0)
    expect(v.every(x => x.kind === 'built-in')).toBe(true)
  })

  it('does not re-ask Soniox for every page load', async () => {
    await listSonioxVoices()
    const calls = globalThis.fetch.mock.calls.length
    await listSonioxVoices()
    expect(globalThis.fetch.mock.calls.length).toBe(calls)
  })
})

describe('which voice a call actually speaks with', () => {
  it('reads tts_voice, not voice', async () => {
    // `voice` held a Gemini Live name for years. Handing "Kore" to Soniox is a 400 in
    // the middle of a call, so a tenant carrying an old value gets the default instead.
    expect(resolveSonioxVoice({ tts_voice: 'Arjun', voice: 'Kore' })).toBe('Arjun')
    vi.stubEnv('SONIOX_TTS_VOICE', 'Adrian')
    expect(resolveSonioxVoice({ voice: 'Kore' })).toBe('Adrian')
  })

  it('falls back to the server default, then to a real built-in name', () => {
    vi.stubEnv('SONIOX_TTS_VOICE', '')
    expect(resolveSonioxVoice({})).toBe('Adrian')
  })
})
