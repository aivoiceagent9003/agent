// /app/analytics — trends across calls, leads and agent performance.
//
// This was the "Overview" page. Overview tried to be two things at once: a
// welcome mat and a report. It is now only the report, and /app is the welcome.
//
// Every panel reads from one endpoint (/api/client/analytics), and every number
// on it is measured from this tenant's own rows. Where a measurement genuinely
// doesn't exist the tile shows "—" with a line explaining what would produce it,
// rather than a zero that reads like a finding.

import { createFileRoute } from "@tanstack/react-router";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { useClientAnalytics, type Breakdown } from "@/lib/data";
import { useMe } from "@/lib/team";

export const Route = createFileRoute("/app/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Vocera" }] }),
  component: Analytics,
});

const RANGE_DAYS = 30;
const DURATION_DAYS = 15;

// Charts get the theme's own palette so they stay legible in both themes — a
// hard-coded hex would survive the theme switch and nothing else would.
const SERIES = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "var(--color-success)",
  neutral: "var(--color-muted-foreground)",
  frustrated: "var(--color-warning)",
  angry: "var(--color-destructive)",
};

function Analytics() {
  const { data: a, isLoading, isError } = useClientAnalytics(RANGE_DAYS);
  const { data: me } = useMe();

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading analytics…</div>;
  if (isError || !a) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Analytics couldn't be loaded right now.
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Trends across calls, leads and agent performance
          {me?.tenant.business_name ? ` for ${me.tenant.business_name}` : ""} — last {a.range_days}{" "}
          days.
        </p>
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Pickup rate"
          value={a.kpis.pickup_rate}
          format={(v) => `${v}%`}
          sub="Calls answered by your agent"
          empty="No completed calls yet"
        />
        <Kpi
          label="Handoff rate"
          value={a.kpis.handoff_rate}
          format={(v) => `${v}%`}
          sub="Transferred to your team"
          empty="No completed calls yet"
        />
        <Kpi
          label="Info hit rate"
          value={a.kpis.info_hit_rate}
          format={(v) => `${v}%`}
          sub="Answered using your business info"
          empty="Nobody has asked something your agent looked up"
        />
        <Kpi
          label="Avg. response"
          value={a.kpis.avg_reply_ms}
          format={(v) => `${(v / 1000).toFixed(2)}s`}
          sub="Time to first reply"
          empty="Measured from your next call onward"
        />
      </section>

      <section className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Call volume"
          sub={`Calls handled per day, last ${a.range_days} days`}
        >
          {a.total_calls === 0 ? (
            <Empty>No calls in this period.</Empty>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={a.call_volume} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="volumeFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    allowDecimals={false}
                  />
                  <Tooltip
                    {...TOOLTIP}
                    labelFormatter={fullDate}
                    formatter={(v: any) => [v, "calls"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="calls"
                    stroke="var(--color-chart-1)"
                    strokeWidth={2}
                    fill="url(#volumeFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Language breakdown" sub="What your callers speak">
          <LanguageDonut items={a.languages} />
        </Panel>
      </section>

      <section className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Avg. call duration"
          badge={
            a.avg_duration_seconds ? `${formatDuration(a.avg_duration_seconds)} avg` : undefined
          }
          sub={`Trend over the last ${DURATION_DAYS} days`}
        >
          {a.duration_trend.every((d) => d.avg_seconds === null) ? (
            <Empty>No calls in this period.</Empty>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={a.duration_trend}
                  margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                >
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={(s: number) => `${Math.round(s / 60)}m`}
                  />
                  <Tooltip
                    {...TOOLTIP}
                    labelFormatter={fullDate}
                    formatter={(v: any) => [v === null ? "—" : formatDuration(v), "avg duration"]}
                  />
                  {/* connectNulls: a quiet day is a gap in the data, not a drop to zero. */}
                  <Line
                    type="monotone"
                    dataKey="avg_seconds"
                    stroke="var(--color-chart-3)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Caller sentiment" sub="Across all leads this period">
          <SentimentBar items={a.sentiment} />
        </Panel>
      </section>

      <section className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel
          title="Lead funnel"
          badge={`${pct(a.funnel.leads_captured, a.funnel.calls_handled)}% capture rate`}
          sub="Where calls turn into work for your team"
        >
          <Funnel funnel={a.funnel} />
        </Panel>

        <Panel title="Top caller intents" sub="What callers asked about most">
          <Intents items={a.intents} />
        </Panel>
      </section>
    </div>
  );
}

// ─── Shared chrome ───────────────────────────────────────────────────────────

const TOOLTIP = {
  cursor: { fill: "var(--color-muted)", opacity: 0.4 },
  contentStyle: {
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    fontSize: 12,
    boxShadow: "var(--shadow-card)",
  },
  labelStyle: { color: "var(--color-muted-foreground)" },
} as const;

function Panel({
  title,
  sub,
  badge,
  className = "",
  children,
}: {
  title: string;
  sub?: string;
  badge?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-border bg-card p-5 ${className}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <h2 className="text-sm font-medium">{title}</h2>
        {badge && <span className="text-xs text-muted-foreground">{badge}</span>}
      </div>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-56 grid place-items-center text-sm text-muted-foreground">{children}</div>
  );
}

/** A headline number. `null` means unmeasured — never render that as a zero. */
function Kpi({
  label,
  value,
  format,
  sub,
  empty,
}: {
  label: string;
  value: number | null;
  format: (v: number) => string;
  sub: string;
  empty: string;
}) {
  const known = typeof value === "number";
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${
          known ? "" : "text-muted-foreground/40"
        }`}
      >
        {known ? format(value!) : "—"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{known ? sub : empty}</div>
    </div>
  );
}

// ─── Panels ──────────────────────────────────────────────────────────────────

function LanguageDonut({ items }: { items: Breakdown[] }) {
  const total = items.reduce((a, i) => a + i.count, 0);
  if (!total) return <Empty>No leads in this period.</Empty>;

  return (
    <div>
      <div className="relative h-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={items}
              dataKey="count"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="none"
            >
              {items.map((_, i) => (
                <Cell key={i} fill={SERIES[i % SERIES.length]} />
              ))}
            </Pie>
            <Tooltip {...TOOLTIP} formatter={(v: any, n: any) => [v, n]} />
          </PieChart>
        </ResponsiveContainer>
        {/* Centred over the hole, and click-through so it can't eat tooltips. */}
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="text-center">
            <div className="text-2xl font-semibold tabular-nums">{total.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">leads</div>
          </div>
        </div>
      </div>

      <ul className="mt-4 space-y-2">
        {items.map((it, i) => (
          <li key={it.key} className="flex items-center gap-2 text-sm">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: SERIES[i % SERIES.length] }}
            />
            <span className="truncate">{it.label}</span>
            <span className="ml-auto tabular-nums">{it.pct}%</span>
            <span className="w-12 text-right tabular-nums text-muted-foreground">{it.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SentimentBar({ items }: { items: Breakdown[] }) {
  const total = items.reduce((a, i) => a + i.count, 0);
  if (!total) return <Empty>No leads in this period.</Empty>;

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full">
        {items.map((it) => (
          <span
            key={it.key}
            title={`${it.label} · ${it.pct}%`}
            style={{
              width: `${it.pct}%`,
              background: SENTIMENT_COLOR[it.key] || "var(--color-muted-foreground)",
            }}
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2">
        {items.map((it) => (
          <li key={it.key} className="flex items-center gap-2 text-sm">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: SENTIMENT_COLOR[it.key] || "var(--color-muted-foreground)" }}
            />
            <span className="truncate">{it.label}</span>
            <span className="ml-auto tabular-nums">{it.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Funnel({
  funnel,
}: {
  funnel: {
    calls_handled: number;
    conversations: number;
    leads_captured: number;
    follow_ups: number;
  };
}) {
  const top = funnel.calls_handled;
  if (!top) return <Empty>No calls in this period.</Empty>;

  const rows = [
    { label: "Calls handled", value: funnel.calls_handled, color: "var(--color-chart-1)" },
    { label: "Conversations held", value: funnel.conversations, color: "var(--color-chart-2)" },
    { label: "Leads captured", value: funnel.leads_captured, color: "var(--color-chart-3)" },
    { label: "Follow-ups needed", value: funnel.follow_ups, color: "var(--color-warning)" },
  ];

  return (
    <ol className="space-y-4">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>{r.label}</span>
            <span className="tabular-nums">
              {r.value.toLocaleString()}
              <span className="text-muted-foreground"> · {pct(r.value, top)}%</span>
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-muted overflow-hidden">
            <span
              className="block h-full rounded-full transition-all"
              style={{ width: `${pct(r.value, top)}%`, background: r.color }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Intents({ items }: { items: Breakdown[] }) {
  if (!items.length) return <Empty>No intents captured yet.</Empty>;
  const max = Math.max(...items.map((i) => i.count));

  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-3 text-sm">
          <span className="w-24 shrink-0 truncate capitalize" title={it.label}>
            {it.label}
          </span>
          <span className="flex-1 h-5 rounded bg-muted overflow-hidden">
            <span
              className="block h-full rounded"
              style={{ width: `${pct(it.count, max)}%`, background: "var(--color-chart-1)" }}
            />
          </span>
          <span className="w-10 text-right tabular-nums text-muted-foreground">{it.count}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 100) : 0;
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
