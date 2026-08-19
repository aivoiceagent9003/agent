// VoicePicker — the voice-selection grid. All voices speak Indic languages
// natively; they differ in tone (shown in the note).

import { Check } from "lucide-react";
import { type Voice } from "@/lib/data";

export function VoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: Voice[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid sm:grid-cols-3 gap-2">
      {voices.map((v) => {
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
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{v.label}</span>
              {active && <Check className="w-4 h-4 text-primary" />}
            </div>
            {v.gender && v.gender !== "neutral" && (
              <span className="block mt-0.5 text-xs font-medium capitalize text-muted-foreground">
                {v.gender}
              </span>
            )}
            <span className="block mt-0.5 text-xs text-muted-foreground">{v.note}</span>
          </button>
        );
      })}
    </div>
  );
}
