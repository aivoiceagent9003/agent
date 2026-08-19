import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Play,
  Pause,
  Square,
  Users,
  Upload,
  Phone,
  DollarSign,
  Sparkles,
  FileText,
  Sheet,
  Database,
  Webhook,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  Plus,
  Clock,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import {
  useCampaign,
  useCampaignContacts,
  useCampaignAnalytics,
  useCampaignLogs,
  useCampaignAction,
  useScheduleStart,
  usePasteContacts,
  importContactsCsv,
  STATUS_COLOR,
  useSources,
  useCreateSource,
  useSyncSource,
  useDeleteSource,
  useTriggerInfo,
  useSetPreset,
  type ContactSource,
  type CampaignContact,
} from "@/lib/campaigns";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/app/campaigns/$id")({ component: CampaignDetail });

const TABS = ["overview", "contacts", "sources", "analytics", "activity"] as const;

function CampaignDetail() {
  const { id } = useParams({ from: "/app/campaigns/$id" });
  const [tab, setTab] = useState<(typeof TABS)[number]>("overview");
  const { data: c } = useCampaign(id);
  const action = useCampaignAction(id);
  const schedule = useScheduleStart(id);
  const [scheduling, setScheduling] = useState(false);
  const [startAt, setStartAt] = useState("");
  if (!c) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  const scheduledFor =
    c.status === "scheduled" && c.schedule?.start_at ? new Date(c.schedule.start_at) : null;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link
        to="/app/campaigns"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Campaigns
      </Link>
      <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            {c.name}
            <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLOR[c.status]}`}>
              {c.status}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1 capitalize">
            {c.type.replace("_", " ")} · outbound
          </p>
        </div>
        <div className="flex gap-2">
          {c.status === "running" ? (
            <ActionBtn
              onClick={() => action.mutate("pause")}
              icon={Pause}
              label="Pause"
              cls="border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
            />
          ) : c.status === "scheduled" ? (
            <ActionBtn
              onClick={() => action.mutate("unschedule")}
              icon={X}
              label="Cancel schedule"
              cls="border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
            />
          ) : (
            <>
              <ActionBtn
                onClick={() => action.mutate(c.status === "paused" ? "resume" : "start")}
                icon={Play}
                label={c.status === "paused" ? "Resume" : "Start now"}
                cls="border-success/40 text-success hover:bg-success/10"
              />
              <ActionBtn
                onClick={() => setScheduling((v) => !v)}
                icon={Clock}
                label="Schedule"
                cls="border-blue-500/40 text-blue-500 hover:bg-blue-500/10"
              />
            </>
          )}
          <ActionBtn
            onClick={() => action.mutate("stop")}
            icon={Square}
            label="Stop"
            cls="border-destructive/40 text-destructive hover:bg-destructive/10"
          />
        </div>
      </div>

      {scheduledFor && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-500">
          <Clock className="w-4 h-4" /> Scheduled to start automatically on{" "}
          {scheduledFor.toLocaleString([], { dateStyle: "full", timeStyle: "short" })}.
        </div>
      )}

      {scheduling && !scheduledFor && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <div className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" /> Schedule automatic start
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            The campaign will start dialing on its own at this date & time — no one needs to press
            Start.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              className="px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
            <button
              onClick={async () => {
                await schedule.mutateAsync(new Date(startAt).toISOString());
                setScheduling(false);
                setStartAt("");
              }}
              disabled={!startAt || new Date(startAt).getTime() <= Date.now() || schedule.isPending}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              {schedule.isPending ? "Scheduling…" : "Schedule start"}
            </button>
            <button
              onClick={() => setScheduling(false)}
              className="px-4 py-2 rounded-lg border border-border text-sm"
            >
              Cancel
            </button>
          </div>
          {startAt && new Date(startAt).getTime() <= Date.now() && (
            <p className="text-xs text-destructive mt-2">Pick a time in the future.</p>
          )}
        </div>
      )}

      <div className="mt-6 flex gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "overview" && <Overview id={id} />}
        {tab === "contacts" && <Contacts id={id} />}
        {tab === "sources" && <Sources id={id} />}
        {tab === "analytics" && <Analytics id={id} />}
        {tab === "activity" && <Activity id={id} />}
      </div>
    </div>
  );
}

function Overview({ id }: { id: string }) {
  const { data: m } = useCampaignAnalytics(id);
  if (!m) return <div className="text-sm text-muted-foreground">No activity yet.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Tile icon={Phone} label="Calls" value={m.calls} />
      <Tile icon={Phone} label="Answered" value={m.answered} />
      <Tile icon={Sparkles} label="Qualified" value={m.qualified_leads} />
      <Tile icon={Users} label="Meetings" value={m.meetings_booked} />
      <Tile icon={Phone} label="No answer" value={m.no_answer} />
      <Tile icon={Phone} label="AI minutes" value={m.ai_minutes} />
      <Tile icon={DollarSign} label="Cost" value={`$${m.cost}`} />
      <Tile icon={DollarSign} label="Revenue" value={`$${m.revenue}`} />
    </div>
  );
}

function Contacts({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const { data } = useCampaignContacts(id, page);
  const paste = usePasteContacts(id);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const contacts = data?.contacts || [];
  const total = data?.total || 0;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      await importContactsCsv(id, f);
      qc.invalidateQueries({ queryKey: ["campaign", id, "contacts"] });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-start">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-muted text-sm"
        >
          <Upload className="w-4 h-4" /> {busy ? "Importing…" : "Import file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.tsv,.xlsx,.xls,.pdf,.docx"
          className="hidden"
          onChange={onFile}
        />
        <div className="flex-1 min-w-64">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste numbers, one per line (optionally: +9199…, Name)"
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm min-h-16"
          />
          <button
            onClick={async () => {
              await paste.mutateAsync(pasteText);
              setPasteText("");
            }}
            disabled={!pasteText.trim() || paste.isPending}
            className="mt-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
          >
            Add pasted
          </button>
        </div>
      </div>

      <div className="mt-4 text-sm text-muted-foreground">{total} contacts</div>
      <div className="mt-2 bg-card border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Phone</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Disposition</th>
              <th className="text-right px-4 py-2">Attempts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {contacts.map((c: CampaignContact) => (
              <tr key={c.id} className="hover:bg-muted/30">
                <td className="px-4 py-2">{c.name || "—"}</td>
                <td className="px-4 py-2 tabular-nums">{c.phone}</td>
                <td className="px-4 py-2">{c.status}</td>
                <td className="px-4 py-2 text-muted-foreground">{c.disposition || "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.attempts}</td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No contacts yet — import a CSV or paste a list.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {total > 50 && (
        <div className="mt-3 flex gap-2 justify-end text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 rounded border border-border disabled:opacity-50"
          >
            Prev
          </button>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page * 50 >= total}
            className="px-3 py-1 rounded border border-border disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function Analytics({ id }: { id: string }) {
  const { data: m } = useCampaignAnalytics(id);
  if (!m) return <div className="text-sm text-muted-foreground">No data yet.</div>;
  const answerRate = m.calls ? Math.round((m.answered / m.calls) * 100) : 0;
  const convRate = m.answered ? Math.round((m.qualified_leads / m.answered) * 100) : 0;
  const roi = m.cost ? Math.round(((m.revenue - m.cost) / m.cost) * 100) : 0;
  const langs = Object.entries(m.language_dist || {});
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="Pickup rate" value={`${answerRate}%`} />
        <Tile label="Conversion" value={`${convRate}%`} />
        <Tile label="Human transfers" value={m.human_transfers} />
        <Tile label="ROI" value={`${roi}%`} />
        <Tile label="Failed" value={m.failed} />
        <Tile label="AI minutes" value={m.ai_minutes} />
        <Tile label="Cost" value={`$${m.cost}`} />
        <Tile label="Revenue" value={`$${m.revenue}`} />
      </div>
      {langs.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm">Language distribution</h3>
          <div className="mt-3 space-y-2">
            {langs.map(([lang, n]) => (
              <div key={lang} className="flex items-center gap-2 text-sm">
                <span className="w-16 capitalize">{lang}</span>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.round((n / m.conversations || 0) * 100)}%` }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Activity({ id }: { id: string }) {
  const { data: logs = [] } = useCampaignLogs(id);
  return (
    <div className="bg-card border border-border rounded-xl divide-y divide-border max-h-[560px] overflow-auto">
      {logs.map((l: any) => (
        <div key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <span className="text-xs px-2 py-0.5 rounded-full border border-border">{l.event}</span>
          <span className="flex-1 text-muted-foreground truncate font-mono text-xs">
            {JSON.stringify(l.detail)}
          </span>
          <span className="text-xs text-muted-foreground">{new Date(l.ts).toLocaleString()}</span>
        </div>
      ))}
      {logs.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">No activity yet.</div>
      )}
    </div>
  );
}

