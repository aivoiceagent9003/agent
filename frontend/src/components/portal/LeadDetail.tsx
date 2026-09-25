// The lead page itself, shared by both portals.
//
// It lived inside /work/leads/$id and nowhere else, so a business owner could see a
// lead in the list and had no way to open it — no transcript, no recording, no notes,
// no activity, no team discussion. All of that is tenant-scoped and gated on
// leads:read, which an owner has by way of '*', so the only thing missing was a page.
//
// It is ONE component rather than a copy per portal on purpose: "the same as the
// employee page" is the requirement, and two files drift apart the first time
// somebody fixes only the one they had open.
//
// Two columns: what the AI captured on the left (read-only — it is a record of a call
// that happened), and everything the human does on the right (status, assignment,
// notes, actions, discussion). That split is deliberate: nothing on the left can be
// edited, so there is never a question of whether you are looking at what the caller
// said or what a colleague typed.

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  useLead,
  useLeadActivity,
  useLeadComments,
  useAddComment,
  useEditComment,
  useDeleteComment,
  useLogCall,
  useUpdateLead,
  useMe,
  useTeam,
  hasPermission,
  LEAD_STATUSES,
  STATUS_LABEL,
  type LeadStatus,
  type LeadComment,
} from "@/lib/team";
import { CallTranscript } from "@/components/portal/CallTranscript";
import {
  ArrowLeft,
  User,
  Phone,
  Mail,
  Globe,
  BarChart3,
  PhoneCall,
  Copy,
  Check,
  X,
  Lock,
  FileText,
  Bell,
  UserCheck,
  Sparkles,
  Volume2,
  Download,
} from "lucide-react";
import { toast } from "sonner";

/** Where "Back to leads" goes — whichever portal is rendering this page. */
export type LeadsListRoute = "/work/leads" | "/app/leads";

const STATUS_DOT: Record<LeadStatus, string> = {
  new: "bg-primary",
  contacted: "bg-warning",
  converted: "bg-success",
  lost: "bg-muted-foreground",
};

