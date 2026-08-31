import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Languages, Radio, PhoneCall, Database, Wrench, Server } from "lucide-react";
import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import {
  useLanguageStats,
  useGeminiStats,
  useTelephonyStats,
  useRagStats,
  useToolStats,
  useInfraStats,
  fmtMs,
  type LatencyStat,
} from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/services")({
  component: ServicesDashboard,
});

const TABS = [
  { id: "gemini", label: "Gemini", icon: Radio },
  { id: "language", label: "Language", icon: Languages },
  { id: "telephony", label: "Telephony", icon: PhoneCall },
  { id: "rag", label: "RAG", icon: Database },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "infra", label: "Infrastructure", icon: Server },
] as const;

function ServicesDashboard() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("gemini");
  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link
        to="/admin/ops"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <h1 className="text-3xl font-bold mt-3">Service Health</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Per-service telemetry, live from the running pipeline.
      </p>

      <div className="mt-6 flex flex-wrap gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${tab === t.id ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "gemini" && <GeminiPanel />}
        {tab === "language" && <LanguagePanel />}
        {tab === "telephony" && <TelephonyPanel />}
        {tab === "rag" && <RagPanel />}
        {tab === "tools" && <ToolsPanel />}
        {tab === "infra" && <InfraPanel />}
      </div>
    </div>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────
function GeminiPanel() {
  const { data: g } = useGeminiStats();
  if (!g) return <Loading />;
  return (
    <>
      <Grid>
        <Stat label="Sessions open" value={g.sessionsOpen} accent />
        <Stat label="Opened" value={g.sessionsOpened} />
        <Stat label="Closed" value={g.sessionsClosed} />
        <Stat label="Reconnects" value={g.reconnects} warn={g.reconnects > 0} />
        <Stat label="Stream errors" value={g.errors} warn={g.errors > 0} />
        <Stat label="Interruptions" value={g.interruptions} />
      </Grid>
      <TwoCol>
        <LatencyCard title="First audio" stat={g.firstAudio} />
        <LatencyCard title="Turn round-trip" stat={g.turn} />
      </TwoCol>
      <CounterBars title="Close codes" data={g.closeCodes} />
      {!g.tokenUsageAvailable && (
        <Note>Token usage is not exposed by the Gemini Live SDK in this integration.</Note>
      )}
    </>
  );
}

function LanguagePanel() {
  const { data: l } = useLanguageStats();
  if (!l) return <Loading />;
  return (
    <>
      <Grid>
        <Stat label="Decisions" value={l.decisions} accent />
        <Stat label="Classifier used" value={l.classifierUsed} />
        <Stat label="Classifier rate" value={`${l.classifierUsageRate}%`} />
        <Stat label="Initializations" value={l.init} />
        <Stat label="Explicit switches" value={l.switchExplicit} />
        <Stat label="Auto switches" value={l.switchAuto} />
      </Grid>
      <TwoCol>
        <CounterBars title="Detected language" data={l.byLanguage} />
        <CounterBars title="Decision source" data={l.bySource} />
      </TwoCol>
      <TwoCol>
        <LatencyCard title="Classifier latency" stat={l.classifierLatency} />
        <LatencyCard title="Confidence (×100)" stat={l.confidence} unit="" />
      </TwoCol>
    </>
  );
}

function TelephonyPanel() {
  const { data: t } = useTelephonyStats();
  if (!t) return <Loading />;
  return (
    <>
      <Grid>
        <Stat label="Incoming" value={t.incoming} accent />
        <Stat label="Answered" value={t.answered} />
        <Stat label="Rejected" value={t.rejected} warn={t.rejected > 0} />
        <Stat
          label="Media failures"
          value={t.mediaStreamFailures}
          warn={t.mediaStreamFailures > 0}
        />
        <Stat label="Active WS" value={t.activeWebsockets} />
        <Stat label="Reconnects" value={t.reconnects} />
      </Grid>
      <TwoCol>
        <LatencyCard title="Webhook" stat={t.webhookLatency} />
        <LatencyCard title="Tenant resolution" stat={t.tenantResolution} />
      </TwoCol>
      <LatencyCard title="Call duration" stat={t.callDuration} />
    </>
  );
}

function RagPanel() {
  const { data: r } = useRagStats();
  if (!r) return <Loading />;
  return (
    <>
      <Grid>
        <Stat label="Cache hits" value={r.cacheHits} accent />
        <Stat label="Cache misses" value={r.cacheMisses} />
        <Stat label="Hit rate" value={`${r.cacheHitRate}%`} />
        <Stat label="No match" value={r.noMatch} warn={r.noMatch > 0} />
        <Stat label="No-match rate" value={`${r.noMatchRate}%`} />
        <Stat label="Avg chunks" value={r.chunksReturned?.avg ?? "—"} />
      </Grid>
      <TwoCol>
        <LatencyCard title="Retrieval (total)" stat={r.retrieval} />
        <LatencyCard title="Embedding" stat={r.embedding} />
      </TwoCol>
      <TwoCol>
        <LatencyCard title="Vector search" stat={r.vectorSearch} />
        <LatencyCard title="Similarity (×100)" stat={r.similarity} unit="" />
      </TwoCol>
    </>
  );
}

