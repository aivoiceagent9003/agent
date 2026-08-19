import { createFileRoute, Link } from "@tanstack/react-router";
import { Gauge, ArrowLeft } from "lucide-react";
import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useLatency, useMetricHistory, fmtMs, type LatencyStat } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/latency")({
  component: LatencyDashboard,
});

// Human labels + display order for the operation keys telemetry emits.
const OP_LABELS: Record<string, string> = {
  webhook: "Webhook",
  tenant_resolution: "Tenant resolution",
  supabase: "Supabase query",
  first_audio: "First audio",
  model_thinking: "Model thinking",
  turn: "Turn round-trip",
  language_detection: "Language detection",
  rag_retrieval: "RAG retrieval",
  embedding: "Embedding",
  vector_search: "Vector search",
  tool_call: "Tool call",
  lookup: "Lookup",
  lead_extraction: "Lead extraction",
  finalize: "Finalize",
  call_duration: "Call duration",
};
const ORDER = Object.keys(OP_LABELS);

function LatencyDashboard() {
  const { data: stats = {}, isLoading } = useLatency();
  const [selected, setSelected] = useState<string | null>(null);

  // Sort known ops first (by ORDER), then any extras alphabetically.
  const ops = Object.keys(stats).sort((a, b) => {
    const ia = ORDER.indexOf(a),
      ib = ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link
        to="/admin/ops"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <h1 className="text-3xl font-bold flex items-center gap-3 mt-3">
        <Gauge className="w-7 h-7 text-primary" /> Latency
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        Percentiles per operation (live, from the in-memory histogram). Click a card for its trend.
      </p>

      {isLoading && <div className="mt-8 text-sm text-muted-foreground">Loading…</div>}

      <div className="mt-6 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {ops.map((op) => (
          <LatencyCard
            key={op}
            op={op}
            stat={stats[op]}
            active={selected === op}
            onClick={() => setSelected(selected === op ? null : op)}
          />
        ))}
        {!isLoading && ops.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full">
            No latency samples yet — place a call to populate the histograms.
          </p>
        )}
      </div>

      {selected && <HistoryChart op={selected} />}
    </div>
  );
}

function LatencyCard({
  op,
  stat,
  active,
  onClick,
}: {
  op: string;
  stat: LatencyStat;
  active: boolean;
  onClick: () => void;
}) {
  // Warn coloring on slow p99s for the latency-critical ops.
  const slow =
    (op === "first_audio" && stat.p99 > 1500) || (op === "rag_retrieval" && stat.p99 > 2000);
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl p-4 border bg-card shadow-card transition hover:border-primary/50 ${active ? "border-primary" : slow ? "border-amber-500/50" : "border-border"}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{OP_LABELS[op] || op}</span>
        <span className="text-[11px] text-muted-foreground">{stat.count} samples</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Pct label="p50" value={stat.p50} />
        <Pct label="p90" value={stat.p90} />
        <Pct label="p95" value={stat.p95} />
        <Pct label="p99" value={stat.p99} highlight={slow} />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>min {fmtMs(stat.min)}</span>
        <span>avg {fmtMs(stat.avg)}</span>
        <span>max {fmtMs(stat.max)}</span>
      </div>
    </button>
  );
}

function Pct({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${highlight ? "text-amber-500" : ""}`}>
        {fmtMs(value)}
      </div>
    </div>
  );
}

function HistoryChart({ op }: { op: string }) {
  const { data: rows = [], isLoading } = useMetricHistory(op);
  const data = rows.map((r: any) => ({
    t: new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    p50: r.p50,
    p95: r.p95,
    p99: r.p99,
  }));
  return (
    <div className="mt-8 bg-card border border-border rounded-xl p-5 shadow-card">
      <h2 className="font-semibold text-sm">{OP_LABELS[op] || op} — trend</h2>
      <div className="mt-4 h-64">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading history…</div>
        ) : data.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No history yet — rollups accumulate every ~30s.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="t"
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                minTickGap={40}
              />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend />
              <Line type="monotone" dataKey="p50" stroke="#22c55e" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p99" stroke="#ef4444" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
