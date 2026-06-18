import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Loader2 } from "lucide-react";
import { WS_BASE, getToken } from "@/lib/api";

// ─── G.711 µ-law codec + resampling (Twilio uses mulaw 8kHz) ─────────────────

function muLawEncode(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecode(u: number): number {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

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

// Float32 PCM @ srcRate → base64 µ-law @ 8kHz (nearest-sample downsample).
function floatToMulawBase64(input: Float32Array, srcRate: number): string {
  const ratio = srcRate / 8000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let s = input[Math.floor(i * ratio)];
    s = Math.max(-1, Math.min(1, s));
    const i16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    out[i] = muLawEncode(i16);
  }
  return bytesToBase64(out);
}

type Status = "idle" | "connecting" | "live";

// Real web-call agent test: the browser is the audio transport (like Twilio), and
// the backend runs the SAME pipeline a phone call uses. No telephony involved.
export function VoiceTester({ config }: { config: any }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodesRef = useRef<{ source?: MediaStreamAudioSourceNode; proc?: ScriptProcessorNode; sink?: GainNode }>({});
  const playTimeRef = useRef(0);

  useEffect(() => () => teardown(), []); // cleanup on unmount

  function teardown() {
    try { wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ event: "stop" })); } catch { /* ignore */ }
    try { wsRef.current?.close(); } catch { /* ignore */ }
    try { nodesRef.current.proc?.disconnect(); } catch { /* ignore */ }
    try { nodesRef.current.source?.disconnect(); } catch { /* ignore */ }
    try { nodesRef.current.sink?.disconnect(); } catch { /* ignore */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { ctxRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
    nodesRef.current = {};
  }

  function stop() {
    teardown();
    setStatus("idle");
  }

  async function start() {
    setError(null);
    setStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      ctxRef.current = ctx;
      await ctx.resume();
      playTimeRef.current = ctx.currentTime;

      const ws = new WebSocket(`${WS_BASE}/test-stream`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Authenticate + start the pipeline with the (possibly unsaved) draft config.
        ws.send(JSON.stringify({ event: "start", start: { token: getToken(), streamSid: "web", config } }));

        // Capture mic → mulaw frames. ScriptProcessor must be connected to the
        // graph to run, so route it through a muted gain node (no mic loopback).
        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0;
        proc.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const payload = floatToMulawBase64(e.inputBuffer.getChannelData(0), ctx.sampleRate);
          ws.send(JSON.stringify({ event: "media", media: { payload } }));
        };
        source.connect(proc);
        proc.connect(sink);
        sink.connect(ctx.destination);
        nodesRef.current = { source, proc, sink };
        setStatus("live");
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.event === "media" && msg.media?.payload) {
          schedulePlayback(msg.media.payload, ctx);
        } else if (msg.event === "error") {
          setError(msg.error === "unauthorized" ? "Session expired — please sign in again." : "Test failed");
          stop();
        }
      };

      ws.onerror = () => setError("Connection error");
      ws.onclose = () => setStatus((s) => (s === "idle" ? s : "idle"));
    } catch (e: any) {
      setError(e?.name === "NotAllowedError" ? "Microphone permission denied." : e?.message || "Could not start the call");
      teardown();
      setStatus("idle");
    }
  }

  function schedulePlayback(b64: string, ctx: AudioContext) {
    const bytes = base64ToBytes(b64);
    const pcm = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) pcm[i] = muLawDecode(bytes[i]) / 32768;
    const buf = ctx.createBuffer(1, pcm.length, 8000);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (playTimeRef.current < now) playTimeRef.current = now + 0.05;
    src.start(playTimeRef.current);
    playTimeRef.current += buf.duration;
  }

  const live = status === "live";

  return (
    <div className="bg-card border border-border rounded-xl shadow-card p-8 flex flex-col items-center gap-5 h-[420px] justify-center">
      <div className={`w-24 h-24 rounded-full grid place-items-center shadow-glow transition ${live ? "bg-gradient-primary animate-pulse" : "bg-muted"}`}>
        {status === "connecting" ? (
          <Loader2 className="w-9 h-9 text-primary-foreground animate-spin" />
        ) : live ? (
          <Phone className="w-9 h-9 text-primary-foreground" />
        ) : (
          <Phone className="w-9 h-9 text-muted-foreground" />
        )}
      </div>

      <div className="text-center">
        <div className="font-medium">
          {status === "connecting" ? "Connecting…" : live ? "Connected — talk to your agent" : "Ready to test"}
        </div>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          {live
            ? "Your agent will greet you, then listen and reply in its real voice — exactly like a phone call."
            : "Starts a live voice session using your real STT, language, and voice pipeline. No phone call is made."}
        </p>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </div>

      {live ? (
        <button
          onClick={stop}
          className="inline-flex items-center gap-2 bg-destructive text-destructive-foreground rounded-lg px-5 py-2.5 text-sm font-medium hover:opacity-90"
        >
          <PhoneOff className="w-4 h-4" /> End call
        </button>
      ) : (
        <button
          onClick={start}
          disabled={status === "connecting"}
          className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-60"
        >
          <Phone className="w-4 h-4" /> Start test call
        </button>
      )}
    </div>
  );
}