function ToolsPanel() {
  const { data: t } = useToolStats();
  if (!t) return <Loading />;
  const tools = Object.entries(t.tools || {}) as [string, any][];
  return (
    <>
      <TwoCol>
        <LatencyCard title="Tool call latency" stat={t.toolCallLatency} />
        <LatencyCard title="Lookup latency" stat={t.lookupLatency} />
      </TwoCol>
      <div className="mt-6 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Tool</th>
              <th className="text-right px-4 py-3 font-medium">Invocations</th>
              <th className="text-right px-4 py-3 font-medium">Success</th>
              <th className="text-right px-4 py-3 font-medium">Failures</th>
              <th className="text-right px-4 py-3 font-medium">Timeouts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tools.map(([name, s]) => {
              const inv =
                (s.ok || 0) + (s.error || 0) + (s.hit || 0) + (s.miss || 0) + (s.timeout || 0);
              return (
                <tr key={name} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{inv}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-success">
                    {(s.ok || 0) + (s.hit || 0)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-destructive">
                    {(s.error || 0) + (s.miss || 0)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-500">
                    {s.timeout || 0}
                  </td>
                </tr>
              );
            })}
            {tools.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No tool invocations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InfraPanel() {
  const { data: i } = useInfraStats();
  if (!i) return <Loading />;
  const series = (i.series || []).map((p: any) => ({
    ...p,
    t: new Date(p.ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  }));
  return (
    <>
      <Grid>
        <Stat label="CPU" value={`${i.cpuPct}%`} accent={i.cpuPct > 85} />
        <Stat label="Memory (RSS)" value={`${i.memoryMb} MB`} />
        <Stat label="Heap used" value={`${i.heapUsedMb} MB`} />
        <Stat
          label="Event loop p99"
          value={fmtMs(i.eventLoopDelayP99Ms)}
          warn={i.eventLoopDelayP99Ms > 100}
        />
        <Stat label="WebSockets" value={i.websockets} />
        <Stat label="Active calls" value={i.activeCalls} />
      </Grid>
      <div className="mt-6 grid lg:grid-cols-2 gap-6">
        <ChartCard title="CPU & heap">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="t"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
              <Tooltip contentStyle={tip} />
              <Line
                type="monotone"
                dataKey="cpuPct"
                name="CPU %"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="heapUsedMb"
                name="Heap MB"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Event loop delay (ms)">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="t"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
              <Tooltip contentStyle={tip} />
              <Line
                type="monotone"
                dataKey="eventLoopDelayMs"
                name="mean"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="eventLoopDelayP99Ms"
                name="p99"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────
const tip = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};
const Loading = () => <div className="text-sm text-muted-foreground">Loading…</div>;
const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-4 text-xs text-muted-foreground italic">{children}</p>
);

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">{children}</div>;
}
function TwoCol({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 grid md:grid-cols-2 gap-4">{children}</div>;
}
function Stat({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 border bg-card shadow-card ${warn ? "border-amber-500/50" : accent ? "border-primary/40" : "border-border"}`}
    >
      <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div
        className={`mt-2 text-2xl font-bold ${warn ? "text-amber-500" : accent ? "text-primary" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
function LatencyCard({
  title,
  stat,
  unit = "ms",
}: {
  title: string;
  stat: LatencyStat | null;
  unit?: string;
}) {
  return (
    <div className="rounded-xl p-4 border border-border bg-card shadow-card">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-[11px] text-muted-foreground">{stat?.count ?? 0} samples</span>
      </div>
      {stat && stat.count > 0 ? (
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          {(["p50", "p90", "p95", "p99"] as const).map((p) => (
            <div key={p}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{p}</div>
              <div className="text-sm font-bold tabular-nums">
                {unit === "ms" ? fmtMs(stat[p]) : stat[p]}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-sm text-muted-foreground">No samples yet.</div>
      )}
    </div>
  );
}
function CounterBars({ title, data }: { title: string; data: Record<string, number> }) {
  const rows = Object.entries(data || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  return (
    <div className="mt-6 bg-card border border-border rounded-xl p-5 shadow-card">
      <h3 className="font-semibold text-sm">{title}</h3>
      <div className="mt-3 h-48">
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No data yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border)"
                horizontal={false}
              />
              <XAxis
                type="number"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                width={110}
              />
              <Tooltip contentStyle={tip} />
              <Bar dataKey="value" fill="var(--color-primary)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-card">
      <h3 className="font-semibold text-sm">{title}</h3>
      <div className="mt-4 h-56">{children}</div>
    </div>
  );
}
