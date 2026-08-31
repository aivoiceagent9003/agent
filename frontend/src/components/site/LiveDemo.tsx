// LiveDemo — the public "try it live" section.
//
// A REAL voice call: the visitor picks a sector, allows the mic, and talks to the
// actual agent running the same Gemini Live engine a phone call uses. The call
// plumbing lives in the shared useVoiceCall hook (also used by "Talk to Priya").

import { useEffect, useState } from "react";
import { Phone, PhoneOff, Loader2, Mic } from "lucide-react";
import { BASE_URL } from "@/lib/api";
import { useVoiceCall } from "@/lib/useVoiceCall";

interface Sector {
  id: string;
  title: string;
  emoji: string;
  description: string;
}

// Shown until the backend list loads (keeps the section from flashing empty).
const FALLBACK_SECTORS: Sector[] = [
  {
    id: "real_estate",
    title: "Real Estate",
    emoji: "🏠",
    description: "Qualifies buyers and books site visits.",
  },
  {
    id: "clinic",
    title: "Clinic / Front Desk",
    emoji: "🩺",
    description: "Books appointments and answers patient queries.",
  },
  {
    id: "support",
    title: "Customer Support",
    emoji: "🎧",
    description: "Answers FAQs and triages issues 24/7.",
  },
];

export function LiveDemo() {
  const [sectors, setSectors] = useState<Sector[]>(FALLBACK_SECTORS);
  const [active, setActive] = useState(FALLBACK_SECTORS[0].id);
  const { status, error, remaining, start, stop } = useVoiceCall();

  useEffect(() => {
    fetch(`${BASE_URL}/api/public/demo/sectors`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (Array.isArray(list) && list.length) {
          setSectors(list);
          setActive((cur) => (list.some((s: Sector) => s.id === cur) ? cur : list[0].id));
        }
      })
      .catch(() => {
        /* keep fallback */
      });
  }, []);
  const live = status === "live";
  const current = sectors.find((s) => s.id === active);

  return (
    <section id="demos" className="py-24 bg-card/30">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-4xl md:text-5xl font-bold text-center">Talk to it yourself</h2>
        <p className="mt-3 text-muted-foreground text-center max-w-xl mx-auto">
          Pick an industry and have a real conversation — the same AI agent that answers your calls.
        </p>

        <div className="mt-12 grid md:grid-cols-3 gap-3">
          {sectors.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                if (!live) setActive(s.id);
              }}
              disabled={live}
              className={`text-left rounded-xl border p-5 transition disabled:opacity-60 disabled:cursor-not-allowed ${
                active === s.id
                  ? "border-primary bg-gradient-to-br from-primary/15 to-transparent shadow-glow"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className="text-3xl">{s.emoji}</div>
              <div className="mt-3 font-semibold">{s.title}</div>
              <div className="text-sm text-muted-foreground mt-1">{s.description}</div>
            </button>
          ))}
        </div>

        <div className="mt-10 max-w-2xl mx-auto">
          <div className="bg-card border border-border rounded-2xl p-8 shadow-card flex flex-col items-center gap-5">
            <div
              className={`w-24 h-24 rounded-full grid place-items-center shadow-glow transition ${
                live ? "bg-gradient-primary animate-pulse" : "bg-muted"
              }`}
            >
              {status === "connecting" ? (
                <Loader2 className="w-9 h-9 text-primary-foreground animate-spin" />
              ) : live ? (
                <Mic className="w-9 h-9 text-primary-foreground" />
              ) : (
                <Phone className="w-9 h-9 text-muted-foreground" />
              )}
            </div>

            <div className="text-center">
              <div className="font-medium">
                {status === "connecting"
                  ? "Connecting…"
                  : live
                    ? "Connected — start talking"
                    : `Try the ${current?.title ?? "demo"} agent`}
              </div>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                {live
                  ? "The agent will greet you, then listen and reply in its real voice — speak naturally, in English or your language."
                  : "A real voice call in your browser. No phone number, no signup — just allow your microphone."}
              </p>
              {live && remaining !== null && (
                <p className="text-xs text-muted-foreground mt-2">
                  Demo ends in {Math.floor(remaining / 60)}:
                  {String(remaining % 60).padStart(2, "0")}
                </p>
              )}
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
                onClick={() => start(active)}
                disabled={status === "connecting"}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-60"
              >
                <Phone className="w-4 h-4" /> Start live call
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
