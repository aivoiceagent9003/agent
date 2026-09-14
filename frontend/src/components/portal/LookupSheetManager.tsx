// LookupSheetManager — the data sheets the agent looks callers up in.
//
// Same shape as KnowledgeManager, deliberately: a dropzone and a list of what has
// been uploaded. A sheet is the unit a client thinks in — they export it from
// their own system and upload the whole thing — so that is the unit shown here,
// with the same two lines a knowledge file gets: what it is called, and how much
// is in it. Updating means uploading a newer version, exactly as it does there.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, Sheet, Trash2, RefreshCw, AlertTriangle } from "lucide-react";
import {
  useLookups,
  useSaveLookups,
  uploadLookupSheet,
  deleteLookupDataset,
  type LookupConfig,
} from "@/lib/data";

// "Loan Book Sept.csv" → "Loan Book Sept". The lookup config references a sheet by
// this exact name, which is why replacing an existing sheet keeps its name rather
// than taking one from whatever the file happened to be called that month.
const nameFromFile = (file: File) => file.name.replace(/\.[^.]+$/, "").trim();

// A lookup backed by an uploaded sheet, narrowed so the dataset name is reachable
// without casts. The http-backed kind has no sheet and never appears here.
type TableLookup = LookupConfig & { backend: { type: "table"; dataset: string } };
const isTable = (lk: LookupConfig): lk is TableLookup => lk.backend?.type === "table";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : null;

