import { useEffect, useState } from "react";
import { getSignature, setSignature, subscribeSignature, type Variant } from "./signature";

const OPTS: { id: Variant; label: string }[] = [
  { id: "bloom", label: "Bloom" },
  { id: "orb", label: "Orb" },
  { id: "spectrum", label: "Spectrum" },
  { id: "ribbon", label: "Waveform" },
];

// A small floating control to compare the three voice signatures live.
export function SignatureSwitcher() {
  const [v, setV] = useState<Variant>("bloom");
  useEffect(() => {
    setV(getSignature());
    return subscribeSignature(() => setV(getSignature()));
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-card/85 backdrop-blur px-1 py-1 shadow-card">
      <span className="px-2 text-[11px] text-muted-foreground hidden sm:inline">Signature</span>
      {OPTS.map((o) => (
        <button
          key={o.id}
          onClick={() => setSignature(o.id)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
            v === o.id ? "bg-gradient-primary text-primary-foreground shadow-glow" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
