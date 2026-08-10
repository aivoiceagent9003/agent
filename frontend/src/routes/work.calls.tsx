// /work/calls — the call log an employee can see.
//
// Read-only. Agents hold 'calls:read' and nothing more on this data: they need the
// context behind a lead ("what did the caller actually say?"), not the ability to
// change anything about the call record.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useClientCalls, parseTranscript } from "@/lib/data";
import { PhoneCall, Clock, ChevronDown } from "lucide-react";

export const Route = createFileRoute("/work/calls")({
  head: () => ({ meta: [{ title: "Calls — Vocera" }] }),
  component: WorkCalls,
});

function WorkCalls() {
  const { data, isLoading } = useClientCalls(1, 25);
  const calls = data?.calls ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold">Calls</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every call your agent handled, newest first.
        </p>
      </header>

      {isLoading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading calls…</p>
      ) : calls.length === 0 ? (
        <p className="mt-16 text-center text-sm text-muted-foreground">
          No calls yet. They'll appear here as soon as your agent answers one.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {calls.map((c: any) => {
            const open = openId === c.id;
            return (
              <article key={c.id} className="border border-border rounded-xl bg-card overflow-hidden">
                <button
                  onClick={() => setOpenId(open ? null : c.id)}
                  className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-muted/40 transition"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/10 grid place-items-center shrink-0">
                    <PhoneCall className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.caller_number || "Unknown number"}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(c.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDuration(c.duration_seconds)}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground shrink-0 transition ${open ? "rotate-180" : ""}`}
                  />
                </button>

                {open && (
                  <div className="px-5 pb-5 border-t border-border pt-4">
                    <Transcript raw={c.transcript} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Transcript({ raw }: { raw?: string | null }) {
  const turns = parseTranscript(raw);
  if (!turns.length) {
    return <p className="text-sm text-muted-foreground">No transcript for this call.</p>;
  }
  return (
    <div className="space-y-2 max-h-80 overflow-y-auto">
      {turns.map((t, i) => (
        <div key={i} className="text-sm">
          <span
            className={`font-medium ${t.who === "agent" ? "text-primary" : "text-muted-foreground"}`}
          >
            {t.who === "agent" ? "Agent" : "Caller"}:
          </span>{" "}
          <span>{t.native}</span>
          {/* Callers often speak Hindi/Telugu; the stored English gloss is what
              makes the transcript usable for staff who don't share the language. */}
          {t.en && t.en !== t.native && (
            <span className="text-muted-foreground italic"> — {t.en}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function formatDuration(seconds?: number) {
  const s = Number(seconds || 0);
  if (!s) return "—";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
