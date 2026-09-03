// /work/leads — the employee lead queue.
//
// Card layout rather than the owner dashboard's table: staff work leads one at a
// time (read the summary, call, update status), and every action is on the card so
// nothing needs a second screen.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useClientLeads, exportLeadsCsv } from "@/lib/data";
import { useMe, useUpdateLead, LEAD_STATUSES, STATUS_LABEL, type LeadStatus } from "@/lib/team";
import type { Lead } from "@/lib/mock-data";
import { Download, Search, MessageSquarePlus, Check } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/work/leads/")({
  head: () => ({ meta: [{ title: "Leads — AnswerLabs" }] }),
  component: EmployeeLeads,
});

type Tab = "all" | "mine" | "unassigned";

export function EmployeeLeads() {
  const { data: leads = [] } = useClientLeads();
  const { data: me } = useMe();

  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");

  const counts = useMemo(() => {
    const by = (s: LeadStatus) => leads.filter((l) => (l.status ?? "new") === s).length;
    return {
      all: leads.length,
      mine: leads.filter((l) => l.assigned_to === me?.user_id).length,
      unassigned: leads.filter((l) => !l.assigned_to).length,
      new: by("new"),
      contacted: by("contacted"),
      converted: by("converted"),
    };
  }, [leads, me?.user_id]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = leads.filter((l) => {
      if (tab === "mine" && l.assigned_to !== me?.user_id) return false;
      if (tab === "unassigned" && l.assigned_to) return false;
      if (status && (l.status ?? "new") !== status) return false;
      if (sentiment && l.sentiment !== sentiment) return false;
      if (followUp && !l.follow_up_needed) return false;
      if (!q) return true;
      return (
        (l.name || "").toLowerCase().includes(q) ||
        (l.caller_number || "").toLowerCase().includes(q) ||
        (l.summary || "").toLowerCase().includes(q) ||
        (l.intent || "").toLowerCase().includes(q)
      );
    });
    return filtered.sort((a, b) => {
      const d = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return sort === "newest" ? d : -d;
    });
  }, [leads, tab, search, status, sentiment, followUp, sort, me?.user_id]);

  async function download() {
    try {
      await exportLeadsCsv();
      toast.success("Export downloaded.");
    } catch (e: any) {
      toast.error(e.message || "Export failed");
    }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {counts.all} leads from {me?.tenant.business_name || "your business"}
          </p>
        </div>
        <button
          onClick={download}
          className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2 text-sm font-medium hover:bg-muted transition"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </header>

      <div className="mt-6 inline-flex gap-1 p-1 rounded-xl bg-muted">
        {(
          [
            ["all", `All (${counts.all})`],
            ["mine", `My leads (${counts.mine})`],
            ["unassigned", `Unassigned (${counts.unassigned})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === key ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill
          dot="bg-primary"
          label={`${counts.new} New`}
          onClick={() => setStatus("new")}
          active={status === "new"}
        />
        <StatusPill
          dot="bg-warning"
          label={`${counts.contacted} Contacted`}
          onClick={() => setStatus("contacted")}
          active={status === "contacted"}
        />
        <StatusPill
          dot="bg-success"
          label={`${counts.converted} Converted`}
          onClick={() => setStatus("converted")}
          active={status === "converted"}
        />
        {status && (
          <button
            onClick={() => setStatus("")}
            className="text-xs text-primary hover:underline px-2"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, number, or keyword"
            className="w-full bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={sentiment}
          onChange={(e) => setSentiment(e.target.value)}
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All sentiments</option>
          {["positive", "neutral", "frustrated", "angry"].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <button
          onClick={() => setFollowUp((v) => !v)}
          className={`rounded-lg px-3 py-2 text-sm border transition ${
            followUp ? "border-primary text-primary bg-primary/5" : "border-border hover:bg-muted"
          }`}
        >
          Needs follow-up
        </button>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      <div className="mt-6 space-y-4">
        {rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No leads match these filters.
          </p>
        ) : (
          rows.map((lead) => <LeadCard key={lead.id} lead={lead} meId={me?.user_id} />)
        )}
      </div>
    </div>
  );
}

function StatusPill({
  dot,
  label,
  onClick,
  active,
}: {
  dot: string;
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </button>
  );
}

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: "bg-primary/10 text-primary",
  contacted: "bg-warning/15 text-warning",
  converted: "bg-success/15 text-success",
  lost: "bg-muted text-muted-foreground",
};

function LeadCard({ lead, meId }: { lead: Lead; meId?: string }) {
  const update = useUpdateLead();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(lead.notes || "");

  const status = (lead.status ?? "new") as LeadStatus;
  const mine = lead.assigned_to === meId;
  const details: string[] = Array.isArray(lead.key_details) ? lead.key_details : [];

  async function patch(body: Parameters<typeof update.mutateAsync>[0], ok: string) {
    try {
      await update.mutateAsync(body);
      toast.success(ok);
    } catch (e: any) {
      toast.error(e.message || "Could not update the lead");
    }
  }

  return (
    <article className="relative border border-border border-l-2 border-l-primary rounded-xl bg-card p-5 transition hover:border-primary/60 hover:shadow-sm focus-within:ring-2 focus-within:ring-ring">
      {/* Stretched link: covers the whole card so anywhere is clickable, while the
          action row below sits above it on z-10. Keeps the buttons working without
          nesting interactive elements inside an anchor (invalid HTML). */}
      <Link
        to="/work/leads/$id"
        params={{ id: lead.id }}
        className="absolute inset-0 rounded-xl z-0"
        aria-label={`Open lead ${lead.name || lead.caller_number || ""}`}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-semibold">{lead.name || "Unknown caller"}</h3>
          <p className="text-sm text-muted-foreground">{lead.caller_number || lead.contact_info}</p>
        </div>
        <div className="text-right shrink-0">
          <span
            className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
          <p className="text-xs text-muted-foreground mt-1">{timeAgo(lead.created_at)}</p>
        </div>
      </div>

      {lead.summary && <p className="mt-3 text-sm">{lead.summary}</p>}

      {details.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {details.slice(0, 3).map((d, i) => (
            <span key={i} className="rounded-full bg-muted px-2.5 py-1 text-xs">
              {d}
            </span>
          ))}
          {details.length > 3 && (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs">
              +{details.length - 3} more
            </span>
          )}
        </div>
      )}

      <div className="relative z-10 mt-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {lead.sentiment && (
            <span className="rounded-full bg-success/15 text-success px-2.5 py-1 text-xs capitalize">
              {lead.sentiment}
            </span>
          )}
          {lead.follow_up_needed && (
            <span className="rounded-full bg-warning/15 text-warning px-2.5 py-1 text-xs">
              ↩ Follow up
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm">
          {mine ? (
            <>
              <span className="text-muted-foreground">You</span>
              <button
                onClick={() => patch({ id: lead.id, assigned_to: null }, "Released")}
                className="text-muted-foreground hover:text-foreground"
              >
                Unassign
              </button>
            </>
          ) : lead.assigned_to ? (
            <span className="text-muted-foreground">Assigned</span>
          ) : (
            <>
              <span className="text-muted-foreground">Unassigned</span>
              <button
                onClick={() => patch({ id: lead.id, assigned_to: meId }, "Assigned to you")}
                className="text-primary hover:underline font-medium"
              >
                Assign to me
              </button>
            </>
          )}

          <button
            onClick={() => setNoteOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <MessageSquarePlus className="w-4 h-4" />
            {lead.notes ? "Edit note" : "Add note"}
          </button>

          {status === "new" && (
            <button
              onClick={() => patch({ id: lead.id, status: "contacted" }, "Marked contacted")}
              className="border border-border rounded-lg px-3 py-1.5 hover:bg-muted transition"
            >
              Mark contacted
            </button>
          )}
          {status === "contacted" && (
            <button
              onClick={() => patch({ id: lead.id, status: "converted" }, "Marked converted 🎉")}
              className="inline-flex items-center gap-1.5 border border-border rounded-lg px-3 py-1.5 hover:bg-muted transition"
            >
              <Check className="w-3.5 h-3.5" /> Mark converted
            </button>
          )}
        </div>
      </div>

      {noteOpen && (
        <div className="relative z-10 mt-4 border-t border-border pt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="What happened on this lead?"
            className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={async () => {
                await patch({ id: lead.id, notes: note }, "Note saved");
                setNoteOpen(false);
              }}
              className="bg-gradient-primary text-primary-foreground rounded-lg px-3 py-1.5 text-sm"
            >
              Save note
            </button>
            <button
              onClick={() => {
                setNote(lead.notes || "");
                setNoteOpen(false);
              }}
              className="text-sm text-muted-foreground px-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function timeAgo(iso: string) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}
