import { useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Upload, Globe, Sheet, Database } from "lucide-react";
import {
  useLookups,
  useSaveLookups,
  uploadLookupSheet,
  deleteLookupDataset,
  type LookupConfig,
  type LookupParam,
} from "@/lib/data";

// Live data lookups setup — lets a client tell us how the agent should fetch
// per-caller data (orders, dues, bookings). Two paths, per the onboarding
// question: "Do you have an API, or will you upload a data sheet?"
//
// Controlled: parent owns the lookups array (so it can save them with the rest
// of the agent config). Datasets, being tenant-scoped storage, are uploaded to
// the backend immediately from here.

const BLANK: LookupConfig = {
  name: "",
  description: "",
  parameters: [{ name: "order_id", description: "" }],
  backend: { type: "table", dataset: "" },
};

function paramsToText(params: LookupParam[] = []) {
  return params.map((p) => p.name).join(", ");
}
function textToParams(text: string): LookupParam[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name: name.replace(/\s+/g, "_").toLowerCase(), description: "" }));
}

export function LiveDataSetup({
  lookups,
  onChange,
}: {
  lookups: LookupConfig[];
  onChange: (l: LookupConfig[]) => void;
}) {
  const { data } = useLookups();
  const datasets = data?.datasets || [];
  const saveLookups = useSaveLookups();

  function update(i: number, patch: Partial<LookupConfig>) {
    onChange(lookups.map((lk, idx) => (idx === i ? { ...lk, ...patch } : lk)));
  }
  function remove(i: number) {
    onChange(lookups.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...lookups, structuredClone(BLANK)]);
  }

  // Persist immediately (used by the dashboard; in onboarding the parent also
  // saves these as part of the agent config, but saving here is harmless).
  async function persist() {
    try {
      await saveLookups.mutateAsync({ lookups });
      toast.success("Lookups saved");
    } catch (e: any) {
      toast.error(e.message || "Could not save lookups");
    }
  }

  return (
    <div className="grid gap-4">
      {lookups.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No live lookups yet. Add one if your agent needs to pull caller-specific details like
          order status, dues, or bookings.
        </div>
      )}

      {lookups.map((lk, i) => (
        <LookupCard
          key={i}
          lookup={lk}
          datasets={datasets.map((d) => d.dataset)}
          onUpdate={(patch) => update(i, patch)}
          onRemove={() => remove(i)}
        />
      ))}

      <div className="flex items-center justify-between">
        <button
          onClick={add}
          className="inline-flex items-center gap-2 text-sm border border-border rounded-lg px-3 py-2 hover:bg-muted"
        >
          <Plus className="w-4 h-4" /> Add a lookup
        </button>
        {lookups.length > 0 && (
          <button
            onClick={persist}
            disabled={saveLookups.isPending}
            className="text-sm bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 font-medium shadow-glow disabled:opacity-60"
          >
            {saveLookups.isPending ? "Saving…" : "Save lookups"}
          </button>
        )}
      </div>
    </div>
  );
}

function LookupCard({
  lookup,
  datasets,
  onUpdate,
  onRemove,
}: {
  lookup: LookupConfig;
  datasets: string[];
  onUpdate: (patch: Partial<LookupConfig>) => void;
  onRemove: () => void;
}) {
  const isHttp = lookup.backend.type === "http";
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadInfo, setUploadInfo] = useState<string | null>(null);

  const dataset = lookup.backend.type === "table" ? lookup.backend.dataset : "";

  function setBackendType(type: "http" | "table") {
    if (type === "http") {
      onUpdate({ backend: { type: "http", url: "", method: "GET", headers: {} } });
    } else {
      onUpdate({ backend: { type: "table", dataset: lookup.name || "" } });
    }
  }

  async function onUploadSheet(file: File | undefined) {
    if (!file) return;
    const ds = dataset || lookup.name || file.name.replace(/\.[^.]+$/, "");
    setUploading(true);
    try {
      const res = await uploadLookupSheet(ds, file);
      onUpdate({ backend: { type: "table", dataset: res.dataset } });
      setUploadInfo(`${res.rows_added} rows · columns: ${res.columns.join(", ")}`);
      toast.success(`${res.rows_added} rows uploaded`);
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-card grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 grid gap-1.5">
          <label className="text-xs text-muted-foreground">What does this lookup do?</label>
          <input
            value={lookup.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="e.g. Order status"
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive p-1 mt-6"
          title="Remove"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">
          Describe it for the agent (when should it use this?)
        </label>
        <input
          value={lookup.description || ""}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Look up an order by its ID or the caller's phone number"
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">
          What will the caller give to find the record? (comma-separated)
        </label>
        <input
          value={paramsToText(lookup.parameters)}
          onChange={(e) => onUpdate({ parameters: textToParams(e.target.value) })}
          placeholder="order_id, phone"
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Backend choice — the core "API or data sheet" question */}
      <div className="grid gap-2">
        <label className="text-xs text-muted-foreground">Where does this data live?</label>
        <div className="grid sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setBackendType("http")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-left transition ${
              isHttp
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border hover:bg-muted/30"
            }`}
          >
            <Globe className="w-4 h-4 shrink-0" />
            <span>I have an API to call</span>
          </button>
          <button
            type="button"
            onClick={() => setBackendType("table")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-left transition ${
              !isHttp
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border hover:bg-muted/30"
            }`}
          >
            <Sheet className="w-4 h-4 shrink-0" />
            <span>I'll upload a data sheet</span>
          </button>
        </div>
      </div>

      {isHttp ? (
        <div className="grid gap-3 rounded-lg bg-muted/20 p-3">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">
              API endpoint — use {"{param}"} for values you collect
            </label>
            <input
              value={(lookup.backend as any).url || ""}
              onChange={(e) =>
                onUpdate({
                  backend: { ...(lookup.backend as any), type: "http", url: e.target.value },
                })
              }
              placeholder="https://yourstore.com/api/orders/{order_id}"
              className="bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="grid grid-cols-[110px_1fr] gap-3">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">Method</label>
              <select
                value={(lookup.backend as any).method || "GET"}
                onChange={(e) =>
                  onUpdate({
                    backend: { ...(lookup.backend as any), type: "http", method: e.target.value },
                  })
                }
                className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option>GET</option>
                <option>POST</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">
                Authorization header (optional)
              </label>
              <input
                value={(lookup.backend as any).headers?.Authorization || ""}
                onChange={(e) =>
                  onUpdate({
                    backend: {
                      ...(lookup.backend as any),
                      type: "http",
                      headers: e.target.value ? { Authorization: e.target.value } : {},
                    },
                  })
                }
                placeholder="Bearer sk_live_…"
                className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 rounded-lg bg-muted/20 p-3">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">Dataset name</label>
            <input
              value={dataset}
              onChange={(e) => onUpdate({ backend: { type: "table", dataset: e.target.value } })}
              placeholder="orders"
              className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <label
            className={`flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-5 cursor-pointer hover:bg-muted/30 transition ${
              uploading ? "opacity-60 pointer-events-none" : ""
            }`}
          >
            <Upload className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">
              {uploading ? "Uploading…" : "Upload CSV (first row = column names)"}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onUploadSheet(e.target.files?.[0])}
              className="hidden"
            />
          </label>
          {uploadInfo && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Database className="w-3.5 h-3.5" /> {uploadInfo}
            </div>
          )}
          {!uploadInfo && datasets.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Existing datasets: {datasets.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
