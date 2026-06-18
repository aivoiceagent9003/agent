import { createFileRoute, Link } from "@tanstack/react-router";
import { useClientCall } from "@/lib/data";
import { ArrowLeft, PhoneCall } from "lucide-react";

export const Route = createFileRoute("/app/calls/$id")({
  component: CallDetail,
});

function CallDetail() {
  const { id } = Route.useParams();
  const { data, isLoading } = useClientCall(id);
  const call = data?.call;
  const lead = data?.lead ?? null;

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!call) {
    return (
      <div className="p-8">
        <p>Call not found.</p>
        <Link to="/app/calls" className="text-primary hover:underline">← Back</Link>
      </div>
    );
  }

  const lines = call.transcript
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const isAgent = l.startsWith("[Agent]");
      return { who: isAgent ? "agent" : "caller", text: l.replace(/^\[(Agent|Caller)\]\s*/, "") };
    });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link to="/app/calls" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to calls
      </Link>

      <div className="bg-card border border-border rounded-xl p-6 shadow-card">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow">
            <PhoneCall className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">{call.caller_number}</h1>
            <p className="text-sm text-muted-foreground">{new Date(call.created_at).toLocaleString()}</p>
          </div>
          <div className="text-right text-sm">
            <div className="text-muted-foreground">Duration</div>
            <div className="font-medium">{Math.floor(call.duration_seconds / 60)}m {call.duration_seconds % 60}s</div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-6 shadow-card">
          <h2 className="font-semibold mb-4">Transcript</h2>
          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={i} className={`flex ${l.who === "agent" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                  l.who === "agent" ? "bg-gradient-primary text-primary-foreground rounded-br-sm" : "bg-muted rounded-bl-sm"
                }`}>
                  {l.text}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {lead ? (
            <div className="bg-card border border-border rounded-xl p-6 shadow-card">
              <h2 className="font-semibold mb-3">Lead captured</h2>
              <dl className="space-y-2 text-sm">
                <Info label="Name" value={lead.name ?? "—"} />
                <Info label="Intent" value={lead.intent} />
                <Info label="Sentiment" value={<SentimentBadge s={lead.sentiment} />} />
                <Info label="Language" value={lead.language} />
                <Info label="Contact" value={lead.contact_info ?? "—"} />
                <Info label="Follow up" value={lead.follow_up_needed ? "Yes" : "No"} />
              </dl>
              <div className="mt-4">
                <div className="text-xs text-muted-foreground uppercase mb-1">Summary</div>
                <p className="text-sm">{lead.summary}</p>
              </div>
              <div className="mt-4">
                <div className="text-xs text-muted-foreground uppercase mb-1">Key details</div>
                <ul className="text-sm space-y-1 list-disc list-inside">
                  {lead.key_details.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl p-6 shadow-card text-sm text-muted-foreground">
              No lead extracted from this call.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-right">{value}</dd>
    </div>
  );
}

export function SentimentBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    positive: "bg-success/15 text-success",
    neutral: "bg-muted text-muted-foreground",
    frustrated: "bg-warning/15 text-warning",
    angry: "bg-destructive/15 text-destructive",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${map[s] ?? "bg-muted"}`}>{s}</span>;
}
