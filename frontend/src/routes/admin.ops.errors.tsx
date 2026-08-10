import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, AlertTriangle, ShieldAlert, Activity } from "lucide-react";
import { useState } from "react";
import { useErrorStats, useDowntime, fmtDuration } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/errors")({
  component: ErrorsDashboard,
});

const SEV_COLOR: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  error: "bg-red-500/15 text-red-500 border-red-500/30",
  warning: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  info: "bg-muted text-muted-foreground border-border",
};

function ErrorsDashboard() {
  const { data: e } = useErrorStats();
  const { data: d } = useDowntime();
  const [component, setComponent] = useState<string | null>(null);

  const byComponent: Record<string, any> = e?.byComponent || {};
  const recent = (e?.recent || []).filter((ev: any) => !component || ev.component === component);
  const incidents = d?.incidents || [];

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link to="/admin/ops" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <h1 className="text-3xl font-bold flex items-center gap-3 mt-3">
        <ShieldAlert className="w-7 h-7 text-primary" /> Errors & Downtime
      </h1>
      <p className="text-sm text-muted-foreground mt-1">Every exception and incident captured from the live pipeline.</p>

      {/* Component breakdown */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-8 mb-3">By component</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {Object.entries(byComponent).map(([name, g]: [string, any]) => (
          <button key={name} onClick={() => setComponent(component === name ? null : name)}
            className={`text-left rounded-xl p-4 border bg-card shadow-card transition hover:border-primary/50 ${component === name ? "border-primary" : g.critical > 0 ? "border-destructive/50" : g.error > 0 ? "border-red-500/40" : "border-border"}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm capitalize">{name}</span>
              <span className="text-2xl font-bold">{g.total}</span>
            </div>
            <div className="mt-2 flex gap-1.5 flex-wrap text-[11px]">
              {g.critical > 0 && <span className="px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">{g.critical} crit</span>}
              {g.error > 0 && <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{g.error} err</span>}
              {g.warning > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">{g.warning} warn</span>}
            </div>
          </button>
        ))}
        {Object.keys(byComponent).length === 0 && <p className="text-sm text-muted-foreground col-span-full">No errors recorded — clean run. 🎉</p>}
      </div>

      {/* Downtime incidents */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-10 mb-3">Incidents (clustered error/critical events)</h2>
      <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Component</th>
              <th className="text-left px-4 py-3 font-medium">Severity</th>
              <th className="text-left px-4 py-3 font-medium">Started</th>
              <th className="text-left px-4 py-3 font-medium">Duration</th>
              <th className="text-right px-4 py-3 font-medium">Events</th>
              <th className="text-left px-4 py-3 font-medium">Root cause</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {incidents.map((i: any, idx: number) => (
              <tr key={idx} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium capitalize">{i.component}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full border ${SEV_COLOR[i.severity]}`}>{i.severity}</span></td>
                <td className="px-4 py-3 text-muted-foreground">{new Date(i.start).toLocaleString()}</td>
                <td className="px-4 py-3 tabular-nums">{fmtDuration(i.durationMs)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{i.count}</td>
                <td className="px-4 py-3 font-mono text-xs">{i.rootCause}</td>
              </tr>
            ))}
            {incidents.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground"><Activity className="w-6 h-6 mx-auto opacity-40" /><div className="mt-1">No incidents.</div></td></tr>}
          </tbody>
        </table>
      </div>

      {/* Recent event stream */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-10 mb-3">
        Recent events {component && <button onClick={() => setComponent(null)} className="ml-2 text-primary normal-case">({component} — clear filter)</button>}
      </h2>
      <div className="bg-card border border-border rounded-xl shadow-card divide-y divide-border max-h-[480px] overflow-auto">
        {recent.map((ev: any, idx: number) => (
          <div key={idx} className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 ${SEV_COLOR[ev.severity] || SEV_COLOR.info}`}>
              {ev.severity === "critical" || ev.severity === "error" ? <AlertTriangle className="w-3 h-3 inline -mt-0.5" /> : null} {ev.severity}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium capitalize">{ev.component}</span>
                <span className="text-muted-foreground"> · {ev.kind}</span>
              </div>
              {ev.detail && Object.keys(ev.detail).length > 0 && (
                <div className="text-xs text-muted-foreground font-mono truncate">{JSON.stringify(ev.detail)}</div>
              )}
            </div>
            <span className="text-xs text-muted-foreground shrink-0">{new Date(ev.ts).toLocaleTimeString()}</span>
          </div>
        ))}
        {recent.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No events.</div>}
      </div>
    </div>
  );
}
