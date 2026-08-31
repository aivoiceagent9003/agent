// useVoiceCall — a browser voice call to a backend demo agent over /demo-stream.
//
// The browser is the audio transport: mic → 16kHz PCM up, 24kHz PCM (Gemini's
// native output) down, with barge-in handled via the server's "clear" event.
// Shared by the "Talk to Priya" hero and the industry demo section.

import { useEffect, useRef, useState } from "react";
import { WS_BASE } from "./api";
import { floatToPcm16Base64, StreamPlayer } from "./webcall";

export type VoiceStatus = "idle" | "connecting" | "live";

const ERRORS: Record<string, string> = {
  busy: "All demo lines are busy right now — please try again in a minute.",
  rate_limited: "You've used your demo calls for this hour. Book a demo and we'll show you more.",
  demo_disabled: "The live demo is temporarily unavailable.",
};

export function useVoiceCall() {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodesRef = useRef<{
    source?: MediaStreamAudioSourceNode;
    proc?: ScriptProcessorNode;
    sink?: GainNode;
  }>({});
  const playerRef = useRef<StreamPlayer | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => teardown(), []); // cleanup on unmount

  function teardown() {
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(JSON.stringify({ event: "stop" }));
    } catch {
      /* ignore */
    }
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    try {
      nodesRef.current.proc?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      nodesRef.current.source?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      nodesRef.current.sink?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      playerRef.current?.stop();
    } catch {
      /* ignore */
    }
    try {
      ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    wsRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
    playerRef.current = null;
    nodesRef.current = {};
  }

  function stop() {
    teardown();
    setStatus("idle");
    setRemaining(null);
  }

  async function start(sector: string) {
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
      // Build the continuous player up front so it's ready before the first frame.
      playerRef.current = await StreamPlayer.create(ctx, 24000);

      const ws = new WebSocket(`${WS_BASE}/demo-stream`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ event: "start", start: { sector, streamSid: "demo" } }));

        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0; // muted — no mic loopback, but keeps the node running
        proc.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const payload = floatToPcm16Base64(
            e.inputBuffer.getChannelData(0),
            ctx.sampleRate,
            16000,
          );
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
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.event === "media" && msg.media?.payload) {
          playerRef.current?.push(msg.media.payload);
        } else if (msg.event === "clear") {
          playerRef.current?.clear();
        } else if (msg.event === "started") {
          const secs = Number(msg.maxSeconds) || 90;
          setRemaining(secs);
          tickRef.current = setInterval(() => {
            setRemaining((r) => (r === null ? r : Math.max(0, r - 1)));
          }, 1000);
        } else if (msg.event === "ended") {
          setError("Demo time is up — book a demo to go deeper.");
          stop();
        } else if (msg.event === "error") {
          setError(ERRORS[msg.error] || "Could not start the demo call.");
          stop();
        }
      };

      ws.onerror = () => setError("Connection error");
      ws.onclose = () => setStatus((s) => (s === "idle" ? s : "idle"));
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Microphone permission denied — allow mic access to try the demo."
          : e?.message || "Could not start the call",
      );
      teardown();
      setStatus("idle");
    }
  }

  return { status, error, remaining, start, stop };
}
