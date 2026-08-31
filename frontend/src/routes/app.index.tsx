// /app — the client portal's front door.
//
// Two states, one route:
//
//   • Not live yet  → the setup stage. A new client's first impression of the
//     product, so it is built like one: an ambient canvas, the agent rendered as
//     a living object that is visibly *waiting*, and the three remaining steps as
//     a rail you can see yourself moving along. Each step deep-links to the exact
//     screen that completes it and shows what it already knows ("4 documents
//     added"), so the page reports real state rather than reciting a brochure.
//
//   • Live          → the working home: is the agent up, what has it been doing,
//     what happened most recently. Trends and breakdowns live on /app/analytics.
//
// Setup used to be a hard redirect into /onboarding, which dropped people into a
// wizard with no sense of where they were or how much was left.

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PhoneCall,
  ArrowRight,
  Check,
  Sparkles,
  BookOpen,
  Radio,
  UsersRound,
  ListChecks,
  AlertTriangle,
  HelpCircle,
  Bot,
  Brain,
  Flame,
  Clock,
  Zap,
  Activity,
  UserPlus,
  Megaphone,
  BarChart3,
} from "lucide-react";
import {
  useAgent,
  useClientKnowledge,
  useClientHome,
  type ClientHome,
  type AttentionItem,
  type AttentionKind,
} from "@/lib/data";
import { useMe } from "@/lib/team";
import { Reveal, CountUp } from "@/components/Motion";

export const Route = createFileRoute("/app/")({
  head: () => ({ meta: [{ title: "Home — Vocera" }] }),
  component: Home,
});

function Home() {
  const { data: agent, isLoading } = useAgent();
  const { data: me } = useMe();
  const { data: knowledge = [] } = useClientKnowledge();

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  const isLive = !!agent?.phone_number && agent?.config?.status === "published";
  if (isLive) return <CommandCentre />;

  return (
    <Setup
      name={firstName(me?.full_name)}
      business={me?.tenant.business_name || agent?.config?.business_name}
      number={agent?.phone_number}
      steps={[
        {
          title: "Set up your agent",
          body: "Pick your industry — we'll write the script and pick a voice.",
          detail: agent?.config?.business_name
            ? `Configured for ${agent.config.business_name}`
            : "Not started",
          done: !!(agent?.config?.system_prompt || agent?.config?.business_name),
          to: "/onboarding",
          cta: "Choose an industry",
          icon: Sparkles,
        },
        {
          title: "Add your business info",
          body: "Whatever it should know — FAQs, pricing, hours, brochures.",
          detail: knowledge.length
            ? `${knowledge.length} ${knowledge.length === 1 ? "entry" : "entries"} added`
            : "Nothing added yet",
          done: knowledge.length > 0,
          to: "/app/knowledge",
          cta: "Add your info",
          icon: BookOpen,
        },
        {
          title: "Go live",
          body: "Publish, and the number answers itself from the next call on.",
          detail: agent?.phone_number
            ? `${agent.phone_number} · not published yet`
            : "No number connected",
          done: false,
          to: "/onboarding",
          cta: "Publish",
          icon: Radio,
        },
      ]}
    />
  );
}

// ─── Setup stage ─────────────────────────────────────────────────────────────

type Step = {
  title: string;
  body: string;
  detail: string;
  done: boolean;
  to: string;
  cta: string;
  icon: any;
};

