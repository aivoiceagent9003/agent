// What the caller and the agent actually said, rendered from a stored transcript.
//
// Shared by /work/calls and /work/leads/:id so the two screens can never drift into
// showing the same conversation two different ways.
//
// This is a verbatim record, not a summary: the caller's own words in the language
// they spoke them. It became worth showing when the stack moved to Soniox STT —
// before that, transcription of code-mixed Indian phone audio was unreliable enough
// that the recording was the only honest record of a call.

import { parseTranscript } from "@/lib/data";

export function CallTranscript({
  raw,
  emptyLabel = "No transcript for this call.",
  className = "max-h-80",
}: {
  raw?: string | null;
  emptyLabel?: string;
  className?: string;
}) {
  const turns = parseTranscript(raw);
  if (!turns.length) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className={`space-y-2 overflow-y-auto ${className}`}>
      {turns.map((t, i) => (
        <div key={i} className="text-sm">
          <span
            className={`font-medium ${t.who === "agent" ? "text-primary" : "text-muted-foreground"}`}
          >
            {t.who === "agent" ? "Agent" : "Caller"}:
          </span>{" "}
          <span>{t.native}</span>
          {/* An English gloss, only on transcripts stored with one. Nothing writes it
              today — the live transcript is kept in the language it was spoken, and a
              translation pass would be a separate post-call step. Old calls that have
              it still render it rather than silently dropping half the record. */}
          {t.en && t.en !== t.native && (
            <span className="text-muted-foreground italic"> — {t.en}</span>
          )}
        </div>
      ))}
    </div>
  );
}
