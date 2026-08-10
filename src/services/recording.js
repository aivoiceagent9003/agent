// services/recording.js — capture a playable recording of the call.
//
// WHY: in a speech-to-speech engine the live caller transcription is an unreliable
// side-channel (it mis-transcribes Indic speech into the wrong language). The audio
// itself is the ground truth, so for the client dashboard we record the call and
// show the RECORDING + an English summary instead of a noisy transcript.
//
// HOW: both legs are g711 μ-law 8kHz. We tap the INBOUND caller frames and the
// OUTBOUND agent frames, decode each to PCM16, and place them on a shared wall-clock
// timeline (8 samples/ms) into one MONO track. Each leg has its own write cursor and
// frames are laid CONTIGUOUSLY (so normal network jitter never inserts clicks/gaps
// mid-speech); the cursor only jumps to wall-clock time on a genuine pause (a gap
// bigger than GAP_RESYNC), which keeps the two legs roughly aligned. Capture is just
// buffering (no live latency); the WAV is encoded + uploaded to Storage POST-call.

import { supabase, supabaseAdmin } from '../api/db.js'

const BUCKET = 'call-recordings'
const store = supabaseAdmin || supabase          // service-role bypasses Storage RLS
const SAMPLE_RATE = 8000
const MAX_PCM_BYTES = 60 * 60 * SAMPLE_RATE * 2   // ~1 hour cap, safety against runaway buffers
// A stream is laid contiguously to absorb network jitter; only a gap LARGER than this
// (a real pause/turn boundary) re-syncs the cursor to wall-clock arrival time.
const GAP_RESYNC = Math.floor(0.4 * SAMPLE_RATE)  // 400ms

// μ-law → PCM16 decode table (G.711).
const MULAW_DECODE = (() => {
  const t = new Int16Array(256)
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xFF
    const sign = u & 0x80
    const exp = (u >> 4) & 0x07
    let mant = ((u & 0x0F) << 1) + 33
    if (exp > 0) mant += 0x100
    if (exp > 1) mant <<= exp - 1
    t[i] = sign ? 33 - mant : mant - 33
  }
  return t
})()

function mulawToPcm16LE(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2)
  for (let i = 0; i < mulawBuf.length; i++) pcm.writeInt16LE(MULAW_DECODE[mulawBuf[i]], i * 2)
  return pcm
}

// Wrap a PCM16 mono buffer in a 44-byte WAV header.
function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE, channels = 1) {
  const byteRate = sampleRate * channels * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)            // fmt chunk size
  header.writeUInt16LE(1, 20)             // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)  // block align
  header.writeUInt16LE(16, 34)            // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export class CallRecorder {
  constructor() {
    this.t0 = Date.now()
    this.events = []          // { offset (samples from t0), pcm (PCM16 LE Buffer) }
    this.endSample = 0        // last sample index touched (defines total length)
    this.pcmBytes = 0         // running size, for the safety cap
    this.cursor = { in: 0, out: 0 }   // per-leg write head (samples)
  }

  // Place a frame on the shared timeline. Each LEG keeps its own cursor and frames
  // are laid CONTIGUOUSLY from it, so neither a faster-than-real-time burst (the model
  // streaming a reply) nor ordinary network jitter creates overlaps or mid-speech
  // silence gaps — both were sources of disturbance. The cursor only jumps to the
  // wall-clock arrival time when arrival runs ahead by more than GAP_RESYNC, i.e. a
  // genuine pause/turn boundary, which keeps the two legs roughly aligned.
  _add(leg, mulawBuf) {
    if (!mulawBuf?.length || this.pcmBytes >= MAX_PCM_BYTES) return
    const arrival = Math.floor(((Date.now() - this.t0) / 1000) * SAMPLE_RATE)
    const cur = this.cursor[leg]
    const pos = arrival - cur > GAP_RESYNC ? arrival : cur
    const pcm = mulawToPcm16LE(mulawBuf)
    const len = pcm.length >> 1
    this.cursor[leg] = pos + len
    this.events.push({ offset: pos, pcm })
    this.pcmBytes += pcm.length
    this.endSample = Math.max(this.endSample, pos + len)
  }

  addInbound(mulawBuf) { this._add('in', mulawBuf) }    // caller audio
  addOutbound(mulawBuf) { this._add('out', mulawBuf) }  // agent audio

  isEmpty() { return this.events.length === 0 }

  // Render all captured frames into a single MONO WAV Buffer (or null). Within-leg
  // overlap is already prevented by the cursor, so summation here only happens when
  // both legs are genuinely active at once (barge-in) — clamped to avoid clipping.
  toWav() {
    if (!this.endSample) return null
    const mix = new Int16Array(this.endSample)
    for (const { offset, pcm } of this.events) {
      const n = pcm.length >> 1
      for (let i = 0; i < n; i++) {
        const idx = offset + i
        if (idx < 0 || idx >= mix.length) continue
        let v = mix[idx] + pcm.readInt16LE(i << 1)
        if (v > 32767) v = 32767
        else if (v < -32768) v = -32768
        mix[idx] = v
      }
    }
    return pcm16ToWav(Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength))
  }
}

// Upload a WAV recording to Storage; returns the storage path (or null on failure).
export async function uploadRecording(tenantId, callId, wavBuffer) {
  if (!wavBuffer?.length || !callId) return null
  const path = `${tenantId || 'unknown'}/${callId}.wav`
  try {
    const { error } = await store.storage.from(BUCKET).upload(path, wavBuffer, {
      contentType: 'audio/wav',
      upsert: true,
    })
    if (error) { console.error('[REC] upload failed:', error.message); return null }
    console.log(`[REC] 💾 recording saved (${(wavBuffer.length / 1024).toFixed(0)} KB) → ${path}`)
    return path
  } catch (e) {
    console.error('[REC] upload error:', e.message)
    return null
  }
}

// Signed, time-limited URL for playback in the dashboard.
export async function getRecordingUrl(path, expiresIn = 60 * 60 * 24 * 7) {
  if (!path) return null
  try {
    const { data, error } = await store.storage.from(BUCKET).createSignedUrl(path, expiresIn)
    if (error) { console.error('[REC] signed url failed:', error.message); return null }
    return data?.signedUrl || null
  } catch (e) {
    console.error('[REC] signed url error:', e.message)
    return null
  }
}
