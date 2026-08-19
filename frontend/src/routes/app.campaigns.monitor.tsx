import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Radio, AlertTriangle, PhoneCall } from "lucide-react";
import { useCampaignMonitor } from "@/lib/campaigns";

export const Route = createFileRoute("/app/campaigns/monitor")({ component: Monitor });

function Monitor() {
  const { data } = useCampaignMonitor();
  const queues = data?.queues || {};
  const live = data?.liveCalls || [];
  const running = data?.running || [];
  const redis = data?.redis;

  const dial = queues["campaign-dial"];
  const bcast = queues["campaign-broadcast"];
  const retry = queues["campaign-retry"];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <Link
        to="/app/campaigns"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Campaigns
      </Link>
      <h1 className="text-3xl font-bold flex items-center gap-3 mt-3">
        <Radio className="w-7 h-7 text-primary" /> Real-Time Monitor
      </h1>

      {!redis && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-600 p-4 flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4" /> Queue backend (Redis) not configured — set REDIS_URL
          and run <code className="mx-1">npm run worker</code> to execute campaigns.
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <Q label="Calls in progress" value={live.length} accent />
        <Q label="Queued dials" value={qsum(dial, "waiting", "delayed")} />
        <Q label="Active dials" value={dial?.active ?? 0} />
        <Q label="Retries queued" value={qsum(retry, "waiting", "delayed")} />
        <Q label="Broadcast queued" value={qsum(bcast, "waiting", "delayed")} />
        <Q label="Broadcast active" value={bcast?.active ?? 0} />
        <Q
          label="Failed jobs"
          value={(dial?.failed ?? 0) + (bcast?.failed ?? 0)}
          warn={(dial?.failed ?? 0) + (bcast?.failed ?? 0) > 0}
        />
        <Q label="Running campaigns" value={running.length} />
      </div>

      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-10 mb-3">
        Calls in progress
      </h2>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2">Callee</th>
              <th className="text-left px-4 py-2">State</th>
              <th className="text-left px-4 py-2">Language</th>
              <th className="text-left px-4 py-2">Latency</th>
              <th className="text-left px-4 py-2">Trace</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {live.map((c: any) => (
              <tr key={c.callSid} className="hover:bg-muted/30">
                <td className="px-4 py-2 tabular-nums">{c.callerNumber}</td>
                <td className="px-4 py-2">{c.conversationState}</td>
                <td className="px-4 py-2">{c.language || "—"}</td>
                <td className="px-4 py-2 tabular-nums">
                  {c.lastLatencyMs ? `${c.lastLatencyMs}ms` : "—"}
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1 text-primary">
                    <PhoneCall className="w-3 h-3" /> {c.callSid.slice(0, 8)}
                  </span>
                </td>
              </tr>
            ))}
            {live.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No live outbound calls.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function qsum(q: any, ...keys: string[]) {
  return q ? keys.reduce((a, k) => a + (q[k] ?? 0), 0) : 0;
}
function Q({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 border bg-card shadow-card ${warn ? "border-destructive/50" : accent ? "border-primary/40" : "border-border"}`}
    >
      <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div
        className={`mt-2 text-2xl font-bold ${warn ? "text-destructive" : accent ? "text-primary" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
