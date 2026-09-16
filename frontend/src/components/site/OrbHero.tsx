import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2, PhoneOff } from "lucide-react";
import { orbPulse } from "./orbBus";
import { useVoiceCall } from "@/lib/useVoiceCall";
import { VoiceWave } from "./VoiceWave";

export function OrbHero() {
  // "Talk to Priya" is a REAL voice call to AnswerLabs' own sales agent.
  const { status, error, start, stop } = useVoiceCall();
  const talking = status !== "idle";
  const artRef = useRef<HTMLDivElement>(null);

  // Pulse the ambient orb while Priya is live.
  useEffect(() => {
    if (status !== "live") return;
    const id = setInterval(() => orbPulse(), 1400);
    return () => clearInterval(id);
  }, [status]);

  function talkToPriya() {
    if (talking) return;
    start("vocera");
  }

  return (
    <div className="forest-hero-wrap">
      <VoiceWave anchorRef={artRef} />
      <section className="forest-hero">
        <div className="forest-hero-copy enter-stagger">
          <div className="forest-eyebrow inline-flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-live" />
            AI voice agents for your business
          </div>

          <h1 className="forest-display forest-hero-title">
            Say hello to your
            <br />
            <em className="text-primary">business's voice.</em>
          </h1>

          <p className="mt-6 max-w-lg text-base md:text-lg leading-relaxed text-muted-foreground">
            Answers every call, captures the lead, books the meeting — in English and every Indian
            language.
          </p>

          <div className="mt-8 min-h-12 flex flex-col items-start gap-4">
            {status === "live" ? (
              <>
                <div className="glass-card rounded-full px-4 py-2 text-sm text-foreground animate-fade-up flex items-center gap-2">
                  <span className="relative flex w-2 h-2">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-60 animate-pulse-ring" />
                    <span className="relative inline-flex rounded-full w-2 h-2 bg-primary" />
                  </span>
                  <span className="text-primary font-medium">Priya is listening</span>
                  <span className="text-muted-foreground/70">· speak naturally</span>
                </div>
                <button
                  onClick={stop}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-secondary transition"
                >
                  <PhoneOff className="w-4 h-4" /> End call
                </button>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={talkToPriya}
                  disabled={status === "connecting"}
                  className="group inline-flex items-center gap-2.5 rounded-lg px-6 py-3.5 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-all disabled:opacity-70"
                >
                  {status === "connecting" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Connecting to Priya…
                    </>
                  ) : (
                    <>
                      <span className="relative flex w-2 h-2">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-50 animate-pulse-ring" />
                        <span className="relative inline-flex rounded-full w-2 h-2 bg-primary-foreground" />
                      </span>
                      Talk to Priya
                    </>
                  )}
                </button>
                <Link
                  to="/signup"
                  className="inline-flex items-center gap-2 rounded-lg border border-border text-foreground font-medium px-5 py-3.5 text-sm hover:bg-secondary transition-all"
                >
                  Start free <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground max-w-sm">
              Priya is AnswerLabs' own AI voice agent — talk to her live and hear exactly how your
              business's agent would sound.
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
        {/* Placeholder only: it holds the grid slot, and the orb is drawn at its centre. */}
        <div ref={artRef} className="forest-hero-art" aria-hidden="true" />
        <div className="forest-hero-footer enter-late" aria-hidden="true">
          <span>01 / Answer naturally</span>
          <span>02 / Understand intent</span>
          <span>03 / Keep your team connected</span>
        </div>
      </section>
    </div>
  );
}
