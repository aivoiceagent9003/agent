import { useState } from "react";
import { X, Plus } from "lucide-react";

export interface ClientFormData {
  name: string;
  phone_number: string;
  business_name: string;
  agent_name: string;
  purpose: string;
  handoff_number: string;
  enable_handoff: boolean;
  enable_kb: boolean;
  recording_enabled: boolean;
  recording_notice: string;
  filler_phrases: string[];
  max_sentences: number;
}

const defaults: ClientFormData = {
  name: "",
  phone_number: "",
  business_name: "",
  agent_name: "",
  purpose: "",
  handoff_number: "",
  enable_handoff: true,
  enable_kb: true,
  recording_enabled: false,
  recording_notice: "",
  filler_phrases: [],
  max_sentences: 2,
};

export function ClientForm({
  initial,
  onSubmit,
}: {
  initial?: Partial<ClientFormData>;
  onSubmit: (data: ClientFormData) => Promise<void> | void;
}) {
  const [data, setData] = useState<ClientFormData>({ ...defaults, ...initial });
  const [newFiller, setNewFiller] = useState("");
  const [saving, setSaving] = useState(false);

  function update<K extends keyof ClientFormData>(k: K, v: ClientFormData[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit(data);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-card border border-border rounded-xl p-6 shadow-card grid gap-5"
    >
      <div className="grid md:grid-cols-2 gap-4">
        <Text label="Client name" value={data.name} onChange={(v) => update("name", v)} required />
        <Text
          label="Receiving phone number"
          value={data.phone_number}
          onChange={(v) => update("phone_number", v)}
          required
        />
        <Text
          label="Business name"
          value={data.business_name}
          onChange={(v) => update("business_name", v)}
          required
        />
        <Text
          label="Agent name"
          value={data.agent_name}
          onChange={(v) => update("agent_name", v)}
          required
        />
        <Text
          label="Handoff number"
          value={data.handoff_number}
          onChange={(v) => update("handoff_number", v)}
        />
        <Num
          label="Max sentences"
          value={data.max_sentences}
          onChange={(v) => update("max_sentences", v)}
        />
      </div>

      <div className="grid gap-1.5">
        <label className="text-sm text-muted-foreground">Purpose</label>
        <textarea
          rows={3}
          value={data.purpose}
          onChange={(e) => update("purpose", e.target.value)}
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          required
        />
      </div>

      <div className="grid gap-2">
        <label className="text-sm text-muted-foreground">Filler phrases</label>
        <div className="flex flex-wrap gap-2">
          {data.filler_phrases.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 bg-muted rounded-lg px-3 py-1 text-sm"
            >
              {p}
              <button
                type="button"
                onClick={() =>
                  update(
                    "filler_phrases",
                    data.filler_phrases.filter((_, j) => j !== i),
                  )
                }
              >
                <X className="w-3 h-3 text-muted-foreground hover:text-destructive" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newFiller}
            onChange={(e) => setNewFiller(e.target.value)}
            placeholder="e.g. Let me check that"
            className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => {
              if (newFiller.trim()) {
                update("filler_phrases", [...data.filler_phrases, newFiller.trim()]);
                setNewFiller("");
              }
            }}
            className="inline-flex items-center gap-1 border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Toggle
          label="Enable handoff"
          checked={data.enable_handoff}
          onChange={(v) => update("enable_handoff", v)}
        />
        <Toggle
          label="Enable knowledge base"
          checked={data.enable_kb}
          onChange={(v) => update("enable_kb", v)}
        />
        <Toggle
          label="Record calls"
          checked={data.recording_enabled}
          onChange={(v) => update("recording_enabled", v)}
        />
      </div>

      {/* Only shown when recording is on, because the disclosure is the whole
          reason recording is allowed — it should appear as part of that decision,
          not buried in a settings page somewhere else. */}
      {data.recording_enabled && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <p className="text-sm">
            Callers are told at the start of every call that it is being recorded. This is
            required before you may record someone, and the notice is spoken in the
            caller&apos;s own language.
          </p>
          <div>
            <label className="block text-sm font-medium mb-1.5">
              What the agent says{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              value={data.recording_notice}
              onChange={(e) => update("recording_notice", e.target.value)}
              placeholder="This call is recorded for quality and training purposes."
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Leave blank to use the default wording above.
            </p>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          disabled={saving}
          className="bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2 text-sm font-medium shadow-glow disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function Text({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value || "0", 10))}
        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 bg-input border border-border rounded-lg px-3 py-2.5 cursor-pointer">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition ${checked ? "bg-gradient-primary" : "bg-muted"}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow transition ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </label>
  );
}
