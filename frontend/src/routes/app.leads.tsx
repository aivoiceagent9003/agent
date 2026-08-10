import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useClientLeads, exportLeadsCsv } from "@/lib/data";
import {
  useMe,
  useTeam,
  useUpdateLead,
  hasPermission,
  LEAD_STATUSES,
  STATUS_LABEL,
  type LeadStatus,
} from "@/lib/team";
import { SentimentBadge } from "./app.calls.$id";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/app/leads")({
  component: LeadsList,
});

function LeadsList() {
  const [intent, setIntent] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [page, setPage] = useState(1);

  const { data: leads = [] } = useClientLeads();
  const { data: me } = useMe();
  // Only owners/managers may list the team. An agent gets a "Claim" control
  // instead of an assignee picker — they work their own queue rather than hand
  // work to colleagues — so we skip the request entirely for them.
  const { data: team } = useTeam({ enabled: hasPermission(me, "team:read") });
  const members = team?.members ?? [];

  // Front-line staff care about their own queue first. Owners and managers open
  // on everything, because their job is the whole pipeline.
  useEffect(() => {
    if (me?.tenant_role === "agent") setOwner("me");
  }, [me?.tenant_role]);

  const filtered = useMemo(() => {
    return leads.filter((l) =>
      (!intent || l.intent === intent) &&
      (!sentiment || l.sentiment === sentiment) &&
      (!followUp || (followUp === "yes" ? l.follow_up_needed : !l.follow_up_needed)) &&
      (!status || (l.status ?? "new") === status) &&
      (!owner ||
        (owner === "me"
          ? l.assigned_to === me?.user_id
          : owner === "unassigned"
            ? !l.assigned_to
            : l.assigned_to === owner))
    );
  }, [leads, intent, sentiment, followUp, status, owner, me?.user_id]);

  // Filters change the result set — jumping back to page 1 avoids landing on an
  // empty page that looks like "no leads".
  useEffect(() => {
    setPage(1);
  }, [intent, sentiment, followUp, status, owner]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function exportCsv() {
    try {
      await exportLeadsCsv();
      toast.success("Export downloaded.");
    } catch (e: any) {
      toast.error(e.message || "Export failed");
    }
  }

  const intents = Array.from(new Set(leads.map((l) => l.intent)));

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">{filtered.length} leads.</p>
        </div>
        <button onClick={exportCsv} className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow hover:opacity-90">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </header>

      <div className="mt-6 flex flex-wrap gap-3">
        <Select label="Status" value={status} onChange={setStatus} options={["", ...LEAD_STATUSES]} />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Owner:</span>
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="bg-input border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All</option>
            <option value="me">My leads</option>
            <option value="unassigned">Unassigned</option>
            {members
              .filter((m) => m.id !== me?.user_id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || m.email}
                </option>
              ))}
          </select>
        </label>
        <Select label="Intent" value={intent} onChange={setIntent} options={["", ...intents]} />
        <Select label="Sentiment" value={sentiment} onChange={setSentiment} options={["", "positive", "neutral", "frustrated", "angry"]} />
        <Select label="Follow-up" value={followUp} onChange={setFollowUp} options={["", "yes", "no"]} />
      </div>

      <div className="mt-4 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
              <th className="text-left px-5 py-3 font-medium">Owner</th>
              <th className="text-left px-5 py-3 font-medium">Interest</th>
              <th className="text-left px-5 py-3 font-medium">Intent</th>
              <th className="text-left px-5 py-3 font-medium">Summary</th>
              <th className="text-left px-5 py-3 font-medium">Sentiment</th>
              <th className="text-left px-5 py-3 font-medium">Contact</th>
              <th className="text-left px-5 py-3 font-medium">Follow up</th>
              <th className="text-left px-5 py-3 font-medium">Transcript</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="px-5 py-10 text-center text-muted-foreground">No leads match your filters.</td></tr>
            ) : rows.map((l) => (
              <tr key={l.id} className="hover:bg-muted/30 transition">
                <td className="px-5 py-3 font-medium">{l.name ?? <span className="text-muted-foreground">Unknown</span>}</td>
                <td className="px-5 py-3"><StatusCell lead={l} /></td>
                <td className="px-5 py-3"><OwnerCell lead={l} members={members} meId={me?.user_id} /></td>
                <td className="px-5 py-3"><InterestBadge score={l.raw_data?.interest_score} reason={l.raw_data?.interest_reason} /></td>
                <td className="px-5 py-3">{l.intent}</td>
                <td className="px-5 py-3 text-muted-foreground max-w-xs truncate">{l.summary}</td>
                <td className="px-5 py-3"><SentimentBadge s={l.sentiment} /></td>
                <td className="px-5 py-3 text-muted-foreground">{l.caller_number ?? l.contact_info}</td>
                <td className="px-5 py-3">{l.follow_up_needed ? <span className="text-warning">Yes</span> : <span className="text-muted-foreground">No</span>}</td>
                <td className="px-5 py-3">
                  {l.call_id ? (
                    <Link
                      to="/app/calls/$id"
                      params={{ id: l.call_id }}
                      className="inline-flex items-center gap-1.5 text-primary hover:underline"
                    >
                      <FileText className="w-4 h-4" /> View call
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted">Prev</button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted">Next</button>
        </div>
      </div>
    </div>
  );
}

// ─── Workflow cells ──────────────────────────────────────────────────────────
// Edited inline: the whole job here is moving a lead along, and making someone
// open a detail page to change one dropdown is friction on the most common action.

const STATUS_STYLE: Record<LeadStatus, string> = {
  new: "bg-primary/15 text-primary",
  contacted: "bg-warning/15 text-warning",
  converted: "bg-success/15 text-success",
  lost: "bg-muted text-muted-foreground",
};

function StatusCell({ lead }: { lead: { id: string; status?: LeadStatus } }) {
  const update = useUpdateLead();
  const current = lead.status ?? "new";

  return (
    <select
      value={current}
      disabled={update.isPending}
      onChange={async (e) => {
        const next = e.target.value as LeadStatus;
        try {
          await update.mutateAsync({ id: lead.id, status: next });
          toast.success(`Marked ${STATUS_LABEL[next].toLowerCase()}`);
        } catch (err: any) {
          toast.error(err.message || "Could not update the lead");
        }
      }}
      className={`rounded-full px-2.5 py-1 text-xs font-medium border-0 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${STATUS_STYLE[current]}`}
    >
      {LEAD_STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

function OwnerCell({
  lead,
  members,
  meId,
}: {
  lead: { id: string; assigned_to?: string | null };
  members: { id: string; email: string; full_name: string | null }[];
  meId?: string;
}) {
  const update = useUpdateLead();

  // An agent with no team list still gets a working "claim it" control.
  if (!members.length) {
    const mine = lead.assigned_to === meId;
    return (
      <button
        disabled={update.isPending}
        onClick={async () => {
          try {
            await update.mutateAsync({ id: lead.id, assigned_to: mine ? null : meId });
            toast.success(mine ? "Released" : "Assigned to you");
          } catch (err: any) {
            toast.error(err.message);
          }
        }}
        className="text-xs text-primary hover:underline disabled:opacity-60"
      >
        {mine ? "Mine — release" : lead.assigned_to ? "Assigned" : "Claim"}
      </button>
    );
  }

  return (
    <select
      value={lead.assigned_to ?? ""}
      disabled={update.isPending}
      onChange={async (e) => {
        const next = e.target.value || null;
        try {
          await update.mutateAsync({ id: lead.id, assigned_to: next });
          toast.success(next ? "Lead assigned" : "Lead unassigned");
        } catch (err: any) {
          toast.error(err.message || "Could not assign the lead");
        }
      }}
      className="bg-input border border-border rounded-lg px-2 py-1 text-xs max-w-[10rem] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
    >
      <option value="">Unassigned</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id === meId ? "Me" : m.full_name || m.email}
        </option>
      ))}
    </select>
  );
}

// Shows the extractor's interest score (0-100) with a warm/hot label. Higher =
// stronger buying signal. Falls back to a dash when the score isn't available.
function InterestBadge({ score, reason }: { score?: number; reason?: string }) {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return <span className="text-muted-foreground">—</span>;
  }
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const { label, cls } =
    s >= 70
      ? { label: "Hot", cls: "bg-success/15 text-success" }
      : s >= 40
        ? { label: "Warm", cls: "bg-warning/15 text-warning" }
        : { label: "Cool", cls: "bg-muted text-muted-foreground" };
  return (
    <span
      title={reason || undefined}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {label} · {s}%
    </span>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-input border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
        {options.map((o) => <option key={o} value={o}>{o || "All"}</option>)}
      </select>
    </label>
  );
}
