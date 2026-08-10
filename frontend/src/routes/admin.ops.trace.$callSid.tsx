import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { GitBranch, ArrowLeft, AlertCircle } from "lucide-react";
import { useCallTrace, fmtMs, fmtDuration, type TraceSpan } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/trace/$callSid")({
  component: TraceView,
});

// Color per span category for the waterfall bars.
function spanColor(name: string) {
  if (/webhook|tenant|websocket|db_call/.test(name)) return "#64748b";
  if (/gemini_session/.test(name)) return "#22c55e";
  if (/first_audio|model_thinking|turn/.test(name)) return "#3b82f6";
  if (/rag|embedding|vector/.test(name)) return "#a855f7";
  if (/tool_call|lookup/.test(name)) return "#f59e0b";
  if (/lead|finalize|recording/.test(name)) return "#06b6d4";
  if (/barge_in|handoff/.test(name)) return "#ec4899";
  return "#94a3b8";
}

function TraceView() {
  const { callSid } = useParams({ from: "/admin/ops/trace/$callSid" });
  const { data: trace, isLoading, isError } = useCallTrace(callSid);

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading trace…</div>;
  if (isError || !trace) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <BackLink />
        <div className="mt-8 text-center text-muted-foreground">
          <AlertCircle className="w-10 h-10 mx-auto opacity-40" />
          <p className="mt-3 text-sm">Trace not found — it may have aged out of the in-memory buffer.</p>
        </div>
      </div>
    );
  }

  const spans = trace.spans || [];
  // Timeline extent: from 0 to the last span end (or call duration).
  const total = Math.max(
    trace.durationMs || 0,
    ...spans.map((s) => (s.startRel || 0) + (s.durationMs || 0)),
    1,
  );

  return (
    <div className="p-8 max-w-[1200px] mx-auto">
      <BackLink />
      <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <GitBranch className="w-7 h-7 text-primary" /> Call Trace
          </h1>
          <p className="text-sm text-muted-foreground mt-1 break-all">
            {trace.tenantName || "—"} · {trace.callerNumber || "unknown"} · SID {trace.callSid}
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Meta label="Status" value={trace.status} />
          <Meta label="Duration" value={fmtDuration(trace.durationMs)} />
          <Meta label="Spans" value={String(spans.length)} />
          <Meta label="Reconnects" value={String(trace.reconnects)} />
        </div>
      </div>

      {/* Waterfall */}
      <div className="mt-8 bg-card border border-border rounded-xl shadow-card p-5">
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
          <span>Timeline (call start → end)</span>
          <span>{fmtMs(total)} total</span>
        </div>
        <div className="space-y-1.5">
          {spans.map((s, i) => (
            <SpanRow key={i} span={s} total={total} />
          ))}
          {spans.length === 0 && <p className="text-sm text-muted-foreground">No spans recorded.</p>}
        </div>
      </div>
    </div>
  );
}

function SpanRow({ span, total }: { span: TraceSpan; total: number }) {
  const left = Math.max(0, ((span.startRel || 0) / total) * 100);
  const width = Math.max(0.5, ((span.durationMs || 0) / total) * 100);
  const isError = span.status === "error";
  return (
    <div className="group grid grid-cols-[220px_1fr_90px] items-center gap-3 text-sm">
      <div className="truncate font-medium flex items-center gap-1.5" title={span.name}>
        <span className="w-2 h-2 rounded-sm" style={{ background: spanColor(span.name) }} />
        {span.name}
        {span.retryCount > 0 && <span className="text-[10px] text-amber-500">×{span.retryCount + 1}</span>}
      </div>
      <div className="relative h-5 rounded bg-muted/40">
        <div
          className="absolute h-5 rounded flex items-center"
          style={{
            left: `${left}%`,
            width: `${width}%`,
            background: isError ? "var(--color-destructive)" : spanColor(span.name),
            opacity: isError ? 0.9 : 0.85,
          }}
          title={span.error || ""}
        />
      </div>
      <div className={`text-right tabular-nums text-xs ${isError ? "text-destructive" : "text-muted-foreground"}`}>
        {fmtMs(span.durationMs)}
      </div>
      {(isError || span.payloadBytes > 0 || Object.keys(span.attrs || {}).length > 0) && (
        <div className="col-span-3 -mt-1 ml-[232px] text-[11px] text-muted-foreground hidden group-hover:block">
          {isError && <span className="text-destructive">⚠ {span.error} · </span>}
          {span.payloadBytes > 0 && <span>{span.payloadBytes} bytes · </span>}
          {Object.entries(span.attrs || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/admin/ops/live" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
      <ArrowLeft className="w-4 h-4" /> Live Calls
    </Link>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
