import { createFileRoute, Outlet, useChildMatches, Link } from "@tanstack/react-router";
import {
  Activity,
  PhoneCall,
  Cpu,
  MemoryStick,
  Gauge,
  Radio,
  Timer,
  Zap,
  Database,
  Boxes,
  Clock,
  AlertTriangle,
  Wifi,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { useOpsOverview, fmtMs, fmtDuration, type SeriesPoint } from "@/lib/ops";
import { useOpsStream } from "@/lib/ops-stream";

// `/admin/ops` is the parent of /live, /latency, /trace/$callSid. Render the
// nested route when one is active, otherwise the Executive dashboard.
export const Route = createFileRoute("/admin/ops")({
  component: OpsRoute,
});

function OpsRoute() {
  const childMatches = useChildMatches();
  return childMatches.length > 0 ? <Outlet /> : <ExecDashboard />;
}

function ExecDashboard() {
  const { connected } = useOpsStream();
  const { data: o, isLoading } = useOpsOverview();

  if (isLoading || !o)
    return <div className="p-8 text-sm text-muted-foreground">Loading telemetry…</div>;

  const series = (o.series || []).map((p: SeriesPoint) => ({
    ...p,
    t: new Date(p.ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  }));

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Activity className="w-7 h-7 text-primary" /> Operations Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live platform telemetry · uptime {fmtUptime(o.uptimeSec)}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <LiveBadge connected={connected} />
          <HealthGauge score={o.healthScore} status={o.status} />
          <nav className="flex gap-2">
            <SubLink to="/admin/ops/live" icon={Radio} label="Live Calls" />
            <SubLink to="/admin/ops/latency" icon={Gauge} label="Latency" />
          </nav>
        </div>
      </div>

      {/* Call volume + concurrency */}
      <Section title="Calls">
        <Grid>
          <Stat icon={PhoneCall} label="Active calls" value={o.activeCalls} accent />
          <Stat icon={Clock} label="Calls this hour" value={o.callsThisHour} />
          <Stat icon={PhoneCall} label="Calls today" value={o.callsToday} />
          <Stat icon={PhoneCall} label="Calls all time" value={o.callsAllTime ?? 0} />
          <Stat icon={Boxes} label="Peak concurrent" value={o.peakConcurrentCalls} />
          <Stat icon={Boxes} label="Avg concurrent" value={o.avgConcurrentCalls} />
          <Stat icon={Timer} label="Avg call duration" value={fmtDuration(o.avgCallDurationMs)} />
        </Grid>
      </Section>

      {/* Latency headline numbers */}
      <Section title="Latency (averages)">
        <Grid>
          <Stat icon={Zap} label="First audio" value={fmtMs(o.avgFirstAudioMs)} />
          <Stat icon={Zap} label="Model latency" value={fmtMs(o.avgModelLatencyMs)} />
          <Stat icon={Timer} label="Avg turn" value={fmtMs(o.avgTurnDurationMs)} />
          <Stat icon={Database} label="RAG retrieval" value={fmtMs(o.avgRagLatencyMs)} />
          <Stat icon={Activity} label="Language detect" value={fmtMs(o.avgLanguageDetectionMs)} />
          <Stat icon={Boxes} label="Tool latency" value={fmtMs(o.avgToolLatencyMs)} />
        </Grid>
      </Section>

      {/* Infra */}
      <Section title="Infrastructure">
        <Grid>
          <Stat icon={Cpu} label="CPU" value={`${o.cpuPct}%`} />
          <Stat icon={MemoryStick} label="Memory (RSS)" value={`${o.memoryMb} MB`} />
          <Stat icon={MemoryStick} label="Heap used" value={`${o.heapUsedMb} MB`} />
          <Stat icon={Gauge} label="Event loop p99" value={fmtMs(o.eventLoopDelayP99Ms)} />
          <Stat icon={Wifi} label="WebSockets" value={o.websockets} />
          <Stat icon={Radio} label="Gemini sessions" value={o.geminiSessions} />
        </Grid>
      </Section>

      {/* Charts */}
      <div className="mt-8 grid lg:grid-cols-2 gap-6">
        <ChartCard title="Concurrency">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="cc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="t"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area
                type="monotone"
                dataKey="activeCalls"
                name="Active calls"
                stroke="var(--color-primary)"
                fill="url(#cc)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="geminiSessions"
                name="Gemini sessions"
                stroke="#22c55e"
                fillOpacity={0}
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="CPU & memory">
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
              <Tooltip contentStyle={tooltipStyle} />
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
                stroke="var(--chart-2)"
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
              <Tooltip contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="eventLoopDelayMs"
                name="mean"
                stroke="var(--chart-3)"
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

        <ChartCard title="WebSockets">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series}>
              <defs>
                <linearGradient id="ws" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="t"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area
                type="monotone"
                dataKey="websockets"
                name="WebSockets"
                stroke="var(--chart-1)"
                fill="url(#ws)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

// ─── Bits ─────────────────────────────────────────────────────────────────────
const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function LiveBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${connected ? "bg-success/15 text-success border-success/30" : "bg-muted text-muted-foreground border-border"}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${connected ? "bg-success animate-pulse" : "bg-muted-foreground"}`}
      />
      {connected ? "Live" : "Polling"}
    </span>
  );
}

function HealthGauge({ score, status }: { score: number; status: string }) {
  const color =
    status === "healthy"
      ? "text-success"
      : status === "degraded"
        ? "text-amber-500"
        : "text-destructive";
  return (
    <div className="flex items-center gap-2">
      {status !== "healthy" && <AlertTriangle className={`w-4 h-4 ${color}`} />}
      <div className="text-right">
        <div className={`text-2xl font-bold leading-none ${color}`}>{score}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{status}</div>
      </div>
    </div>
  );
}

function SubLink({ to, icon: Icon, label }: { to: string; icon: any; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition"
    >
      <Icon className="w-4 h-4" /> {label}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">{children}</div>;
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: any;
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 border bg-card shadow-card ${accent ? "border-primary/40" : "border-border"}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon className={`w-4 h-4 ${accent ? "text-primary" : "text-muted-foreground"}`} />
      </div>
      <div className={`mt-2 text-2xl font-bold ${accent ? "text-primary" : ""}`}>{value}</div>
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
