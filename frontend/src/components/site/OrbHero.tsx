import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2, PhoneOff } from "lucide-react";
import { orbPulse } from "./orbBus";
import { useVoiceCall } from "@/lib/useVoiceCall";

export function OrbHero() {
  // "Talk to Priya" is a REAL voice call to Vocera's own sales agent.
  const { status, error, start, stop } = useVoiceCall();
  const talking = status !== "idle";

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
    <section className="relative min-h-[90vh] flex flex-col items-center justify-center text-center px-6 pt-24 pb-20">
      {/* A readable scrim so the hero copy always sits above the orb behind it. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-background/45" />

      <div className="relative z-10 flex flex-col items-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-live" />
          AI voice agents for your business
        </div>

        <h1 className="mt-6 text-4xl md:text-7xl font-semibold tracking-tight text-foreground leading-[1.03]">
          Say hello to your<br />
          <span className="text-iridescent">business's voice.</span>
        </h1>

        <p className="mt-5 max-w-lg text-base md:text-lg text-muted-foreground">
          Answers every call, captures the lead, books the meeting — in English and
          every Indian language.
        </p>

        <div className="mt-8 min-h-12 flex flex-col items-center gap-3">
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
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={talkToPriya}
                disabled={status === "connecting"}
                className="group inline-flex items-center gap-2.5 rounded-full px-6 py-3 text-sm font-medium text-foreground ring-iridescent shadow-glow hover:-translate-y-0.5 transition-all disabled:opacity-70"
              >
                {status === "connecting" ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Connecting to Priya…</>
                ) : (
                  <>
                    <span className="relative flex w-2 h-2">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-50 animate-pulse-ring" />
                      <span className="relative inline-flex rounded-full w-2 h-2 bg-primary" />
                    </span>
                    Talk to Priya
                  </>
                )}
              </button>
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 rounded-full bg-gradient-primary text-primary-foreground font-medium px-5 py-3 text-sm shadow-glow hover:-translate-y-0.5 transition-all"
              >
                Start free <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}
          <p className="text-xs text-muted-foreground max-w-sm">
            Priya is Vocera's own AI voice agent — talk to her live and hear exactly how your
            business's agent would sound.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  );
}
