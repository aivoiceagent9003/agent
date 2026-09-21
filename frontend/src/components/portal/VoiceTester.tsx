import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Loader2 } from "lucide-react";
import { WS_BASE, getToken } from "@/lib/api";
import { floatToPcm16Base64, StreamPlayer } from "@/lib/webcall";

type Status = "idle" | "connecting" | "live";

// Real web-call agent test: the browser is the audio transport, and the backend
// runs the SAME engine a phone call uses. Hi-fi audio (24kHz PCM out /
// 16kHz PCM in), so the client hears their agent at full quality.
export function VoiceTester({ config }: { config: any }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodesRef = useRef<{
    source?: MediaStreamAudioSourceNode;
    proc?: ScriptProcessorNode;
    sink?: GainNode;
  }>({});
  const playerRef = useRef<StreamPlayer | null>(null);

  useEffect(() => () => teardown(), []); // cleanup on unmount

  function teardown() {
    try {
      wsRef.current?.readyState === WebSocket.OPEN &&
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
    wsRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
    playerRef.current = null;
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
      // Continuous player ready before the first audio frame. The engine sends 24kHz
      // PCM to a browser rather than the 8kHz telephony codec.
      playerRef.current = await StreamPlayer.create(ctx, 24000);

      const ws = new WebSocket(`${WS_BASE}/test-stream`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Authenticate + start the engine with the (possibly unsaved) draft config.
        ws.send(
          JSON.stringify({
            event: "start",
            start: { token: getToken(), streamSid: "web", config },
          }),
        );

        // Capture mic → 16kHz PCM16 frames (what Soniox STT takes). ScriptProcessor
        // must be connected to the graph to run, so route it through a muted gain
        // node (no mic loopback).
        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0;
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
          // Barge-in: drop the agent's queued audio so it stops when you speak.
          playerRef.current?.clear();
        } else if (msg.event === "error") {
          setError(
            msg.error === "unauthorized"
              ? "Session expired — please sign in again."
              : "Test failed",
          );
          stop();
        }
      };

      ws.onerror = () => setError("Connection error");
      ws.onclose = () => setStatus((s) => (s === "idle" ? s : "idle"));
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Microphone permission denied."
          : e?.message || "Could not start the call",
      );
      teardown();
      setStatus("idle");
    }
  }

  const live = status === "live";

  return (
    <div className="bg-card border border-border rounded-xl shadow-card p-8 flex flex-col items-center gap-5 h-[420px] justify-center">
      <div
        className={`w-24 h-24 rounded-full grid place-items-center shadow-glow transition ${live ? "bg-gradient-primary animate-pulse" : "bg-muted"}`}
      >
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
          {status === "connecting"
            ? "Connecting…"
            : live
              ? "Connected — talk to your agent"
              : "Ready to test"}
        </div>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          {live
            ? "Your agent will greet you, then listen and reply in its real voice — exactly like a phone call."
            : "Starts a live voice session with your agent — same voice and language it uses on calls. No phone call is made."}
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
