import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PhoneCall,
  Users,
  ArrowRightLeft,
  Languages,
  CircleDollarSign,
  CalendarCheck,
  ArrowUpRight,
  ArrowRight,
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, Tooltip, Cell } from "recharts";
import { useClientOverview, useClientCalls, useClientLeads, useAgent } from "@/lib/data";
import { Reveal, CountUp } from "@/components/Motion";

export const Route = createFileRoute("/app/")({
  component: Overview,
});

const LANG: Record<string, string> = {
  en: "English", hi: "Hindi", te: "Telugu", ta: "Tamil",
  kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali",
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Overview() {
  const { data: o } = useClientOverview();
  const { data: callsData } = useClientCalls(1, 8);
  const { data: leads = [] } = useClientLeads();
  const { data: agent } = useAgent();

  if (!o) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  const days = o.callsPerDay ?? [];
  const callsToday = days.length ? days[days.length - 1].calls : 0;
  const callsPrev = days.length > 1 ? days[days.length - 2].calls : 0;
  const todayDelta = callsToday - callsPrev;

  const langCodes = Array.from(new Set(leads.map((l) => l.language).filter(Boolean)));
  const langNames = langCodes.map((c) => LANG[c] || c);

  const isLive = !!agent?.phone_number;
  const businessName = agent?.config?.business_name || agent?.name || "your business";

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
            <StatusPill live={isLive} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {businessName} · last 7 days
          </p>
        </div>
        <Link
          to="/app/leads"
          className="inline-flex items-center gap-1.5 text-sm rounded-lg border border-border bg-card px-3.5 py-2 hover:bg-secondary transition"
        >
          View leads <ArrowRight className="w-4 h-4" />
        </Link>
      </header>

      {/* Outcome metrics */}
      <section className="mt-7 grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Metric icon={PhoneCall} label="Calls handled today" count={callsToday} delta={todayDelta} delay={0} />
        <Metric icon={Users} label="Leads qualified" count={o.total_leads} sub="last 7 days" delay={60} />
        <Metric icon={ArrowRightLeft} label="Human handoffs" count={o.handoff_count} sub="routed to your team" delay={120} />
        <Metric icon={Languages} label="Languages handled" count={Math.max(langNames.length, 1)} sub={langNames.slice(0, 3).join(" · ") || "English"} delay={180} />
        <Metric icon={CircleDollarSign} label="Revenue influenced" value="—" muted sub="Add deal values to track" delay={240} />
        <Metric icon={CalendarCheck} label="Appointments booked" value="—" muted sub="Connect a calendar" delay={300} />
      </section>

      {/* Volume + agent status */}
      <section className="mt-3 grid lg:grid-cols-3 gap-3">
        <Reveal delay={60} className="lg:col-span-2">
        <div className="rounded-xl border border-border bg-card p-5 hover-glow h-full">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Call volume</h2>
            <span className="text-xs text-muted-foreground">{o.total_calls} total · {o.total_minutes} min</span>
          </div>
          <div className="mt-5 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days} barCategoryGap={14}>
                <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "var(--color-muted)" }}
                  contentStyle={{
                    background: "var(--color-popover)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 10,
                    fontSize: 12,
                    boxShadow: "var(--shadow-card)",
                  }}
                  labelStyle={{ color: "var(--color-muted-foreground)" }}
                />
                <Bar dataKey="calls" radius={[5, 5, 0, 0]}>
                  {days.map((_, i) => (
                    <Cell key={i} fill={i === days.length - 1 ? "var(--color-primary)" : "var(--color-border)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        </Reveal>

        <Reveal delay={120}>
          <AgentStatus
            live={isLive}
            number={agent?.phone_number}
            languages={langNames.length ? langNames : ["English"]}
            handoff={agent?.config?.handoff_number}
            avg={o.avg_duration_seconds}
          />
        </Reveal>
      </section>

      {/* Activity timeline */}
      <Reveal delay={60}>
      <section className="mt-3 rounded-xl border border-border bg-card hover-glow">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-medium">Recent activity</h2>
          <Link to="/app/calls" className="text-xs text-muted-foreground hover:text-foreground transition">View all calls</Link>
        </div>
        <ActivityTimeline calls={callsData?.calls ?? []} />
      </section>
      </Reveal>
    </div>
  );
}

function StatusPill({ live }: { live: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
      live ? "border-success/30 text-success" : "border-border text-muted-foreground"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-success animate-live" : "bg-muted-foreground"}`} />
      {live ? "Live" : "Draft"}
    </span>
  );
}

function Metric({
  icon: Icon, label, value, count, sub, delta, muted, delay = 0,
}: {
  icon: any; label: string; value?: string; count?: number; sub?: string; delta?: number; muted?: boolean; delay?: number;
}) {
  return (
    <Reveal delay={delay}>
      <div className="rounded-xl border border-border bg-card p-5 hover-lift sheen h-full">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="w-4 h-4" />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <div className="mt-3 flex items-end gap-2">
          <span className={`text-3xl font-semibold tracking-tight tabular-nums ${muted ? "text-muted-foreground/50" : ""}`}>
            {typeof count === "number" ? <CountUp value={count} /> : value}
          </span>
          {typeof delta === "number" && delta !== 0 && (
            <span className={`mb-1 inline-flex items-center gap-0.5 text-xs font-medium ${delta > 0 ? "text-success" : "text-muted-foreground"}`}>
              <ArrowUpRight className={`w-3 h-3 ${delta < 0 ? "rotate-90" : ""}`} />
              {Math.abs(delta)}
            </span>
          )}
        </div>
        {sub && <div className="mt-1 text-xs text-muted-foreground truncate">{sub}</div>}
      </div>
    </Reveal>
  );
}

function AgentStatus({
  live, number, languages, handoff, avg,
}: {
  live: boolean; number?: string | null; languages: string[]; handoff?: string | null; avg: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Agent</h2>
        <StatusPill live={live} />
      </div>
      <dl className="mt-4 space-y-3 text-sm">
        <Row label="Number automated" value={number || "Not set"} />
        <Row label="Languages" value={languages.slice(0, 3).join(", ")} />
        <Row label="Human handoff" value={handoff ? "On" : "Off"} />
        <Row label="Avg. call length" value={`${Math.floor(avg / 60)}m ${avg % 60}s`} />
      </dl>
      <Link
        to="/onboarding"
        className="mt-auto pt-4 inline-flex items-center gap-1.5 text-sm text-foreground hover:gap-2.5 transition-all"
      >
        Edit agent <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-right truncate max-w-[60%]">{value}</dd>
    </div>
  );
}

function ActivityTimeline({ calls }: { calls: any[] }) {
  if (calls.length === 0) {
    return <div className="px-5 py-10 text-center text-sm text-muted-foreground">No calls yet — your agent is ready and waiting.</div>;
  }
  return (
    <ol className="px-5 py-2">
      {calls.map((c, i) => (
        <li key={c.id} className="relative flex items-center gap-4 py-3">
          {/* timeline rail */}
          <div className="relative flex flex-col items-center self-stretch">
            <span className={`w-2 h-2 rounded-full ${c.has_lead ? "bg-success" : "bg-border"} ring-4 ring-card`} />
            {i < calls.length - 1 && <span className="absolute top-3 w-px h-full bg-border" />}
          </div>
          <Link to="/app/calls/$id" params={{ id: c.id }} className="flex-1 flex items-center justify-between gap-4 group">
            <div className="min-w-0">
              <div className="text-sm font-medium group-hover:text-foreground truncate">{c.caller_number}</div>
              <div className="text-xs text-muted-foreground">{relTime(c.created_at)}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {c.has_lead && (
                <span className="text-xs font-medium text-success border border-success/25 rounded-full px-2 py-0.5">Lead</span>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.floor(c.duration_seconds / 60)}m {c.duration_seconds % 60}s
              </span>
              <span className={`text-xs ${c.status === "active" ? "text-success" : "text-muted-foreground"}`}>
                {c.status}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}
