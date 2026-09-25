import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openSarvamStt, SARVAM_STT_URL } from '../src/services/sarvam-stt.js'

// A socket that records what the adapter sends and lets a test play Sarvam's side.
class FakeSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 1; this.sent = []; FakeSocket.last = this }
  send(d) { this.sent.push(d) }
  close() { this.readyState = 3 }
}
const open = (extra = {}) => {
  const stt = openSarvamStt({ apiKey: 'sk', format: 'mulaw', sampleRate: 8000, silenceMs: 600, WebSocketImpl: FakeSocket, ...extra })
  return { stt, ws: FakeSocket.last }
}
const heard = (stt) => { const got = []; stt.on('message', (raw) => got.push(JSON.parse(raw.toString()))); return got }
const sarvamSays = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)))

describe('openSarvamStt', () => {
  it('connects for 8kHz µ-law phone audio, auto language, code-mix, and the chosen silence', () => {
    const { ws } = open({ prompt: 'Product names you may hear: Vaayu, LifeShield, Supreme.' })
    const url = new URL(ws.url)
    expect(`${url.origin}${url.pathname}`.replace('https', 'wss')).toBe(SARVAM_STT_URL)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      language_code: 'auto', encoding: 'mulaw', sample_rate: '8000', mode: 'codemix',
      endpointing: 'vad', silence_duration_ms: '600', return_timestamps: 'true',
      prompt: 'Product names you may hear: Vaayu, LifeShield, Supreme.',
    })
    expect(ws.opts.headers['API-SUBSCRIPTION-KEY']).toBe('sk')
  })

  it('sends keyterms only to saaras:v4, as a JSON array — anything else makes Sarvam refuse the session', () => {
    // Measured: a comma list gets "'keyterms' must be a valid JSON array of strings", and
    // keyterms on v3-realtime get "only supported by model 'saaras:v4'" — either one and
    // the call hears nothing at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const v3 = new URL(open({ keyterms: 'Secure, Supreme' }).ws.url).searchParams
    expect(v3.has('keyterms')).toBe(false)
    const v4 = new URL(open({ keyterms: 'Secure, Supreme', model: 'saaras:v4' }).ws.url).searchParams
    expect(JSON.parse(v4.get('keyterms'))).toEqual(['Secure', 'Supreme'])
    warn.mockRestore()
  })

  it('can change the vocabulary prompt mid-call', () => {
    const { stt, ws } = open()
    stt.configure({ prompt: 'Product names you may hear: Kavach.' })
    expect(JSON.parse(ws.sent.at(-1))).toEqual({ event: 'config.update', prompt: 'Product names you may hear: Kavach.' })
  })

  it('asks for 16-bit PCM from a browser caller', () => {
    const { ws } = open({ format: 'pcm_s16le', sampleRate: 16000 })
    const q = new URL(ws.url).searchParams
    expect([q.get('encoding'), q.get('sample_rate')]).toEqual(['linear16', '16000'])
  })

  it('wraps audio as base64 audio_input, and drops anything else', () => {
    const { stt, ws } = open()
    stt.send(Buffer.from([1, 2, 3]))
    stt.send(JSON.stringify({ type: 'finalize' }))
    expect(ws.sent.map(s => JSON.parse(s))).toEqual([{ event: 'audio_input', audio: Buffer.from([1, 2, 3]).toString('base64') }])
  })

  it('turns a partial into unfinished words and a final into finished words plus <end>, timed at the speech end', () => {
    // end_s includes Sarvam's own 600ms silence window; end_ms is where the words stopped.
    const { stt, ws } = open()
    const got = heard(stt)
    sarvamSays(ws, { event: 'vad.speech_start', utterance_idx: 0 })
    sarvamSays(ws, { event: 'transcript.partial', utterance_idx: 0, text: 'నేను term', language: 'te-IN' })
    sarvamSays(ws, { event: 'transcript.final', utterance_idx: 0, text: 'నేను term insurance చూస్తున్నాను', language: 'te-IN', start_s: '0.3', end_s: '2.45' })
    expect(got).toEqual([
      { tokens: [{ text: 'నేను term', is_final: false, language: 'te' }] },
      { tokens: [{ text: 'నేను term insurance చూస్తున్నాను', is_final: true, language: 'te', end_ms: 1850 }, { text: '<end>', is_final: true }] },
    ])
  })

  it('still ends the turn on an empty final, so nothing waits on it', () => {
    const { stt, ws } = open()
    const got = heard(stt)
    sarvamSays(ws, { event: 'transcript.final', utterance_idx: 1, text: '' })
    expect(got).toEqual([{ tokens: [{ text: '<end>', is_final: true }] }])
  })

  it('passes Sarvam errors through in the shape the cascade already logs', () => {
    const { stt, ws } = open()
    const got = heard(stt)
    sarvamSays(ws, { event: 'error', code: 'invalid_config', message: 'bad sample rate', is_fatal: true })
    expect(got).toEqual([{ error_code: 'invalid_config', error_message: 'bad sample rate' }])
  })
})