export function LookupSheetManager() {
  const qc = useQueryClient();
  const { data } = useLookups();
  const sheets = data?.datasets || [];
  const lookups = data?.lookups || [];
  const [busy, setBusy] = useState<string | null>(null);
  const newRef = useRef<HTMLInputElement>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["client", "lookups"] });

  // Lookups pointing at a sheet that does not exist. This is total, silent
  // failure — every call misses — and it looks exactly like "that customer isn't
  // in your data", so it can run for weeks unnoticed. It happens because the
  // sheet is named after the file uploaded while the lookup keeps whatever name
  // was typed during setup, and nothing has ever reconciled the two.
  const broken = lookups
    .filter(isTable)
    .filter((lk) => !sheets.some((s) => s.dataset === lk.backend.dataset));

  // `target` is set when replacing a named sheet, null when adding a new one.
  async function upload(file: File | undefined, target: string | null, inputEl?: HTMLInputElement | null) {
    if (!file) return;
    const dataset = target ?? nameFromFile(file);
    if (!dataset) {
      toast.error("Give the file a name before uploading it.");
      return;
    }

    const existing = sheets.find((s) => s.dataset === dataset);
    if (
      existing &&
      !confirm(
        `Replace "${dataset}"?\n\nIts ${existing.rows} current ${existing.rows === 1 ? "row" : "rows"} ` +
          `will be deleted and replaced by this file.`,
      )
    ) {
      if (inputEl) inputEl.value = "";
      return;
    }

    setBusy(dataset);
    try {
      const res = await uploadLookupSheet(dataset, file);
      refresh();
      toast.success(`${dataset}: ${res.rows_added} rows`);
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setBusy(null);
      if (inputEl) inputEl.value = "";
    }
  }

  async function remove(dataset: string, rows: number) {
    if (
      !confirm(
        `Delete "${dataset}" and all ${rows} ${rows === 1 ? "row" : "rows"}?\n\n` +
          `The agent will stop being able to look callers up in it.`,
      )
    )
      return;
    try {
      await deleteLookupDataset(dataset);
      refresh();
      toast.success("Sheet deleted");
    } catch (e: any) {
      toast.error(e.message || "Could not delete the sheet");
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-card grid gap-4">
      {broken.map((lk) => (
        <BrokenLookupNotice
          key={lk.name}
          lookup={lk}
          sheets={sheets.map((s) => s.dataset)}
          busy={busy === lk.backend.dataset}
          onUpload={(file, el) => upload(file, lk.backend.dataset, el)}
          onRepointed={refresh}
        />
      ))}

      <label
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-10 cursor-pointer hover:bg-muted/30 transition ${
          busy ? "opacity-60 pointer-events-none" : ""
        }`}
      >
        <Upload className="w-6 h-6 text-muted-foreground" />
        <span className="text-sm font-medium">
          {busy ? "Uploading…" : "Click to upload a data sheet"}
        </span>
        <span className="text-xs text-muted-foreground text-center px-4">
          CSV or Excel · first row = column names
        </span>
        <input
          ref={newRef}
          type="file"
          accept=".csv,text/csv,.xlsx,.xls"
          onChange={(e) => upload(e.target.files?.[0], null, newRef.current)}
          className="hidden"
        />
      </label>

      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
          {sheets.length} {sheets.length === 1 ? "sheet" : "sheets"}
        </div>
        <div className="divide-y divide-border max-h-96 overflow-auto">
          {sheets.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No data sheets yet.</div>
          ) : (
            sheets.map((s) => (
              <SheetRow
                key={s.dataset}
                sheet={s}
                busy={busy === s.dataset}
                onReplace={(file, el) => upload(file, s.dataset, el)}
                onDelete={() => remove(s.dataset, s.rows)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// A lookup whose sheet is missing. Says plainly what is broken and offers the two
// repairs: upload the data under the name the lookup expects, or point the lookup
// at a sheet that is already here. Without this the only symptom is the agent
// telling every caller they have no record.
function BrokenLookupNotice({
  lookup,
  sheets,
  busy,
  onUpload,
  onRepointed,
}: {
  lookup: TableLookup;
  sheets: string[];
  busy: boolean;
  onUpload: (file: File | undefined, el: HTMLInputElement | null) => void;
  onRepointed: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const save = useSaveLookups();
  const { data } = useLookups();
  const wanted = lookup.backend.dataset || "(unnamed)";
  const [target, setTarget] = useState(sheets[0] || "");

  async function repoint() {
    const all = data?.lookups || [];
    try {
      await save.mutateAsync({
        lookups: all.map((lk) =>
          lk.name === lookup.name ? { ...lk, backend: { type: "table", dataset: target } } : lk,
        ),
      });
      onRepointed();
      toast.success(`"${lookup.name}" now uses ${target}`);
    } catch (e: any) {
      toast.error(e.message || "Could not update the lookup");
    }
  }

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 grid gap-3">
      <div className="flex gap-3">
        <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium">“{lookup.name}” has no data</p>
          <p className="text-sm text-muted-foreground mt-1">
            It searches a sheet called <span className="font-mono text-xs">{wanted}</span>, and no
            such sheet has been uploaded. Until this is fixed the agent tells every caller their
            record cannot be found.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-7">
        <label
          className={`inline-flex items-center gap-2 text-sm border border-border bg-card rounded-lg px-3 py-2 cursor-pointer hover:bg-muted ${
            busy ? "opacity-60 pointer-events-none" : ""
          }`}
        >
          <Upload className="w-4 h-4" />
          {busy ? "Uploading…" : `Upload data for “${lookup.name}”`}
          <input
            ref={ref}
            type="file"
            accept=".csv,text/csv,.xlsx,.xls"
            onChange={(e) => onUpload(e.target.files?.[0], ref.current)}
            className="hidden"
          />
        </label>

        {sheets.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground">or use a sheet already here:</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="bg-input border border-border rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring max-w-[240px]"
            >
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              onClick={repoint}
              disabled={save.isPending || !target}
              className="text-sm bg-gradient-primary text-primary-foreground rounded-lg px-3 py-2 font-medium shadow-glow disabled:opacity-60"
            >
              {save.isPending ? "Saving…" : "Use this sheet"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SheetRow({
  sheet,
  busy,
  onReplace,
  onDelete,
}: {
  sheet: { dataset: string; rows: number; updated_at?: string | null };
  busy: boolean;
  onReplace: (file: File | undefined, el: HTMLInputElement | null) => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const updated = when(sheet.updated_at ?? null);

  return (
    <div className="flex items-center gap-3 py-3">
      <Sheet className="w-4 h-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{sheet.dataset}</p>
        <p className="text-xs text-muted-foreground truncate">
          {busy
            ? "Uploading…"
            : `${sheet.rows.toLocaleString()} ${sheet.rows === 1 ? "row" : "rows"}${
                updated ? ` · updated ${updated}` : ""
              }`}
        </p>
      </div>
      <label
        title="Upload a new version of this sheet"
        className={`text-muted-foreground hover:text-foreground p-1 shrink-0 cursor-pointer ${
          busy ? "opacity-60 pointer-events-none" : ""
        }`}
      >
        <RefreshCw className="w-4 h-4" />
        <input
          ref={ref}
          type="file"
          accept=".csv,text/csv,.xlsx,.xls"
          onChange={(e) => onReplace(e.target.files?.[0], ref.current)}
          className="hidden"
        />
      </label>
      <button
        onClick={onDelete}
        title="Delete this sheet"
        className="text-muted-foreground hover:text-destructive p-1 shrink-0"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
