// webcall.ts — Browser-as-transport audio helpers for talking to a live Gemini
// agent from a web page. The browser sends Gemini's native input (16kHz PCM16 up)
// and plays its native output (24kHz PCM16 down) with a click-free StreamPlayer.
// Shared by the client's agent tester and the public site demo / "Talk to Priya".

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Float32 PCM @ srcRate → base64 PCM16 little-endian @ dstRate.
export function floatToPcm16Base64(input: Float32Array, srcRate: number, dstRate = 16000): string {
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const bytes = new Uint8Array(outLen * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < outLen; i++) {
    let s = input[Math.floor(i * ratio)];
    s = Math.max(-1, Math.min(1, s));
    dv.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return bytesToBase64(bytes);
}

// ─── StreamPlayer — continuous, click-free playback of streamed PCM ───────────
//
// The model streams audio as MANY small chunks per second. Scheduling a separate
// AudioBufferSourceNode per chunk (the old approach) produces scheduling jitter →
// choppy, robotic audio. Instead we feed samples into ONE AudioWorklet that owns a
// sample-accurate queue and emits a continuous stream — no gaps, no clicks. Source
// audio is 24kHz; we resample to the context's rate before handing it over. On
// barge-in we post 'clear' to flush the queue instantly.

// The worklet runs in an isolated scope, so it's shipped as a self-contained source
// string and loaded from a Blob URL (no external file, CSP-friendly for same-origin).
const RING_WORKLET = `
class PcmRing extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.readOffset = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'clear') { this.chunks = []; this.readOffset = 0; }
      else if (e.data.type === 'samples') { this.chunks.push(e.data.samples); }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.chunks.length) {
      const head = this.chunks[0];
      const avail = head.length - this.readOffset;
      const take = Math.min(avail, out.length - i);
      out.set(head.subarray(this.readOffset, this.readOffset + take), i);
      i += take; this.readOffset += take;
      if (this.readOffset >= head.length) { this.chunks.shift(); this.readOffset = 0; }
    }
    for (; i < out.length; i++) out[i] = 0;   // silence when the queue drains
    return true;
  }
}
registerProcessor('pcm-ring', PcmRing);
`;

// Linear-resample Float32 PCM from srcRate to dstRate. No-op when they match.
function resampleFloat(pcm: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || pcm.length === 0) return pcm;
  const ratio = dstRate / srcRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = pos - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

export class StreamPlayer {
  private node: AudioWorkletNode;

  private constructor(
    private ctx: AudioContext,
    node: AudioWorkletNode,
    private srcRate: number,
  ) {
    this.node = node;
  }

  // Async because the worklet module must be loaded before the node exists.
  static async create(ctx: AudioContext, srcRate = 24000): Promise<StreamPlayer> {
    const url = URL.createObjectURL(new Blob([RING_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } catch {
      /* already registered on this context — fine */
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, "pcm-ring", {
      numberOfInputs: 0,
      outputChannelCount: [1],
    });
    node.connect(ctx.destination);
    return new StreamPlayer(ctx, node, srcRate);
  }

  push(b64: string) {
    const bytes = base64ToBytes(b64);
    const n = bytes.length >> 1;
    if (!n) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = dv.getInt16(i * 2, true) / 32768;
    const pcm = resampleFloat(raw, this.srcRate, this.ctx.sampleRate);
    // Transfer the buffer to the worklet (zero-copy).
    this.node.port.postMessage({ type: "samples", samples: pcm }, [pcm.buffer as ArrayBuffer]);
  }

  clear() {
    this.node.port.postMessage({ type: "clear" });
  }

  stop() {
    try {
      this.node.disconnect();
    } catch {
      /* already gone */
    }
  }
}
