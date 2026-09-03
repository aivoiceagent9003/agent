import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  PhoneIncoming,
  Languages,
  CalendarCheck,
  UserCheck,
} from "lucide-react";
import { Reveal } from "@/components/Motion";

// ─── Interactive call simulation ─────────────────────────────────────────────
// A self-playing, realistic conversation — the product working, not a screenshot.
const SCRIPT: { who: "customer" | "agent"; text: string }[] = [
  { who: "customer", text: "Hi, do you have 3BHK apartments in Kokapet?" },
  { who: "agent", text: "We do. May I ask your budget range, sir?" },
  { who: "customer", text: "Around 2.4 crore." },
  {
    who: "agent",
    text: "My Home Apas starts at 2.4 crore in Kokapet. Shall I arrange a site visit this weekend?",
  },
  { who: "customer", text: "Yes, Saturday morning works." },
  {
    who: "agent",
    text: "Booked for Saturday, 11 AM. You'll get a confirmation on WhatsApp shortly.",
  },
];

function useCallPlayer() {
  const [shown, setShown] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const done = shown >= SCRIPT.length;
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const clock = window.setInterval(() => setSeconds((s) => (done ? s : s + 1)), 1000);
    return () => window.clearInterval(clock);
  }, [done]);

  useEffect(() => {
    function run() {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setShown(0);
      setSeconds(0);
      SCRIPT.forEach((_, i) => {
        timers.current.push(window.setTimeout(() => setShown(i + 1), 1100 + i * 1700));
      });
      // loop
      timers.current.push(window.setTimeout(run, 1100 + SCRIPT.length * 1700 + 4200));
    }
    run();
    return () => timers.current.forEach(clearTimeout);
  }, []);

  return { shown, seconds, done };
}

function Equalizer() {
  return (
    <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2px] bg-[var(--color-primary-glow)] rounded-full animate-eq origin-bottom"
          style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

function CallSimulation() {
  const { shown, seconds, done } = useCallPlayer();
  const lastWho = shown > 0 ? SCRIPT[shown - 1].who : null;
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
      {/* Console header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border">
        <div className="w-9 h-9 rounded-full bg-secondary grid place-items-center">
          <PhoneIncoming className="w-4 h-4 text-foreground/70" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-medium">+91 98490 ·· 2238</div>
          <div className="text-xs text-muted-foreground">Inbound · Sales line</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-live" /> Live
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {mm}:{ss}
          </span>
        </div>
      </div>

      {/* Transcript */}
      <div className="px-5 py-4 space-y-2.5 min-h-[244px]">
        {SCRIPT.slice(0, shown).map((line, i) => (
          <div
            key={i}
            className={`flex ${line.who === "agent" ? "justify-end" : "justify-start"} animate-fade-up`}
          >
            <div className="max-w-[82%]">
              <div
                className={`text-[10px] uppercase tracking-wider mb-1 ${line.who === "agent" ? "text-right text-primary-glow" : "text-muted-foreground"}`}
              >
                {line.who === "agent" ? "AnswerLabs" : "Caller"}
              </div>
              <div
                className={`rounded-2xl px-3.5 py-2 text-sm ${
                  line.who === "agent"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-secondary text-foreground rounded-bl-sm"
                }`}
              >
                {line.text}
              </div>
            </div>
          </div>
        ))}
        {!done && lastWho === "customer" && (
          <div className="flex justify-end animate-fade-in">
            <div className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground">
              <Equalizer /> AnswerLabs is responding
            </div>
          </div>
        )}
      </div>

      {/* Outcome */}
      <div className="px-5 py-3.5 border-t border-border bg-muted/40 flex flex-wrap items-center gap-2">
        {done ? (
          <>
            <Outcome icon={UserCheck} label="Lead qualified" />
            <Outcome icon={CalendarCheck} label="Site visit booked" />
            <Outcome icon={Languages} label="English" />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            Listening · extracting intent, budget, and contact…
          </span>
        )}
      </div>
    </div>
  );
}

function Outcome({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium animate-fade-up">
      <Icon className="w-3.5 h-3.5 text-success" /> {label}
    </span>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────
export function Hero() {
  return (
    <section className="relative bg-gradient-hero">
      <div className="mx-auto max-w-7xl px-6 pt-20 pb-20 md:pt-28 md:pb-28 grid lg:grid-cols-2 gap-14 items-center">
        <div className="animate-fade-up">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Answering live in 30+ languages
          </div>
          <h1 className="mt-5 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Your best employee
            <br />
            answers every call.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground max-w-xl">
            AnswerLabs picks up every call, qualifies the lead, books the meeting, and hands off to your
            team when it counts — day and night, in any language. Never miss a lead again.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-5 py-2.5 text-sm shadow-glow hover:opacity-95 transition"
            >
              Start free <ArrowRight className="w-4 h-4" />
            </Link>
            <a
              href="#how"
              className="inline-flex items-center gap-2 border border-border bg-card rounded-lg px-5 py-2.5 text-sm hover:bg-secondary transition"
            >
              See how it works
            </a>
          </div>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <Stat label="Answers in under a second" />
            <Stat label="Conversations that convert" />
            <Stat label="No call ever goes to voicemail" />
          </div>
        </div>

        <div className="animate-fade-up [animation-delay:120ms]">
          <CallSimulation />
        </div>
      </div>
    </section>
  );
}

function Stat({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Check className="w-4 h-4 text-foreground/40" /> {label}
    </span>
  );
}

// ─── How it works — a quiet, connected timeline (no floating cards) ──────────
export function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "The call comes in",
      desc: "Forwarded from your business line — answered before the second ring.",
    },
    {
      n: "02",
      title: "AnswerLabs handles it",
      desc: "Understands the caller, answers from your knowledge base, and stays on-brand in their language.",
    },
    {
      n: "03",
      title: "The outcome is captured",
      desc: "Intent, budget, sentiment, and contact details are extracted into a clean lead.",
    },
    {
      n: "04",
      title: "Your team takes over",
      desc: "Qualified conversations are handed to a human the moment they matter.",
    },
  ];
  return (
    <section id="how" className="py-24 border-t border-border bg-background">
      <div className="mx-auto max-w-7xl px-6">
        <p className="text-sm font-medium text-muted-foreground">How it works</p>
        <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight max-w-2xl">
          From dial tone to qualified lead, in under a minute.
        </h2>
        <div className="mt-14 grid md:grid-cols-4 gap-x-8 gap-y-10">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 110}>
              <div className="group relative rounded-xl p-4 -m-4 hover-glow border border-transparent">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium tabular-nums text-muted-foreground">
                    {s.n}
                  </span>
                  <span className="h-px flex-1 bg-border group-hover:bg-[var(--color-ring)] transition-colors" />
                </div>
                <h3 className="mt-4 font-medium">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
