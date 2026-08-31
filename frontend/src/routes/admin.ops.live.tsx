import { createFileRoute, Link } from "@tanstack/react-router";
import { Radio, GitBranch, PhoneOff, Languages, Wrench, Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { useLiveCalls, useTerminateCall, fmtMs, fmtDuration, type LiveCall } from "@/lib/ops";
import { useOpsStream } from "@/lib/ops-stream";

export const Route = createFileRoute("/admin/ops/live")({
  component: LiveConsole,
});

const STATE_COLOR: Record<string, string> = {
  listening: "bg-blue-500/15 text-blue-500 border-blue-500/30",
  speaking: "bg-success/15 text-success border-success/30",
  thinking: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  active: "bg-muted text-muted-foreground border-border",
  connecting: "bg-muted text-muted-foreground border-border",
  finalizing: "bg-destructive/15 text-destructive border-destructive/30",
};

function LiveConsole() {
  useOpsStream();
  const { data: calls = [] } = useLiveCalls();
  const [selected, setSelected] = useState<LiveCall | null>(null);

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Radio className="w-7 h-7 text-primary" /> Live Calls Console
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {calls.length} active call{calls.length === 1 ? "" : "s"} · updates in real time
          </p>
        </div>
        <Link to="/admin/ops" className="text-sm text-primary hover:underline">
          ← Operations
        </Link>
      </div>

      {calls.length === 0 ? (
        <div className="mt-12 text-center text-muted-foreground">
          <Activity className="w-10 h-10 mx-auto opacity-40" />
          <p className="mt-3 text-sm">No active calls right now.</p>
        </div>
      ) : (
        <div className="mt-6 bg-card border border-border rounded-xl shadow-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Tenant</th>
                <th className="text-left px-4 py-3 font-medium">Caller</th>
                <th className="text-left px-4 py-3 font-medium">Duration</th>
                <th className="text-left px-4 py-3 font-medium">State</th>
                <th className="text-left px-4 py-3 font-medium">Lang</th>
                <th className="text-left px-4 py-3 font-medium">Tool</th>
                <th className="text-left px-4 py-3 font-medium">Latency</th>
                <th className="text-left px-4 py-3 font-medium">RC / Int</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {calls.map((c) => (
                <tr
                  key={c.callSid}
                  className="hover:bg-muted/30 transition cursor-pointer"
                  onClick={() => setSelected(c)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.tenantName || "—"}</div>
                    <div className="text-xs text-muted-foreground">{c.businessNumber || ""}</div>
                  </td>
                  <td className="px-4 py-3">{c.callerNumber || "unknown"}</td>
                  <td className="px-4 py-3 tabular-nums">
                    <Ticker startedAt={c.startedAt} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border ${STATE_COLOR[c.conversationState] || STATE_COLOR.active}`}
                    >
                      {c.conversationState}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {c.language ? (
                      <span className="inline-flex items-center gap-1">
                        <Languages className="w-3 h-3" />
                        {c.language}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.currentTool ? (
                      <span className="inline-flex items-center gap-1 text-amber-500">
                        <Wrench className="w-3 h-3" />
                        {c.currentTool}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{fmtMs(c.lastLatencyMs)}</td>
                  <td className="px-4 py-3 tabular-nums text-xs">
                    {c.reconnects} / {c.interruptions}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex gap-1.5">
                      <Link
                        to="/admin/ops/trace/$callSid"
                        params={{ callSid: c.callSid }}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border hover:bg-muted transition"
                      >
                        <GitBranch className="w-3 h-3" /> Trace
                      </Link>
                      <TerminateButton callSid={c.callSid} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <CallDrawer call={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// Local 1s ticker so the duration column counts up smoothly between data refreshes.
function Ticker({ startedAt }: { startedAt: number }) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{fmtDuration(Date.now() - startedAt)}</>;
}

function TerminateButton({ callSid }: { callSid: string }) {
  const term = useTerminateCall();
  return (
    <button
      onClick={() => {
        if (confirm("Terminate this live call?")) term.mutate(callSid);
      }}
      disabled={term.isPending}
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10 transition disabled:opacity-50"
    >
      <PhoneOff className="w-3 h-3" /> {term.isPending ? "…" : "End"}
    </button>
  );
}

function CallDrawer({ call, onClose }: { call: LiveCall; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-card border-l border-border shadow-xl p-6 overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-lg">{call.tenantName || "Call"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1 break-all">SID {call.callSid}</p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <Field label="Caller" value={call.callerNumber} />
          <Field label="Business" value={call.businessNumber} />
          <Field label="Engine" value={call.engine} />
          <Field label="Model" value={call.model} />
          <Field label="Voice" value={call.voice} />
          <Field label="Language" value={call.language} />
          <Field label="State" value={call.conversationState} />
          <Field label="Last latency" value={fmtMs(call.lastLatencyMs)} />
          <Field label="Reconnects" value={String(call.reconnects)} />
          <Field label="Interruptions" value={String(call.interruptions)} />
          <Field label="Packets in/out" value={`${call.packetsIn} / ${call.packetsOut}`} />
          <Field label="Correlation" value={call.correlationId?.slice(0, 8)} />
        </div>

        <div className="mt-5 space-y-3">
          <Bubble who="Caller" text={call.lastTranscript} />
          <Bubble who="Agent" text={call.lastAgentReply} />
        </div>

        <Link
          to="/admin/ops/trace/$callSid"
          params={{ callSid: call.callSid }}
          className="mt-6 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
        >
          <GitBranch className="w-4 h-4" /> Open full trace
        </Link>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value || "—"}</div>
    </div>
  );
}

function Bubble({ who, text }: { who: string; text: string }) {
  return (
    <div className="rounded-lg border border-border p-3 bg-muted/30">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{who}</div>
      <div className="text-sm mt-1">{text || <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}
