// VoicePicker — choosing the voice the agent speaks in.
//
// It used to render a flat grid reading `v.label` and `v.note`, while the API sent
// `name` and `description`. Every card showed a blank line where the name should be and
// nothing where the description should be. Nothing threw; the grid just looked empty.
// The API now sends the names this file reads — see telnyx-voices.js.
//
// Grouped by accent rather than listed flat, because the accent is the FIRST thing that
// matters here and the only thing you cannot hear from a name. A Hyderabad line wants a
// Telugu or Indian-English voice, and picking "Sneha" out of a flat list tells you
// nothing about which of those you just chose.

import { Check } from "lucide-react";
import { type Voice } from "@/lib/data";

// Most useful first for these callers, rather than alphabetical. Anything not listed
// keeps its place after these, so a language Telnyx adds later still appears.
const ACCENT_ORDER = [
  "Indian English",
  "Hindi",
  "Telugu",
  "Tamil",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Punjabi",
  "Bengali",
  "Gujarati",
  "Urdu",
];

function groupsOf(voices: Voice[]) {
  const by = new Map<string, Voice[]>();
  for (const v of voices) {
    // A cloned voice has no accent to read off a description — somebody on this account
    // recorded it, so it goes first under its own heading rather than into "Other".
    const key = v.kind === "cloned" ? "Your cloned voices" : v.accent || "Other";
    if (!by.has(key)) by.set(key, []);
    by.get(key)!.push(v);
  }
  const rank = (k: string) =>
    k === "Your cloned voices" ? -1 : ACCENT_ORDER.indexOf(k) === -1 ? 99 : ACCENT_ORDER.indexOf(k);
  return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export function VoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: Voice[];
  value: string;
  onChange: (id: string) => void;
}) {
  const groups = groupsOf(voices);

  return (
    <div className="space-y-5">
      {groups.map(([accent, list]) => (
        <div key={accent}>
          <div className="flex items-baseline gap-2 mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {accent}
            </h4>
            <span className="text-xs text-muted-foreground">{list.length}</span>
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            {list.map((v) => {
              const active = value === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onChange(v.id)}
                  className={`text-left rounded-lg border px-3 py-2.5 transition ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{v.label}</span>
                    {active && <Check className="w-4 h-4 text-primary shrink-0" />}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    {v.accent && (
                      <span className="rounded-full bg-accent text-accent-foreground px-2 py-0.5 text-[11px] font-medium">
                        {v.accent}
                      </span>
                    )}
                    {v.gender && v.gender !== "neutral" && (
                      <span className="text-[11px] capitalize text-muted-foreground">
                        {v.gender}
                      </span>
                    )}
                  </div>
                  {/* Telnyx writes these, and they run long. Two lines is enough to tell
                      two voices of the same accent apart, which is all it is for. */}
                  {v.note && (
                    <span className="mt-1.5 block text-xs text-muted-foreground line-clamp-2">
                      {v.note}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