export function LeadDetail({ id, backTo }: { id: string; backTo: LeadsListRoute }) {
  const { data: lead, isLoading, isError } = useLead(id);
  const { data: me } = useMe();

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading lead…</div>;
  if (isError || !lead) {
    return (
      <div className="p-8">
        <BackLink backTo={backTo} />
        <p className="mt-6 text-sm text-muted-foreground">
          That lead doesn't exist, or it belongs to another business.
        </p>
      </div>
    );
  }

  const status = (lead.status ?? "new") as LeadStatus;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <BackLink backTo={backTo} />

      <header className="mt-4">
        <h1 className="text-3xl font-bold">{lead.name || "Unknown caller"}</h1>
        <div className="mt-2 flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
          <span>{lead.caller_number}</span>
          <span>
            {new Date(lead.created_at).toLocaleString([], {
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          {lead.language && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase">
              {lead.language}
            </span>
          )}
          {lead.sentiment && (
            <span className="rounded-full bg-success/15 text-success px-2.5 py-0.5 text-xs capitalize">
              {lead.sentiment}
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 grid lg:grid-cols-[1fr_400px] gap-6 items-start">
        <CapturedPanel lead={lead} />
        <div className="space-y-6">
          <StatusPanel lead={lead} status={status} meId={me?.user_id} />
          <NotesPanel leadId={id} initial={lead.notes || ""} />
          <ActionsPanel lead={lead} status={status} />
          <ActivityPanel leadId={id} />
        </div>
      </div>

      <div className="mt-6">
        <CommentsPanel leadId={id} />
      </div>
    </div>
  );
}

function BackLink({ backTo }: { backTo: LeadsListRoute }) {
  return (
    <Link
      to={backTo}
      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
    >
      <ArrowLeft className="w-4 h-4" /> Back to leads
    </Link>
  );
}

// ─── Left: what the AI captured (read-only) ──────────────────────────────────

function CapturedPanel({ lead }: { lead: any }) {
  const details: string[] = Array.isArray(lead.key_details) ? lead.key_details : [];

  return (
    <section className="border border-border rounded-xl bg-card p-6">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Contact
      </h2>
      <dl className="mt-3 space-y-2.5 text-sm">
        <Row icon={User} label="Name" value={lead.name} />
        <Row icon={Phone} label="Number" value={lead.caller_number} />
        <Row icon={Mail} label="Email" value={lead.email} />
        {lead.alt_phone && <Row icon={Phone} label="Alt number" value={lead.alt_phone} />}
        <Row icon={Globe} label="Language" value={languageName(lead.language)} />
      </dl>

      <hr className="my-5 border-border" />

      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Summary
      </h2>
      {lead.intent && (
        <span className="mt-2 inline-block rounded bg-primary/10 text-primary px-2 py-0.5 text-xs">
          {lead.intent}
        </span>
      )}
      <p className="mt-2 text-sm">{lead.summary || "No summary captured."}</p>

      {details.length > 0 && (
        <>
          <hr className="my-5 border-border" />
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Key details
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {details.map((d, i) => (
              <span key={i} className="rounded-full border border-border px-2.5 py-1 text-xs">
                {d}
              </span>
            ))}
          </div>
        </>
      )}

      <hr className="my-5 border-border" />
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Call recording
      </h2>
      <RecordingPlayer url={lead.recording_url} seconds={lead.duration_seconds} />

      {/* Transcript UNDER the recording, not instead of it. The audio stays the
          record of last resort — when a transcript line looks wrong, or a figure
          matters enough to hear said out loud, the recording is right there. */}
      <hr className="my-5 border-border" />
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        What was said
      </h2>
      <div className="mt-3">
        <CallTranscript
          raw={lead.transcript}
          emptyLabel="No transcript for this call — play the recording above."
          className="max-h-96"
        />
      </div>
    </section>
  );
}

// The recording is the ground truth for a call: it is the only artefact nothing has
// interpreted. The transcript below it is verbatim too, but it is still a machine's
// reading of the audio, so the player stays first.
function RecordingPlayer({ url, seconds }: { url: string | null; seconds: number | null }) {
  if (!url) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-center">
        <Volume2 className="w-5 h-5 text-muted-foreground mx-auto" />
        <p className="mt-2 text-sm text-muted-foreground">No recording for this call.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Recording may have been off, or the call ended before any audio was captured.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {/* Native controls on purpose: they give scrubbing, speed and volume for
          free, and they work with the browser's own accessibility affordances. */}
      <audio controls preload="metadata" src={url} className="w-full">
        Your browser can't play audio. <a href={url}>Download the recording</a> instead.
      </audio>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{seconds ? `${formatDuration(seconds)} call` : "Call recording"}</span>
        <a href={url} download className="inline-flex items-center gap-1.5 hover:text-foreground">
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>
    </div>
  );
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function Row({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
      <dt className="text-muted-foreground w-20 shrink-0">{label}</dt>
      <dd className={value ? "font-medium" : "text-muted-foreground"}>{value || "—"}</dd>
    </div>
  );
}

function languageName(code?: string | null) {
  const map: Record<string, string> = {
    en: "English",
    hi: "Hindi",
    te: "Telugu",
    ta: "Tamil",
    kn: "Kannada",
  };
  return code ? map[code] || code : null;
}

// ─── Right: status, assignment, priority, follow-up ──────────────────────────

function StatusPanel({ lead, status, meId }: { lead: any; status: LeadStatus; meId?: string }) {
  const update = useUpdateLead();
  const { data: me } = useMe();
  const { data: team } = useTeam({ enabled: hasPermission(me, "team:read") });
  const [picking, setPicking] = useState(false);

  async function patch(body: any, ok: string) {
    try {
      await update.mutateAsync({ id: lead.id, ...body });
      toast.success(ok);
    } catch (e: any) {
      toast.error(e.message || "Could not update the lead");
    }
  }

  return (
    <section className="border border-border rounded-xl bg-card p-5">
      <h2 className="font-semibold">Lead status</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {LEAD_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => patch({ status: s }, `Marked ${STATUS_LABEL[s].toLowerCase()}`)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition ${
              status === s
                ? "border-primary bg-primary/5 font-medium"
                : "border-border hover:bg-muted"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[s]}`} />
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <h3 className="mt-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Assigned to
      </h3>
      <div className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm">
        {lead.assignee ? (
          <span className="font-medium">
            {lead.assignee.id === meId ? "You" : lead.assignee.name}
          </span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        )}
      </div>

      {lead.assigned_to === meId ? (
        <button
          onClick={() => patch({ assigned_to: null }, "Released")}
          className="mt-2 w-full border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition"
        >
          Unassign me
        </button>
      ) : (
        <button
          onClick={() => patch({ assigned_to: meId }, "Assigned to you")}
          className="mt-2 w-full border border-border rounded-lg px-3 py-2 text-sm hover:bg-muted transition"
        >
          Assign to me
        </button>
      )}

      {/* Only offered when the caller can actually list colleagues — agents
          deliberately can't (see the team:read permission). */}
      {team?.members?.length ? (
        picking ? (
          <select
            autoFocus
            className="mt-2 w-full bg-input border border-border rounded-lg px-3 py-2 text-sm"
            defaultValue={lead.assigned_to || ""}
            onChange={(e) => {
              patch({ assigned_to: e.target.value || null }, "Lead reassigned");
              setPicking(false);
            }}
          >
            <option value="">Unassigned</option>
            {team.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === meId ? "Me" : m.full_name || m.email}
              </option>
            ))}
          </select>
        ) : (
          <button
            onClick={() => setPicking(true)}
            className="mt-2 w-full text-sm text-primary hover:underline"
          >
            Assign to a team member
          </button>
        )
      ) : null}

      {typeof lead.priority_score === "number" && (
        <>
          <h3 className="mt-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Priority
          </h3>
          <div
            className="mt-1.5 flex items-center gap-2 text-sm"
            title={lead.priority_reason || undefined}
          >
            <BarChart3 className={`w-4 h-4 ${priorityTone(lead.priority_score)}`} />
            <span className={`font-medium ${priorityTone(lead.priority_score)}`}>
              {priorityLabel(lead.priority_score)}
            </span>
            <span className="text-muted-foreground">· {lead.priority_score}/10</span>
          </div>
          {lead.priority_reason && (
            <p className="mt-1 text-xs text-muted-foreground">{lead.priority_reason}</p>
          )}
        </>
      )}

      <label className="mt-5 flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={!!lead.follow_up_needed}
          onChange={(e) =>
            patch(
              { follow_up_needed: e.target.checked },
              e.target.checked ? "Flagged for follow-up" : "Follow-up cleared",
            )
          }
        />
        <span className="w-10 h-6 rounded-full bg-muted peer-checked:bg-primary transition relative shrink-0">
          <span className="absolute top-1 left-1 w-4 h-4 rounded-full bg-background transition peer-checked:translate-x-4" />
        </span>
        <span className="text-sm">Needs follow-up</span>
      </label>
    </section>
  );
}

// The extractor's 0-100 interest score, shown out of 10.
function priorityLabel(n: number) {
  return n >= 7 ? "High" : n >= 4 ? "Medium" : "Low";
}
function priorityTone(n: number) {
  return n >= 7 ? "text-success" : n >= 4 ? "text-warning" : "text-muted-foreground";
}

// ─── Notes ───────────────────────────────────────────────────────────────────

function NotesPanel({ leadId, initial }: { leadId: string; initial: string }) {
  const update = useUpdateLead();
  const [notes, setNotes] = useState(initial);

  // Re-seed if the lead reloads under us (e.g. after another tab saved).
  useEffect(() => setNotes(initial), [initial]);

  const dirty = notes !== initial;

  return (
    <section className="border border-border rounded-xl bg-card p-5">
      <h2 className="font-semibold">Your notes</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Only visible to your team, not clients.
      </p>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value.slice(0, 500))}
        rows={5}
        placeholder="Add notes about this lead — conversations, next steps, anything useful."
        className="mt-3 w-full bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{notes.length} / 500</span>
        <button
          disabled={!dirty || update.isPending}
          onClick={async () => {
            try {
              await update.mutateAsync({ id: leadId, notes });
              toast.success("Notes saved");
            } catch (e: any) {
              toast.error(e.message);
            }
          }}
          className="bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {update.isPending ? "Saving…" : "Save notes"}
        </button>
      </div>
    </section>
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function ActionsPanel({ lead, status }: { lead: any; status: LeadStatus }) {
  const logCall = useLogCall(lead.id);
  const update = useUpdateLead();

  async function copyContact() {
    const text = [lead.name, lead.caller_number, lead.email, lead.summary]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Contact info copied");
    } catch {
      toast.error("Couldn't copy to your clipboard");
    }
  }

  return (
    <section className="border border-border rounded-xl bg-card p-5">
      <h2 className="font-semibold">Actions</h2>
      <div className="mt-3 space-y-2">
        <button
          onClick={async () => {
            try {
              await logCall.mutateAsync(undefined);
              toast.success("Call logged");
            } catch (e: any) {
              toast.error(e.message);
            }
          }}
          className="w-full flex items-center gap-2.5 border border-border rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition"
        >
          <PhoneCall className="w-4 h-4 text-muted-foreground" /> Log a call
        </button>

        <button
          onClick={copyContact}
          className="w-full flex items-center gap-2.5 border border-border rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition"
        >
          <Copy className="w-4 h-4 text-muted-foreground" /> Copy contact info
        </button>

        {status !== "converted" && (
          <button
            onClick={() =>
              update.mutate(
                { id: lead.id, status: "converted" },
                {
                  onSuccess: () => toast.success("Marked converted 🎉"),
                  onError: (e: any) => toast.error(e.message),
                },
              )
            }
            className="w-full flex items-center gap-2.5 border border-success/50 text-success rounded-lg px-3 py-2.5 text-sm hover:bg-success/5 transition"
          >
            <Sparkles className="w-4 h-4" /> Mark as converted
          </button>
        )}

        {status !== "lost" && (
          <button
            onClick={() =>
              update.mutate(
                { id: lead.id, status: "lost" },
                {
                  onSuccess: () => toast.success("Marked lost"),
                  onError: (e: any) => toast.error(e.message),
                },
              )
            }
            className="w-full flex items-center gap-2.5 border border-destructive/50 text-destructive rounded-lg px-3 py-2.5 text-sm hover:bg-destructive/5 transition"
          >
            <X className="w-4 h-4" /> Mark as lost
          </button>
        )}
      </div>
    </section>
  );
}

// ─── Activity ────────────────────────────────────────────────────────────────

const ACTION_ICON: Record<string, any> = {
  lead_captured: FileText,
  assigned: UserCheck,
  unassigned: UserCheck,
  status_changed: Check,
  note_added: FileText,
  call_logged: PhoneCall,
  follow_up_set: Bell,
  follow_up_cleared: Bell,
};

function describe(a: any): string {
  const d = a.detail || {};
  switch (a.action) {
    case "lead_captured":
      return "Lead captured from inbound call.";
    case "assigned":
      return `Assigned to ${a.assignee_name || "a team member"}.`;
    case "unassigned":
      return "Unassigned.";
    case "status_changed":
      return `Marked as ${d.to || "updated"}.`;
    case "note_added":
      return d.preview ? `Added a note: "${d.preview}"` : "Updated the notes.";
    case "call_logged":
      return "Logged a call.";
    case "follow_up_set":
      return "Marked as needs follow-up.";
    case "follow_up_cleared":
      return "Cleared the follow-up flag.";
    default:
      return a.action.replace(/_/g, " ");
  }
}

function ActivityPanel({ leadId }: { leadId: string }) {
  const { data: activity = [] } = useLeadActivity(leadId);

  return (
    <section className="border border-border rounded-xl bg-card p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Activity</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {activity.length} {activity.length === 1 ? "event" : "events"}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          activity.map((a: any) => {
            const Icon = ACTION_ICON[a.action] || FileText;
            return (
              <div key={`${a.id}-${a.created_at}`} className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-muted grid place-items-center shrink-0">
                  <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{a.actor_name}</span>{" "}
                    <span className="text-muted-foreground">{describe(a)}</span>
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {timeAgo(a.created_at)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ─── Team comments ───────────────────────────────────────────────────────────

function CommentsPanel({ leadId }: { leadId: string }) {
  const { data: comments = [] } = useLeadComments(leadId);
  const add = useAddComment(leadId);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  async function post() {
    const body = draft.trim();
    if (!body) return;
    try {
      await add.mutateAsync({ body, parent_id: replyTo });
      setDraft("");
      setReplyTo(null);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);

  return (
    <section className="border border-border rounded-xl bg-card p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Team comments</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="w-3 h-3" /> Only your team can see these
        </span>
      </div>

      <div className="mt-4">
        {replyTo && (
          <p className="mb-1.5 text-xs text-muted-foreground">
            Replying to a comment ·{" "}
            <button onClick={() => setReplyTo(null)} className="text-primary hover:underline">
              cancel
            </button>
          </p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 500))}
          rows={3}
          placeholder="Add a comment visible to your team..."
          className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{draft.length} / 500</span>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setDraft("");
                setReplyTo(null);
              }}
              className="border border-border rounded-lg px-3 py-1.5 text-sm hover:bg-muted transition"
            >
              Cancel
            </button>
            <button
              onClick={post}
              disabled={!draft.trim() || add.isPending}
              className="bg-gradient-primary text-primary-foreground rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {add.isPending ? "Posting…" : "Post comment"}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-5">
        {roots.map((c) => (
          <div key={c.id}>
            <CommentRow comment={c} leadId={leadId} onReply={() => setReplyTo(c.id)} />
            {repliesOf(c.id).length > 0 && (
              <div className="mt-4 ml-11 space-y-4 border-l border-border pl-4">
                {repliesOf(c.id).map((r) => (
                  <CommentRow key={r.id} comment={r} leadId={leadId} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  leadId,
  onReply,
}: {
  comment: LeadComment;
  leadId: string;
  onReply?: () => void;
}) {
  const edit = useEditComment(leadId);
  const del = useDeleteComment(leadId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);

  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-primary grid place-items-center text-primary-foreground text-[11px] font-semibold shrink-0">
        {comment.author_name
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase())
          .join("")}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{comment.author_name}</span>
          <span className="text-xs text-muted-foreground">· {timeAgo(comment.created_at)}</span>
          {comment.edited_at && <span className="text-xs text-muted-foreground">(edited)</span>}
          {/* Edit/Delete only for your own — the API enforces this too. */}
          {comment.is_mine && !editing && (
            <span className="ml-auto flex gap-3 text-xs">
              <button
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground"
              >
                Edit
              </button>
              <button
                onClick={async () => {
                  try {
                    await del.mutateAsync(comment.id);
                  } catch (e: any) {
                    toast.error(e.message);
                  }
                }}
                className="text-muted-foreground hover:text-destructive"
              >
                Delete
              </button>
            </span>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 500))}
              rows={3}
              className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={async () => {
                  try {
                    await edit.mutateAsync({ id: comment.id, body });
                    setEditing(false);
                  } catch (e: any) {
                    toast.error(e.message);
                  }
                }}
                className="bg-gradient-primary text-primary-foreground rounded-lg px-3 py-1 text-xs"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setBody(comment.body);
                  setEditing(false);
                }}
                className="text-xs text-muted-foreground px-2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-0.5 text-sm">{comment.body}</p>
            {onReply && (
              <button
                onClick={onReply}
                className="mt-1 text-xs text-muted-foreground hover:text-foreground"
              >
                ↩ Reply
              </button>
            )}
          </>
        )}
      </div>
    </div>
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
