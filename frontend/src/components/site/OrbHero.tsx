import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { MessagesSquare, Users, IndianRupee, CalendarCheck, Sparkles, ArrowRight } from "lucide-react";
import { orbPulse } from "./orbBus";
import { Reveal, CountUp } from "@/components/Motion";

// Pure foreground over the global voice bloom — it drives the same bloom everyone
// sees. Built for the soft-light palette.
const DIALOGUE: { who: "caller" | "agent"; text: string }[] = [
  { who: "caller", text: "Hi, do you have 3BHK apartments in Kokapet?" },
  { who: "agent", text: "We do. May I ask your budget range, sir?" },
  { who: "caller", text: "Around 2.4 crore." },
  { who: "agent", text: "My Home Apas starts at 2.4 crore. Shall I book a site visit?" },
  { who: "caller", text: "Yes, Saturday morning works." },
  { who: "agent", text: "Booked for Saturday, 11 AM. Confirmation on WhatsApp." },
];

export function OrbHero() {
  const [talking, setTalking] = useState(false);
  const [line, setLine] = useState<{ who: string; text: string } | null>(null);

  function talkToPriya() {
    if (talking) return;
    setTalking(true);
    let i = 0;
    const step = () => {
      if (i >= DIALOGUE.length) {
        setTimeout(() => { setTalking(false); setLine(null); }, 1600);
        return;
      }
      setLine(DIALOGUE[i]);
      orbPulse();
      i++;
      setTimeout(step, 1850);
    };
    step();
  }

  return (
    <>
      <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 pt-24 pb-16 overflow-hidden">
        {/* ambient floating dialogue */}
        <Chip className="left-[8%] top-[24%]" who="caller">do you have 3BHK in Kokapet?</Chip>
        <Chip className="right-[9%] top-[32%] [animation-delay:-2s]" who="agent">What's your budget, sir?</Chip>
        <Chip className="left-[13%] bottom-[22%] [animation-delay:-4s]" who="caller">around 2.4 crore</Chip>

        <div className="relative z-10 flex flex-col items-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 backdrop-blur px-3 py-1 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-live" />
            The living voice platform
          </div>
          <h1 className="mt-6 text-4xl md:text-7xl font-semibold tracking-tight text-foreground leading-[1.03]">
            Say hello to your<br />
            <span className="text-iridescent">business's voice.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base md:text-lg text-muted-foreground">
            Priya answers every call, qualifies every lead, and books the meeting —
            in 30+ languages, around the clock.
          </p>

          <div className="mt-8 h-12 flex items-center">
            {talking && line ? (
              <div className="glass-card rounded-full px-4 py-2 text-sm text-foreground animate-fade-up max-w-[90vw]">
                <span className={line.who === "agent" ? "text-primary font-medium" : "text-muted-foreground"}>
                  {line.who === "agent" ? "Priya" : "Caller"}
                </span>
                <span className="mx-2 text-muted-foreground/50">·</span>
                {line.text}
              </div>
            ) : (
              <button
                onClick={talkToPriya}
                className="group inline-flex items-center gap-2.5 rounded-full px-6 py-3 text-sm font-medium text-foreground ring-iridescent shadow-glow hover:-translate-y-0.5 transition-all"
              >
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-50 animate-pulse-ring" />
                  <span className="relative inline-flex rounded-full w-2 h-2 bg-primary" />
                </span>
                Talk to Priya
              </button>
            )}
          </div>

          <div className="mt-10 text-xs text-muted-foreground animate-float-soft">scroll — watch her become your pipeline ↓</div>
        </div>
      </section>

      {/* the pipeline the conversation becomes */}
      <section className="relative py-24 px-6">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <p className="text-center text-sm text-muted-foreground mb-8">One conversation becomes everything that matters.</p>
          </Reveal>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Reveal delay={0}><OutcomeCard icon={MessagesSquare} label="Conversations" value={12480} /></Reveal>
            <Reveal delay={90}><OutcomeCard icon={Users} label="Leads generated" value={3219} /></Reveal>
            <Reveal delay={180}><OutcomeCard icon={IndianRupee} label="Revenue influenced" value={4.7} decimals={1} prefix="₹" suffix=" Cr" /></Reveal>
            <Reveal delay={270}><OutcomeCard icon={CalendarCheck} label="Appointments" value={1042} /></Reveal>
          </div>
          <Reveal delay={120}>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Link to="/signup" className="inline-flex items-center gap-2 rounded-full bg-gradient-primary text-primary-foreground font-medium px-5 py-2.5 text-sm shadow-glow hover:-translate-y-0.5 transition-all">
                Start free <ArrowRight className="w-4 h-4" />
              </Link>
              <a href="#how" className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm text-foreground hover:bg-secondary transition">
                <Sparkles className="w-4 h-4 text-primary" /> See the analytics
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

function Chip({ who, children, className = "" }: { who: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`pointer-events-none absolute z-10 hidden md:block animate-float-soft ${className}`}>
      <div className="glass-card rounded-2xl px-3.5 py-2 text-xs text-muted-foreground max-w-[220px]">
        <span className={`mr-1.5 ${who === "agent" ? "text-primary font-medium" : "text-muted-foreground/70"}`}>{who === "agent" ? "Priya" : "Caller"}</span>
        {children}
      </div>
    </div>
  );
}

function OutcomeCard({
  icon: Icon, label, value, decimals = 0, prefix = "", suffix = "",
}: {
  icon: any; label: string; value: number; decimals?: number; prefix?: string; suffix?: string;
}) {
  return (
    <div className="glass-card rounded-2xl p-5 text-left hover-lift sheen h-full">
      <Icon className="w-5 h-5 text-primary" />
      <div className="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-foreground">
        <CountUp value={value} decimals={decimals} prefix={prefix} suffix={suffix} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