function Setup({
  name,
  business,
  number,
  steps,
}: {
  name: string;
  business?: string | null;
  number?: string | null;
  steps: Step[];
}) {
  const doneCount = steps.filter((s) => s.done).length;
  // The first unfinished step is the only one that gets the spotlight — a screen
  // where everything shouts is a screen with no next action.
  const currentIndex = steps.findIndex((s) => !s.done);

  return (
    <div className="relative min-h-full overflow-hidden">
      <Aurora />

      <div className="relative p-6 md:p-10 max-w-5xl mx-auto">
        {/* ── Hero ── */}
        <Reveal>
          <div className="flex flex-wrap items-center justify-between gap-10">
            <div className="min-w-0 flex-1">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs backdrop-blur">
                <span className="w-1.5 h-1.5 rounded-full bg-warning animate-live" />
                <span className="text-muted-foreground">
                  Setting up{business ? ` · ${business}` : ""}
                </span>
              </div>

              <h1 className="mt-5 text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
                Welcome to Vocera,
                <br />
                <span className="text-iridescent">{name}.</span>
              </h1>

              <p className="mt-4 max-w-md text-muted-foreground">
                {doneCount === 0
                  ? "Three steps and your number starts answering itself. About five minutes."
                  : `${steps.length - doneCount} ${steps.length - doneCount === 1 ? "step" : "steps"} to go before your number starts answering itself.`}
              </p>
            </div>

            <AgentOrb number={number} />
          </div>
        </Reveal>

        {/* ── Progress ── */}
        <Reveal delay={80}>
          <div className="mt-10 flex items-center gap-4">
            <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
              <span
                className="block h-full rounded-full bg-gradient-primary transition-all duration-700"
                style={{ width: `${(doneCount / steps.length) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {doneCount} of {steps.length} done
            </span>
          </div>
        </Reveal>

        {/* ── Steps ── */}
        <ol className="mt-6 space-y-3">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={120 + i * 70}>
              <StepCard step={s} index={i} current={i === currentIndex} />
            </Reveal>
          ))}
        </ol>

        {/* ── Escape hatch ── */}
        <Reveal delay={340}>
          <div className="mt-10 border-t border-border pt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Or look around first
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <QuickLink
                to="/app/calls"
                icon={PhoneCall}
                title="Call log"
                body="Every call, transcript and recording."
              />
              <QuickLink
                to="/app/leads"
                icon={ListChecks}
                title="Leads"
                body="What your agent captures, ready to work."
              />
              <QuickLink
                to="/app/team"
                icon={UsersRound}
                title="Team"
                body="Invite the people who'll handle the leads."
              />
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

/** Ambient backdrop. Two slow-drifting colour fields — depth, not decoration:
 *  without it the setup card is a white box floating on a white page. */
function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 -right-24 w-[34rem] h-[34rem] rounded-full bg-gradient-primary opacity-[0.13] blur-3xl animate-aurora" />
      <div
        className="absolute -bottom-52 -left-32 w-[30rem] h-[30rem] rounded-full bg-gradient-primary opacity-[0.09] blur-3xl animate-aurora"
        style={{ animationDelay: "-9s" }}
      />
    </div>
  );
}

/** The agent as an object you can look at: a breathing ring around an equaliser.
 *  Amber and slow while it's dormant — the same shape goes green and quick once
 *  it's live, so the state change is felt rather than read. */
function AgentOrb({ number }: { number?: string | null }) {
  return (
    <div className="shrink-0 text-center">
      <div className="relative w-40 h-40 grid place-items-center mx-auto">
        <span className="absolute inset-2 rounded-full bg-gradient-primary opacity-20 blur-2xl animate-float-soft" />
        <span className="absolute inset-5 rounded-full border border-primary/25" />
        <span className="absolute inset-5 rounded-full border border-primary/30 animate-pulse-ring" />
        <span className="absolute inset-10 rounded-full glass-card" />

        <div className="relative flex items-end gap-[3px] h-9">
          {[0.5, 0.75, 1, 0.7, 0.45].map((h, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-gradient-primary origin-bottom animate-eq opacity-45"
              style={{
                height: `${h * 100}%`,
                animationDelay: `${i * 0.13}s`,
                animationDuration: "2.2s",
              }}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 text-sm font-medium">Agent asleep</div>
      <div className="text-xs text-muted-foreground tabular-nums">{number || "No number yet"}</div>
    </div>
  );
}

function StepCard({ step, index, current }: { step: Step; index: number; current: boolean }) {
  const Icon = step.icon;

  // Done: settled and quiet. Current: lifted, tinted, the only card with a button.
  // Upcoming: present but recessed, so the eye lands on one thing.
  const shell = step.done
    ? "border-border bg-card/50"
    : current
      ? "border-primary/40 bg-card shadow-glow"
      : "border-border bg-card/40";

  return (
    <li
      className={`group relative flex items-start gap-4 rounded-xl border p-5 backdrop-blur transition ${shell} ${
        current ? "" : "hover:border-primary/30"
      }`}
    >
      <span
        className={`mt-0.5 w-9 h-9 rounded-xl grid place-items-center shrink-0 text-sm font-semibold ${
          step.done
            ? "bg-success/15 text-success"
            : current
              ? "bg-gradient-primary text-primary-foreground shadow-glow"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {step.done ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className={`font-medium ${step.done ? "text-muted-foreground" : ""}`}>
            {step.title}
          </h3>
          {step.done ? (
            <span className="rounded-full bg-success/15 text-success px-2 py-0.5 text-[11px] font-medium">
              Done
            </span>
          ) : current ? (
            <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium">
              Next
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">Step {index + 1}</span>
          )}
        </div>

        <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
        <p className="mt-1.5 text-xs text-muted-foreground/80">{step.detail}</p>
      </div>

      {/* Only the next step carries an action; the rest are status, not choices. */}
      {current ? (
        <Link
          to={step.to}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition"
        >
          {step.cta} <ArrowRight className="w-4 h-4" />
        </Link>
      ) : !step.done ? (
        <Link
          to={step.to}
          className="shrink-0 text-sm text-muted-foreground hover:text-foreground transition opacity-0 group-hover:opacity-100"
        >
          Skip ahead
        </Link>
      ) : null}
    </li>
  );
}

function QuickLink({
  to,
  icon: Icon,
  title,
  body,
}: {
  to: string;
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="rounded-xl border border-border bg-card/50 p-4 backdrop-blur hover-lift sheen block"
    >
      <Icon className="w-4 h-4 text-muted-foreground" />
      <div className="mt-2.5 text-sm font-medium">{title}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
    </Link>
  );
}

function firstName(full?: string | null) {
  const n = (full || "").trim().split(/\s+/)[0];
  // "Welcome to Vocera, there." still reads as a greeting with no name on file.
  return n || "there";
}

// ─── Command centre (agent is live) ──────────────────────────────────────────
// Not an analytics page. Analytics answers "how are we performing over time";
// this answers "what is my AI doing, what happened, and what needs me". Colour is
// reserved for status, intent and actions — everything else is calm.
//
// Layout: one grid, ordered twice. Desktop reads as a wide main column with a
// rail; mobile stacks in priority order (agent status → today → attention →
// briefing → conversations), which is why every card carries both `order-*` and
// `lg:order-*` rather than living in two separate columns.

function CommandCentre() {
  const { data: h, isLoading, isError } = useClientHome();
  const { data: me } = useMe();

  if (isLoading) return <HomeSkeleton />;
  if (isError || !h) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Your dashboard couldn't be loaded right now.
      </div>
    );
  }

  return (
    <div className="relative min-h-full overflow-hidden">
      <Aurora />

      <div className="relative p-5 sm:p-6 lg:p-8 max-w-7xl mx-auto">
        <Greeting name={firstName(me?.full_name)} agent={h.agent} />

        {/* Two columns that pack independently.
            A plain 3-col grid forces cards into rows, so every height mismatch
            between a main card and its rail neighbour became dead space on the
            right. The wrappers are `display: contents` on mobile — their children
            become direct grid items and obey `order-*` for the stacking priority
            — and become real flex columns at lg, where each card sizes to its own
            content and the rail packs tight. */}
        <div className="mt-7 grid gap-4 lg:gap-5 lg:grid-cols-3 lg:items-start">
          <div className="contents lg:flex lg:flex-col gap-4 lg:gap-5 lg:col-span-2">
            <AiToday
              today={h.today}
              live={h.agent.live}
              campaigns={h.campaigns}
              className="order-2 lg:order-none"
            />
            <Attention
              items={h.attention}
              total={h.attention_total}
              className="order-3 lg:order-none"
            />
            <Timeline events={h.timeline} className="order-6 lg:order-none" />
          </div>

          <div className="contents lg:flex lg:flex-col gap-4 lg:gap-5">
            <AgentStatus agent={h.agent} className="order-1 lg:order-none" />
            <Briefing briefing={h.briefing} className="order-4 lg:order-none" />
            <Signals signals={h.signals} className="order-5 lg:order-none" />
            <QuickActions className="order-7 lg:order-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 1. Greeting ─────────────────────────────────────────────────────────────

function Greeting({ name, agent }: { name: string; agent: ClientHome["agent"] }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          {timeOfDay()}, {name} <span aria-hidden>👋</span>
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Here's what your AI agent is taking care of today.
        </p>
        <p className="mt-2.5 text-sm">
          <StatusDot state={agent.state} /> {statusLine(agent)}
        </p>
      </div>

      <Link
        to="/app/analytics"
        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-sm hover:bg-secondary transition"
      >
        View analytics <ArrowRight className="w-4 h-4" />
      </Link>
    </header>
  );
}

/** A quiet day is not a fault. Only a real operational problem says so. */
function statusLine(agent: ClientHome["agent"]) {
  if (agent.state === "draft") return "Your agent isn't published yet.";
  if (agent.state === "attention") return "Your agent may need attention.";
  return "Your agent is ready to receive calls.";
}

function StatusDot({ state }: { state: ClientHome["agent"]["state"] }) {
  const map = {
    ready: { cls: "bg-success", label: "Agent live" },
    attention: { cls: "bg-warning", label: "Needs attention" },
    draft: { cls: "bg-muted-foreground", label: "Draft" },
  } as const;
  const s = map[state];
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span
        className={`w-2 h-2 rounded-full ${s.cls} ${state === "ready" ? "animate-live" : ""}`}
      />
      <span className="font-medium">{s.label}</span>
      <span className="text-muted-foreground">·</span>
    </span>
  );
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// ─── 2. Your AI today ────────────────────────────────────────────────────────

function AiToday({
  today,
  live,
  campaigns,
  className = "",
}: {
  today: ClientHome["today"];
  live: boolean;
  campaigns: ClientHome["campaigns"];
  className?: string;
}) {
  const quiet = today.conversations === 0;

  return (
    <Card
      className={className}
      icon={Bot}
      title="Your AI today"
      action={
        !quiet && (
          <Link
            to="/app/calls"
            className="text-xs text-muted-foreground hover:text-foreground transition"
          >
            View today's activity →
          </Link>
        )
      }
    >
      {quiet ? (
        <div className="py-5">
          <p className="text-sm font-medium">No conversations yet today.</p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {live
              ? "Your agent is live and ready to handle customers."
              : "Publish your agent and it will start answering."}
          </p>
          {today.last_call_at && (
            <p className="mt-3 text-xs text-muted-foreground">
              Last conversation {relTime(today.last_call_at)}.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
          <div>
            <div className="text-4xl font-semibold tracking-tight tabular-nums leading-none">
              <CountUp value={today.conversations} />
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              {today.conversations === 1 ? "Conversation handled" : "Conversations handled"}
            </div>
          </div>

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 flex-1 min-w-0">
            <Stat n={today.high_intent} label="High-intent" tone="high" />
            <Stat n={today.follow_ups} label="Follow-ups" tone="warn" />
            <Stat n={today.handoffs} label="Human handoffs" />
            <Stat n={today.leads} label="Leads captured" />
          </dl>
        </div>
      )}

      {/* Outbound work in flight. Sits here rather than in its own card because
          it answers the same question as the number above it: what is my AI
          doing right now. */}
      {campaigns.length > 0 && (
        <div className="mt-5 pt-4 border-t border-border flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-live shrink-0" />
          <span className="text-muted-foreground">Dialing now:</span>
          {campaigns.map((c, i) => (
            <span key={c.id} className="min-w-0">
              <Link to="/app/campaigns" className="font-medium hover:underline">
                {c.name}
              </Link>
              {i < campaigns.length - 1 && <span className="text-muted-foreground">,</span>}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "high" | "warn" }) {
  // Zero is a fact, not a failure — it recedes rather than shouting in colour.
  const colour =
    n === 0
      ? "text-muted-foreground/50"
      : tone === "high"
        ? "text-success"
        : tone === "warn"
          ? "text-warning"
          : "";
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${colour}`}>{n}</dd>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

// ─── 3. Needs your attention ─────────────────────────────────────────────────

const ATTENTION_STYLE: Record<
  AttentionKind,
  { icon: any; label: string; ring: string; fg: string }
> = {
  issue: {
    icon: AlertTriangle,
    label: "Agent issue",
    ring: "border-destructive/35 bg-destructive/[0.04]",
    fg: "text-destructive",
  },
  handoff: {
    icon: PhoneCall,
    label: "Human follow-up",
    ring: "border-warning/35 bg-warning/[0.04]",
    fg: "text-warning",
  },
  high_intent: {
    icon: Flame,
    label: "High-intent lead",
    ring: "border-success/35 bg-success/[0.04]",
    fg: "text-success",
  },
  follow_up: {
    icon: Clock,
    label: "Follow-up due",
    ring: "border-border",
    fg: "text-muted-foreground",
  },
  stale: { icon: Clock, label: "Going cold", ring: "border-border", fg: "text-muted-foreground" },
  knowledge: {
    icon: HelpCircle,
    label: "Knowledge gap",
    ring: "border-border",
    fg: "text-muted-foreground",
  },
};

function Attention({
  items,
  total,
  className = "",
}: {
  items: AttentionItem[];
  total: number;
  className?: string;
}) {
  return (
    <Card
      className={className}
      icon={Zap}
      title="Needs your attention"
      badge={
        total > items.length ? `${items.length} of ${total}` : total ? String(total) : undefined
      }
    >
      {items.length === 0 ? (
        <div className="py-8 text-center">
          <div className="text-2xl" aria-hidden>
            🎉
          </div>
          <p className="mt-2 text-sm font-medium">You're all caught up</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Nothing needs your attention right now.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((it) => {
            const s = ATTENTION_STYLE[it.kind];
            const Icon = s.icon;
            return (
              <li
                key={it.id}
                className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border p-4 ${s.ring}`}
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.fg}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[11px] font-medium uppercase tracking-wide ${s.fg}`}>
                        {s.label}
                      </span>
                      {it.badge && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {it.badge}
                        </span>
                      )}
                      {it.at && (
                        <span className="text-[11px] text-muted-foreground">{relTime(it.at)}</span>
                      )}
                    </div>
                    <div className="mt-0.5 font-medium truncate">{it.title}</div>
                    <p className="text-sm text-muted-foreground">{it.subtitle}</p>
                    {it.detail && (
                      <p className="mt-1.5 text-sm text-muted-foreground/90 italic line-clamp-2">
                        “{it.detail}”
                      </p>
                    )}
                  </div>
                </div>

                <Link
                  to={it.to}
                  className="shrink-0 self-start sm:self-center inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary transition"
                >
                  {it.cta} <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ─── 4. AI briefing ──────────────────────────────────────────────────────────

function Briefing({
  briefing,
  className = "",
}: {
  briefing: ClientHome["briefing"];
  className?: string;
}) {
  const empty = briefing.bullets.length === 0;

  return (
    <Card className={className} icon={Sparkles} title="AI briefing">
      <p className="-mt-1 text-xs text-muted-foreground">
        {empty
          ? "Your briefing appears once your agent has handled conversations."
          : `Here's what happened ${briefing.window}.`}
      </p>

      {!empty && (
        <ul className="mt-4 space-y-2.5">
          {briefing.bullets.map((b) => (
            <li key={b} className="flex gap-2.5 text-sm">
              <span className="mt-1.5 w-1 h-1 rounded-full bg-primary shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}

      {briefing.recommendation && (
        <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recommended action
          </div>
          <p className="mt-1 text-sm font-medium">{briefing.recommendation.text}</p>
          <Link
            to={briefing.recommendation.to}
            className="mt-2.5 inline-flex items-center gap-1.5 text-sm text-primary hover:gap-2.5 transition-all"
          >
            {briefing.recommendation.cta} <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}
    </Card>
  );
}

// ─── 6. Customer signals ─────────────────────────────────────────────────────

function Signals({
  signals,
  className = "",
}: {
  signals: ClientHome["signals"];
  className?: string;
}) {
  const max = Math.max(1, ...signals.topics.map((t) => t.count));

  return (
    <Card className={className} icon={Brain} title="Customer signals">
      {signals.topics.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Customer topics will appear here once your agent starts handling conversations.
        </p>
      ) : (
        <>
          <p className="-mt-1 text-xs text-muted-foreground">
            What callers asked about {signals.window}.
          </p>
          <ul className="mt-4 space-y-2.5">
            {signals.topics.map((t) => (
              <li key={t.key} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 truncate">{t.label}</span>
                <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-primary/70"
                    style={{ width: `${(t.count / max) * 100}%` }}
                  />
                </span>
                <span className="w-6 text-right tabular-nums text-muted-foreground">{t.count}</span>
              </li>
            ))}
          </ul>
          {signals.insight && (
            <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
              {signals.insight}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── 7. Agent status ─────────────────────────────────────────────────────────

function AgentStatus({
  agent,
  className = "",
}: {
  agent: ClientHome["agent"];
  className?: string;
}) {
  return (
    <Card className={className} icon={Bot} title="Agent status">
      <div className="font-medium truncate">{agent.name}</div>
      <div className="mt-1 flex items-center gap-2 text-sm">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            agent.live ? "bg-success animate-live" : "bg-muted-foreground"
          }`}
        />
        <span className={agent.live ? "text-success" : "text-muted-foreground"}>
          {agent.live ? "Live & receiving calls" : "Not published"}
        </span>
      </div>

      <dl className="mt-5 space-y-3.5 text-sm">
        <Field label="Answering" value={agent.number} />
        <Field label="Human handoff" value={agent.handoff_number} empty="Off" />
        <Field
          label="Knowledge base"
          status={agent.knowledge.count === 0 ? "bad" : agent.knowledge.fresh ? "good" : "warn"}
          value={
            agent.knowledge.count === 0
              ? "Nothing added"
              : agent.knowledge.fresh
                ? "Up to date"
                : `${agent.knowledge.count} entries · ageing`
          }
        />
        <Field
          label="Last call"
          value={agent.last_call_at ? relTime(agent.last_call_at) : null}
          empty="None yet"
        />
      </dl>

      <Link
        to="/onboarding"
        className="mt-5 inline-flex items-center gap-1.5 text-sm text-foreground hover:gap-2.5 transition-all"
      >
        Manage agent <ArrowRight className="w-4 h-4" />
      </Link>
    </Card>
  );
}

function Field({
  label,
  value,
  empty = "Not set",
  status,
}: {
  label: string;
  value: string | null;
  empty?: string;
  status?: "good" | "warn" | "bad";
}) {
  const dot =
    status === "good"
      ? "bg-success"
      : status === "warn"
        ? "bg-warning"
        : status === "bad"
          ? "bg-destructive"
          : null;

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-right min-w-0">
        {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />}
        <span className={`truncate ${value ? "" : "text-muted-foreground font-normal"}`}>
          {value || empty}
        </span>
      </dd>
    </div>
  );
}

// ─── 8. Today's timeline ─────────────────────────────────────────────────────

const TIMELINE_ICON = {
  call: { icon: Bot, fg: "text-muted-foreground" },
  lead: { icon: UserPlus, fg: "text-primary" },
  high_intent: { icon: Flame, fg: "text-success" },
  handoff: { icon: PhoneCall, fg: "text-warning" },
} as const;

function Timeline({
  events,
  className = "",
}: {
  events: ClientHome["timeline"];
  className?: string;
}) {
  return (
    <Card className={className} icon={Activity} title="Today">
      {events.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Today's activity will appear here as your agent handles calls.
        </p>
      ) : (
        <ol className="space-y-1">
          {events.map((e, i) => {
            const s = TIMELINE_ICON[e.kind] || TIMELINE_ICON.call;
            const Icon = s.icon;
            return (
              <li key={`${e.at}-${i}`}>
                <Link
                  to={e.to}
                  className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/60 transition"
                >
                  <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums pt-0.5">
                    {clockTime(e.at)}
                  </span>
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.fg}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{e.title}</span>
                    <span className="block text-sm text-muted-foreground truncate">{e.detail}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// ─── 9. Quick actions ────────────────────────────────────────────────────────
// Only routes that already exist. Nothing here opens a page we'd have to build.

function QuickActions({ className = "" }: { className?: string }) {
  const actions = [
    { to: "/app/leads", icon: ListChecks, label: "View leads" },
    { to: "/app/knowledge", icon: BookOpen, label: "Update knowledge" },
    { to: "/onboarding", icon: Bot, label: "Manage agent" },
    { to: "/app/campaigns/new", icon: Megaphone, label: "New campaign" },
    { to: "/app/analytics", icon: BarChart3, label: "Analytics" },
  ];

  return (
    <Card className={className} icon={Zap} title="Quick actions">
      {/* One column, not two: five items in a 2-up grid leaves a dangling empty
          cell, and the full-height list fills the rail beside the timeline. */}
      <div className="-mx-1 divide-y divide-border">
        {actions.map((a) => (
          <Link
            key={a.to + a.label}
            to={a.to}
            className="group flex items-center gap-2.5 rounded-lg px-2 py-3 text-sm hover:bg-muted transition"
          >
            <a.icon className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="truncate flex-1">{a.label}</span>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
          </Link>
        ))}
      </div>
    </Card>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function Card({
  title,
  icon: Icon,
  badge,
  action,
  className = "",
  children,
}: {
  title: string;
  icon?: any;
  badge?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-border bg-card p-5 sm:p-6 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
          <h2 className="text-sm font-medium truncate">{title}</h2>
          {badge && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
              {badge}
            </span>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Matches the real layout so the page doesn't jump when data lands. */
function HomeSkeleton() {
  return (
    <div className="p-5 sm:p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
      <div className="h-8 w-64 rounded-lg bg-muted" />
      <div className="mt-3 h-4 w-80 rounded bg-muted/60" />
      <div className="mt-7 grid gap-4 lg:gap-5 lg:grid-cols-3 lg:items-start">
        <div className="contents lg:flex lg:flex-col gap-4 lg:gap-5 lg:col-span-2">
          <div className="h-36 rounded-xl bg-muted/50 order-2 lg:order-none" />
          <div className="h-72 rounded-xl bg-muted/50 order-3 lg:order-none" />
        </div>
        <div className="contents lg:flex lg:flex-col gap-4 lg:gap-5">
          <div className="h-56 rounded-xl bg-muted/50 order-1 lg:order-none" />
          <div className="h-48 rounded-xl bg-muted/50 order-4 lg:order-none" />
        </div>
      </div>
      <span className="sr-only">Loading your dashboard…</span>
    </div>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
