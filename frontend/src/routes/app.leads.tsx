import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useClientLeads, exportLeadsCsv } from "@/lib/data";
import { SentimentBadge } from "./app.calls.$id";
import { Download, FileText, X } from "lucide-react";
import { toast } from "sonner";

// Render a stored transcript ("user: …" / "assistant: …") as readable
// [Caller]/[Agent] lines.
function formatTranscript(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((t) => {
      if (t.startsWith("[")) return t;
      const m = t.match(/^(user|caller|customer|assistant|agent|bot|system)\s*:\s*(.*)$/i);
      if (!m) return `[Caller] ${t}`;
      const role = m[1].toLowerCase();
      const who = ["assistant", "agent", "bot", "system"].includes(role) ? "Agent" : "Caller";
      return `[${who}] ${m[2]}`;
    });
}

const PAGE_SIZE = 10;

export const Route = createFileRoute("/app/leads")({
  component: LeadsList,
});

function LeadsList() {
  const [intent, setIntent] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [page, setPage] = useState(1);
  const [transcript, setTranscript] = useState<{ name: string; text: string } | null>(null);

  const { data: leads = [] } = useClientLeads();

  const filtered = useMemo(() => {
    return leads.filter((l) =>
      (!intent || l.intent === intent) &&
      (!sentiment || l.sentiment === sentiment) &&
      (!followUp || (followUp === "yes" ? l.follow_up_needed : !l.follow_up_needed))
    );
  }, [leads, intent, sentiment, followUp]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function exportCsv() {
    try {
      await exportLeadsCsv();
      toast.success("Export downloaded.");
    } catch (e: any) {
      toast.error(e.message || "Export failed");
    }
  }

  const intents = Array.from(new Set(leads.map((l) => l.intent)));

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">{filtered.length} leads.</p>
        </div>
        <button onClick={exportCsv} className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow hover:opacity-90">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </header>

      <div className="mt-6 flex flex-wrap gap-3">
        <Select label="Intent" value={intent} onChange={setIntent} options={["", ...intents]} />
        <Select label="Sentiment" value={sentiment} onChange={setSentiment} options={["", "positive", "neutral", "frustrated", "angry"]} />
        <Select label="Follow-up" value={followUp} onChange={setFollowUp} options={["", "yes", "no"]} />
      </div>

      <div className="mt-4 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Intent</th>
              <th className="text-left px-5 py-3 font-medium">Summary</th>
              <th className="text-left px-5 py-3 font-medium">Sentiment</th>
              <th className="text-left px-5 py-3 font-medium">Contact</th>
              <th className="text-left px-5 py-3 font-medium">Follow up</th>
              <th className="text-left px-5 py-3 font-medium">Transcript</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">No leads match your filters.</td></tr>
            ) : rows.map((l) => (
              <tr key={l.id} className="hover:bg-muted/30 transition">
                <td className="px-5 py-3 font-medium">{l.name ?? <span className="text-muted-foreground">Unknown</span>}</td>
                <td className="px-5 py-3">{l.intent}</td>
                <td className="px-5 py-3 text-muted-foreground max-w-xs truncate">{l.summary}</td>
                <td className="px-5 py-3"><SentimentBadge s={l.sentiment} /></td>
                <td className="px-5 py-3 text-muted-foreground">{l.caller_number ?? l.contact_info}</td>
                <td className="px-5 py-3">{l.follow_up_needed ? <span className="text-warning">Yes</span> : <span className="text-muted-foreground">No</span>}</td>
                <td className="px-5 py-3">
                  {l.transcript ? (
                    <button
                      onClick={() => setTranscript({ name: l.name || l.caller_number || "Lead", text: l.transcript! })}
                      className="inline-flex items-center gap-1.5 text-primary hover:underline"
                    >
                      <FileText className="w-4 h-4" /> View
                    </button>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted">Prev</button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted">Next</button>
        </div>
      </div>

      {transcript && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setTranscript(null)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-card w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="font-semibold">Transcript — {transcript.name}</h3>
              <button onClick={() => setTranscript(null)} className="text-muted-foreground hover:text-foreground p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-5 py-4 overflow-auto grid gap-2">
              {formatTranscript(transcript.text).map((line, i) => {
                const isAgent = line.startsWith("[Agent]");
                return (
                  <div key={i} className={`text-sm ${isAgent ? "text-foreground" : "text-muted-foreground"}`}>
                    <span className="font-medium">{isAgent ? "Agent" : "Caller"}:</span>{" "}
                    {line.replace(/^\[(Agent|Caller)\]\s*/, "")}
                  </div>
                );
              })}
              {formatTranscript(transcript.text).length === 0 && (
                <p className="text-sm text-muted-foreground">No transcript text.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-input border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
        {options.map((o) => <option key={o} value={o}>{o || "All"}</option>)}
      </select>
    </label>
  );
}
