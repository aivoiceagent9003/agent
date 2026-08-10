import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Sparkles, Copy, VolumeX, Languages, ArrowRightLeft, Database, Wrench } from "lucide-react";
import { useQualityStats } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/quality")({
  component: QualityDashboard,
});

function QualityDashboard() {
  const { data: q, isLoading } = useQualityStats();
  if (isLoading || !q) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  const scoreColor = q.qualityScore >= 80 ? "text-success" : q.qualityScore >= 60 ? "text-amber-500" : "text-destructive";

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link to="/admin/ops" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <div className="flex items-center justify-between flex-wrap gap-4 mt-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Sparkles className="w-7 h-7 text-primary" /> AI Quality
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Conversation quality from live signal across {q.calls} calls / {q.turns} turns.</p>
        </div>
        <div className="text-right">
          <div className={`text-5xl font-bold ${scoreColor}`}>{q.qualityScore}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Quality score</div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <Metric icon={VolumeX} label="Silent responses" value={q.silentResponses} sub={`${q.silentRate}% of turns`} bad={q.silentRate > 5} />
        <Metric icon={Copy} label="Duplicate replies" value={q.duplicateReplies} bad={q.duplicateReplies > 0} />
        <Metric icon={Languages} label="Language failures" value={q.languageFailures} bad={q.languageFailures > 0} />
        <Metric icon={ArrowRightLeft} label="Language drift" value={q.languageDrift} sub="auto + explicit switches" />
        <Metric icon={ArrowRightLeft} label="Human transfers" value={q.humanTransfers} sub={`${q.escalationRate}% escalation`} />
        <Metric icon={Database} label="RAG no-match" value={q.ragNoMatch} sub={`${q.ragNoMatchRate}% of searches`} bad={q.ragNoMatchRate > 30} />
        <Metric icon={Wrench} label="Tool errors" value={q.toolErrors} bad={q.toolErrors > 0} />
        <Metric icon={Sparkles} label="Interruptions" value={q.interruptions} sub="caller barge-ins" />
      </div>

      <div className="mt-8 bg-card border border-border rounded-xl p-5 shadow-card">
        <h2 className="font-semibold text-sm">Deeper quality grading</h2>
        <p className="text-sm text-muted-foreground mt-2">
          These metrics require a post-call LLM judge, which is not yet wired in this build —
          shown here transparently rather than fabricated:
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(q.needsLlmJudge || []).map((m: string) => (
            <span key={m} className="text-xs px-2.5 py-1 rounded-full border border-dashed border-border text-muted-foreground">
              {labelize(m)} · pending
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function labelize(s: string) {
  return s.replace(/Rate$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

function Metric({ icon: Icon, label, value, sub, bad }: { icon: any; label: string; value: number; sub?: string; bad?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border bg-card shadow-card ${bad ? "border-destructive/50" : "border-border"}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon className={`w-4 h-4 ${bad ? "text-destructive" : "text-muted-foreground"}`} />
      </div>
      <div className={`mt-2 text-2xl font-bold ${bad ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