// ─── Data sources tab ─────────────────────────────────────────────────────────
function Sources({ id }: { id: string }) {
  const { data: sources = [] } = useSources(id);
  const sync = useSyncSource(id);
  const del = useDeleteSource(id);
  const [adding, setAdding] = useState<null | "google_sheet" | "database" | "realtime">(null);

  const KIND: Record<string, { icon: any; label: string }> = {
    file: { icon: FileText, label: "File upload" },
    csv: { icon: FileText, label: "File upload" },
    paste: { icon: FileText, label: "Pasted list" },
    manual: { icon: FileText, label: "Manual" },
    google_sheet: { icon: Sheet, label: "Google Sheet" },
    database: { icon: Database, label: "Database" },
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Pull contacts from anywhere. Files import instantly; Google Sheets & databases sync (and can
        auto-refresh); CRMs, web forms and lead ads push new contacts in real time so we dial within
        seconds.
      </p>

      {/* Add-source cards */}
      <div className="grid sm:grid-cols-3 gap-3">
        <AddCard
          icon={Sheet}
          title="Google Sheet"
          desc="Paste a shared sheet link. New rows auto-dial."
          onClick={() => setAdding("google_sheet")}
        />
        <AddCard
          icon={Database}
          title="Database"
          desc="Connect your Postgres / MySQL and run a query."
          onClick={() => setAdding("database")}
        />
        <AddCard
          icon={Webhook}
          title="Real-time (CRM / forms)"
          desc="Get a URL your CRM or lead ads POST to."
          onClick={() => setAdding(adding === "realtime" ? null : "realtime")}
        />
      </div>

      {adding === "google_sheet" && <GoogleSheetForm id={id} onDone={() => setAdding(null)} />}
      {adding === "database" && <DatabaseForm id={id} onDone={() => setAdding(null)} />}
      {adding === "realtime" && <RealtimeIngress id={id} />}

      {/* Connected batch sources */}
      {sources.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2">Source</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-right px-4 py-2">Contacts</th>
                <th className="text-left px-4 py-2">Last sync</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sources.map((s: ContactSource) => {
                const K = KIND[s.kind] || KIND.file;
                const canSync = s.kind === "google_sheet" || s.kind === "database";
                return (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <K.icon className="w-4 h-4 text-primary" />{" "}
                        {s.name || s.filename || K.label}
                      </span>
                      {s.last_result?.error && (
                        <div className="text-xs text-destructive mt-0.5">{s.last_result.error}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${s.status === "error" ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground"}`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.row_count || 0}</td>
                    <td className="px-4 py-2 text-muted-foreground text-xs">
                      {s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {canSync && (
                        <button
                          onClick={() => sync.mutate(s.id)}
                          disabled={sync.isPending}
                          className="p-1.5 rounded hover:bg-muted"
                          title="Sync now"
                        >
                          <RefreshCw
                            className={`w-4 h-4 ${sync.isPending ? "animate-spin" : ""}`}
                          />
                        </button>
                      )}
                      <button
                        onClick={() => del.mutate(s.id)}
                        className="p-1.5 rounded hover:bg-muted text-destructive"
                        title="Remove"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: any;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-xl p-4 border border-border hover:border-primary/50 transition"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-5 h-5 text-primary" />
        <span className="font-medium">{title}</span>
        <Plus className="w-4 h-4 ml-auto text-muted-foreground" />
      </div>
      <div className="text-xs text-muted-foreground mt-2">{desc}</div>
    </button>
  );
}

function GoogleSheetForm({ id, onDone }: { id: string; onDone: () => void }) {
  const create = useCreateSource(id);
  const [url, setUrl] = useState("");
  const [poll, setPoll] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <Sheet className="w-4 h-4 text-primary" /> Connect a Google Sheet
      </h3>
      <input
        className={inp2}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://docs.google.com/spreadsheets/d/…"
      />
      <p className="text-xs text-muted-foreground">
        Share it as “Anyone with the link can view”. Needs a phone/mobile column; other columns
        become custom fields.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} />{" "}
        Auto-sync every 5 min (new rows dial automatically)
      </label>
      <div className="flex gap-2">
        <button
          onClick={async () => {
            await create.mutateAsync({
              kind: "google_sheet",
              config: { url, poll_seconds: poll ? 300 : 0 },
            });
            onDone();
          }}
          disabled={!url.trim() || create.isPending}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {create.isPending ? "Connecting…" : "Connect & sync"}
        </button>
        <button onClick={onDone} className="px-4 py-2 rounded-lg border border-border text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

function DatabaseForm({ id, onDone }: { id: string; onDone: () => void }) {
  const create = useCreateSource(id);
  const [f, setF] = useState({
    engine: "postgres",
    host: "",
    port: "",
    database: "",
    user: "",
    password: "",
    query: "",
    ssl: true,
    poll: false,
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" /> Connect a database
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <select className={inp2} value={f.engine} onChange={(e) => set("engine", e.target.value)}>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL / MariaDB</option>
        </select>
        <input
          className={inp2}
          value={f.host}
          onChange={(e) => set("host", e.target.value)}
          placeholder="host"
        />
        <input
          className={inp2}
          value={f.port}
          onChange={(e) => set("port", e.target.value)}
          placeholder="port (5432 / 3306)"
        />
        <input
          className={inp2}
          value={f.database}
          onChange={(e) => set("database", e.target.value)}
          placeholder="database"
        />
        <input
          className={inp2}
          value={f.user}
          onChange={(e) => set("user", e.target.value)}
          placeholder="user"
        />
        <input
          className={inp2}
          type="password"
          value={f.password}
          onChange={(e) => set("password", e.target.value)}
          placeholder="password"
        />
      </div>
      <textarea
        className={`${inp2} min-h-20 font-mono`}
        value={f.query}
        onChange={(e) => set("query", e.target.value)}
        placeholder="SELECT name, phone FROM customers WHERE called = false"
      />
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.ssl} onChange={(e) => set("ssl", e.target.checked)} />{" "}
          Use SSL
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.poll} onChange={(e) => set("poll", e.target.checked)} />{" "}
          Auto-sync every 5 min
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        The query must return a phone/mobile column. Runs read-only from the worker; credentials are
        stored with the campaign.
      </p>
      <div className="flex gap-2">
        <button
          onClick={async () => {
            const { poll, ...cfg } = f;
            await create.mutateAsync({
              kind: "database",
              config: { ...cfg, poll_seconds: poll ? 300 : 0 },
            });
            onDone();
          }}
          disabled={!f.host || !f.query || create.isPending}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {create.isPending ? "Connecting…" : "Connect & sync"}
        </button>
        <button onClick={onDone} className="px-4 py-2 rounded-lg border border-border text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

const PRESET_LABELS: Record<string, string> = {
  generic: "Generic webhook",
  zoho: "Zoho CRM",
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  meta_lead_ads: "Meta Lead Ads",
  google_lead_ads: "Google Lead Ads",
};

function RealtimeIngress({ id }: { id: string }) {
  const { data: info } = useTriggerInfo(id);
  const setPreset = useSetPreset(id);
  const [copied, setCopied] = useState<string | null>(null);
  if (!info) return null;
  const copy = (text: string, k: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(k);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div id="realtime-ingress" className="bg-card border border-border rounded-xl p-5 space-y-3">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <Webhook className="w-4 h-4 text-primary" /> Real-time ingress (CRM / web forms / lead ads)
      </h3>
      <p className="text-xs text-muted-foreground">
        Point your CRM, website form, or Meta/Google Lead Ads at this URL. The moment a contact is
        created, we dial them.
      </p>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Which system will send contacts?
        </div>
        <div className="flex flex-wrap gap-2">
          {(info.presets || []).map((p: string) => (
            <button
              key={p}
              onClick={() => setPreset.mutate(p)}
              className={`text-xs px-3 py-1.5 rounded-full border ${info.active_preset === p ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:bg-muted"}`}
            >
              {PRESET_LABELS[p] || p}
            </button>
          ))}
        </div>
      </div>

      <Copyable label="POST URL" value={info.url} k="url" copied={copied} onCopy={copy} />
      <Copyable
        label={`Header — ${info.header}`}
        value={info.token}
        k="token"
        copied={copied}
        onCopy={copy}
      />
      <p className="text-xs text-muted-foreground">
        Example:{" "}
        <code className="text-[11px]">
          curl -X POST {info.url} -H "{info.header}: {info.token}" -H "Content-Type:
          application/json" -d '{"{"}"phone":"+9199…","name":"Asha"{"}"}'
        </code>
      </p>
    </div>
  );
}

function Copyable({
  label,
  value,
  k,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  k: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs break-all">
          {value}
        </code>
        <button
          onClick={() => onCopy(value, k)}
          className="p-2 rounded-lg border border-border hover:bg-muted"
        >
          {copied === k ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

const inp2 = "w-full px-3 py-2 rounded-lg border border-border bg-background text-sm";

function ActionBtn({
  onClick,
  icon: Icon,
  label,
  cls,
}: {
  onClick: () => void;
  icon: any;
  label: string;
  cls: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm ${cls}`}
    >
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
}
function Tile({ icon: Icon, label, value }: { icon?: any; label: string; value: string | number }) {
  return (
    <div className="rounded-xl p-4 border border-border bg-card shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
      </div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}
