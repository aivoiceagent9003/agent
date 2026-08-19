import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, BellRing, BellOff, CheckCircle2, AlertTriangle } from "lucide-react";
import { useAlerts, fmtDuration } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/alerts")({
  component: AlertCenter,
});

const SEV: Record<string, { badge: string; dot: string }> = {
  critical: {
    badge: "bg-destructive/15 text-destructive border-destructive/30",
    dot: "bg-destructive",
  },
  warning: { badge: "bg-amber-500/15 text-amber-500 border-amber-500/30", dot: "bg-amber-500" },
  info: { badge: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground" },
};

function AlertCenter() {
  const { data } = useAlerts();
  const active = data?.active || [];
  const history = data?.history || [];
  const rules = data?.rules || [];

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link
        to="/admin/ops"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <h1 className="text-3xl font-bold flex items-center gap-3 mt-3">
        <BellRing className="w-7 h-7 text-primary" /> Alert Center
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        Threshold rules evaluated continuously against live telemetry.
      </p>

      {/* Active alerts */}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-8 mb-3">
        Active {active.length > 0 && <span className="text-destructive">({active.length})</span>}
      </h2>
      {active.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-6 shadow-card flex items-center gap-3 text-success">
          <CheckCircle2 className="w-6 h-6" />
          <span className="text-sm font-medium">All clear — no firing alerts.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {active.map((a: any) => (
            <div
              key={a.id}
              className={`rounded-xl border p-4 shadow-card flex items-center justify-between ${SEV[a.severity]?.badge || SEV.info.badge}`}
            >
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5" />
                <div>
                  <div className="font-semibold">{a.label}</div>
                  <div className="text-xs opacity-80">
                    {a.message} · threshold {a.threshold}
                  </div>
                </div>
              </div>
              <div className="text-xs text-right">
                <div className="uppercase font-medium">{a.severity}</div>
                <div className="opacity-70">firing {fmtDuration(Date.now() - a.since)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-10 grid lg:grid-cols-2 gap-6">
        {/* Rules */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Rules ({rules.length})
          </h2>
          <div className="bg-card border border-border rounded-xl shadow-card divide-y divide-border">
            {rules.map((r: any) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-2 h-2 rounded-full ${r.active ? SEV[r.severity]?.dot : "bg-success"}`}
                  />
                  <div>
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-[11px] text-muted-foreground capitalize">
                      {r.group} · {r.severity}
                    </div>
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full border ${r.active ? SEV[r.severity]?.badge : "bg-success/15 text-success border-success/30"}`}
                >
                  {r.active ? "firing" : "ok"} · ≥ {r.threshold}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* History */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            History
          </h2>
          <div className="bg-card border border-border rounded-xl shadow-card divide-y divide-border max-h-[420px] overflow-auto">
            {history.map((h: any, i: number) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                {h.event === "fired" ? (
                  <BellRing className="w-4 h-4 text-destructive shrink-0" />
                ) : (
                  <BellOff className="w-4 h-4 text-success shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">
                    <span className="font-medium">{h.label}</span>{" "}
                    <span className="text-muted-foreground">{h.event}</span>
                  </div>
                  {h.event === "resolved" && (
                    <div className="text-[11px] text-muted-foreground">
                      lasted {fmtDuration(h.durationMs)}
                    </div>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(h.ts).toLocaleTimeString()}
                </span>
              </div>
            ))}
            {history.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No alert history yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
