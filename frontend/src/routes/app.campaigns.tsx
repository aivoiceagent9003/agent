import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import {
  Megaphone,
  Plus,
  Radio,
  Play,
  Pause,
  Users,
  Phone,
  Clock,
  ChevronDown,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  useCampaigns,
  useCampaignAction,
  useDeleteCampaign,
  STATUS_COLOR,
  type Campaign,
} from "@/lib/campaigns";

export const Route = createFileRoute("/app/campaigns")({ component: CampaignsRoute });

function CampaignsRoute() {
  const child = useChildMatches();
  return child.length > 0 ? <Outlet /> : <CampaignList />;
}

const TYPE_LABEL: Record<string, string> = {
  broadcast: "Broadcast",
  ai_sales: "AI Sales",
  ai_followup: "AI Follow-up",
  event: "Event-driven",
};

function CampaignList() {
  const { data: campaigns = [], isLoading } = useCampaigns();
  const [showFinished, setShowFinished] = useState(false);
  // Finished campaigns are noise on the working dashboard — tuck them away.
  const active = campaigns.filter((c) => c.status !== "completed" && c.status !== "archived");
  const finished = campaigns.filter((c) => c.status === "completed" || c.status === "archived");

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Megaphone className="w-7 h-7 text-primary" /> Campaigns
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Outbound AI & broadcast calling campaigns.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/app/campaigns/monitor"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-muted text-sm"
          >
            <Radio className="w-4 h-4" /> Live Monitor
          </Link>
          <Link
            to="/app/campaigns/new"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Campaign
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : campaigns.length === 0 ? (
        <div className="mt-16 text-center text-muted-foreground">
          <Megaphone className="w-12 h-12 mx-auto opacity-30" />
          <p className="mt-3">No campaigns yet.</p>
          <Link
            to="/app/campaigns/new"
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> Create your first campaign
          </Link>
        </div>
      ) : (
        <>
          {active.length === 0 ? (
            <div className="mt-16 text-center text-sm text-muted-foreground">
              No active campaigns — all done. 🎉
            </div>
          ) : (
            <div className="mt-6 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {active.map((c) => (
                <CampaignCard key={c.id} c={c} />
              ))}
            </div>
          )}

          {finished.length > 0 && (
            <div className="mt-10">
              <button
                onClick={() => setShowFinished((v) => !v)}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                {showFinished ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                Completed campaigns ({finished.length})
              </button>
              {showFinished && (
                <div className="mt-4 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {finished.map((c) => (
                    <CampaignCard key={c.id} c={c} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CampaignCard({ c }: { c: Campaign }) {
  const action = useCampaignAction(c.id);
  const del = useDeleteCampaign();
  const total = c.contacts?.total ?? 0;
  const done = c.contacts?.completed ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const finished = c.status === "completed" || c.status === "archived";
  const startAt =
    c.status === "scheduled" && c.schedule?.start_at ? new Date(c.schedule.start_at) : null;
  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-card">
      <div className="flex items-start justify-between">
        <Link
          to="/app/campaigns/$id"
          params={{ id: c.id }}
          className="font-semibold hover:text-primary"
        >
          {c.name}
        </Link>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLOR[c.status]}`}>
          {c.status}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2">
        <span className="inline-flex items-center gap-1">
          {c.type === "broadcast" ? <Phone className="w-3 h-3" /> : <Radio className="w-3 h-3" />}
          {TYPE_LABEL[c.type]}
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          <Users className="w-3 h-3" />
          {total} contacts
        </span>
      </div>
      {startAt && (
        <div className="mt-2 text-xs text-primary inline-flex items-center gap-1">
          <Clock className="w-3 h-3" /> Starts{" "}
          {startAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        </div>
      )}
      <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {done}/{total} completed ({pct}%)
      </div>
      <div className="mt-4 flex gap-2">
        {c.status === "running" ? (
          <button
            onClick={() => action.mutate("pause")}
            disabled={action.isPending}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
          >
            <Pause className="w-3 h-3" /> Pause
          </button>
        ) : c.status === "scheduled" ? (
          <button
            onClick={() => action.mutate("unschedule")}
            disabled={action.isPending}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-500 hover:bg-amber-500/10"
          >
            <Clock className="w-3 h-3" /> Cancel schedule
          </button>
        ) : c.status === "draft" || c.status === "paused" ? (
          <button
            onClick={() => action.mutate(c.status === "paused" ? "resume" : "start")}
            disabled={action.isPending}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-success/40 text-success hover:bg-success/10"
          >
            <Play className="w-3 h-3" /> {c.status === "paused" ? "Resume" : "Start"}
          </button>
        ) : null}
        <Link
          to="/app/campaigns/$id"
          params={{ id: c.id }}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted"
        >
          Open
        </Link>
        {finished && (
          <button
            onClick={() => {
              if (confirm(`Delete campaign "${c.name}" and its contacts?`)) del.mutate(c.id);
            }}
            disabled={del.isPending}
            className="ml-auto inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        )}
      </div>
    </div>
  );
}
