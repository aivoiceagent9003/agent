// /app/team — the owner invites employees and manages who has access.
//
// Owner-only. Managers can reach the API's read endpoint (team:read) but the nav
// entry and this route are gated to owners, since everything actionable here is.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  useMe,
  useTeam,
  useInviteMember,
  useResendInvite,
  useRevokeInvite,
  useUpdateMember,
  useRemoveMember,
  ROLE_LABEL,
  ROLE_DESCRIPTION,
} from "@/lib/team";
import type { TenantRole, TeamMember } from "@/lib/team";
import { UserPlus, MailCheck, RotateCw, X, ShieldCheck, Copy, Check } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/team")({
  head: () => ({ meta: [{ title: "Team — AnswerLabs" }] }),
  component: TeamPage,
});

const ROLES: TenantRole[] = ["agent", "manager", "owner"];

function TeamPage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data, isLoading } = useTeam();

  // Belt and braces — the API enforces this, the nav hides it, and this bounces
  // anyone who reaches the URL directly.
  useEffect(() => {
    if (me && me.tenant_role !== "owner") navigate({ to: "/app" });
  }, [me, navigate]);

  if (isLoading || !data) {
    return <div className="p-8 text-sm text-muted-foreground">Loading your team…</div>;
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold">Team</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Invite your staff so they can work the leads your agent captures — without giving them
          access to your agent's settings.
        </p>
      </header>

      <InviteForm emailDelivery={data.email_delivery} />

      <section className="mt-10">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Members ({data.members.length})
        </h2>
        <div className="mt-3 border border-border rounded-xl divide-y divide-border overflow-hidden">
          {data.members.map((m) => (
            <MemberRow key={m.id} member={m} isSelf={m.id === me?.user_id} members={data.members} />
          ))}
        </div>
      </section>

      {data.invites.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Pending invites ({data.invites.length})
          </h2>
          <div className="mt-3 border border-border rounded-xl divide-y divide-border overflow-hidden">
            {data.invites.map((i) => (
              <InviteRow key={i.id} invite={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function InviteForm({ emailDelivery }: { emailDelivery: boolean }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>("agent");
  // The join link is returned exactly once, when the invite is created. Holding it
  // here is what makes inviting work at all when email delivery is unavailable.
  const [lastLink, setLastLink] = useState<{ url: string; email: string; sent: boolean } | null>(
    null,
  );
  const invite = useInviteMember();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const to = email.trim();
    try {
      const res = await invite.mutateAsync({ email: to, tenant_role: role });
      setLastLink({ url: res.invite_url, email: to, sent: res.email_sent });
      toast.success(res.email_sent ? `Invite emailed to ${to}` : `Invite created for ${to}`);
      setEmail("");
    } catch (e: any) {
      toast.error(e.message || "Could not create the invite");
    }
  }

  return (
    <div className="mt-6 border border-border rounded-xl p-5 bg-card">
      <form onSubmit={submit}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <UserPlus className="w-4 h-4 text-primary" /> Invite someone
        </div>
        <div className="mt-4 flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as TenantRole)}
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            disabled={invite.isPending}
            className="bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow disabled:opacity-60"
          >
            {invite.isPending ? "Creating…" : "Send invite"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{ROLE_DESCRIPTION[role]}</p>
      </form>

      {!emailDelivery && !lastLink && (
        <p className="mt-3 text-xs text-warning">
          Email isn't configured on this server, so invites won't be delivered automatically —
          you'll get a link to share yourself.
        </p>
      )}

      {lastLink && <InviteLink {...lastLink} onDismiss={() => setLastLink(null)} />}
    </div>
  );
}

// Shows the join link with a one-click copy. Always shown after creating an invite
// — even when the email did go out, because "resend" and "the email went to spam"
// are the two most common follow-ups an owner has.
function InviteLink({
  url,
  email,
  sent,
  onDismiss,
}: {
  url: string;
  email: string;
  sent: boolean;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the link and copy it manually");
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">
        {sent ? (
          <>
            Emailed to <span className="text-foreground">{email}</span>. You can also share this
            link directly:
          </>
        ) : (
          <>
            <span className="text-warning font-medium">Not emailed.</span> Send this link to{" "}
            <span className="text-foreground">{email}</span> yourself — it works once and expires in
            7 days:
          </>
        )}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 bg-input border border-border rounded-lg px-2 py-1.5 text-xs font-mono"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 text-xs bg-gradient-primary text-primary-foreground rounded-lg px-3 py-1.5 shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground px-1"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  members,
}: {
  member: TeamMember;
  isSelf: boolean;
  members: TeamMember[];
}) {
  const update = useUpdateMember();
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);

  async function changeRole(tenant_role: TenantRole) {
    try {
      await update.mutateAsync({ id: member.id, tenant_role });
      toast.success(`${member.email} is now a ${ROLE_LABEL[tenant_role]}`);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function toggleStatus() {
    const next = member.status === "active" ? "suspended" : "active";
    try {
      await update.mutateAsync({ id: member.id, status: next });
      toast.success(next === "suspended" ? "Access suspended" : "Access restored");
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function doRemove(reassignTo: string | null) {
    try {
      await remove.mutateAsync({ id: member.id, reassign_to: reassignTo });
      toast.success(`${member.email} removed`);
      setConfirming(false);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="px-4 py-3 bg-card">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {member.full_name || member.email}
            {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
            {member.status === "suspended" && (
              <span className="ml-2 text-xs text-destructive">suspended</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {member.email}
            {member.last_seen_at && (
              <> · last active {new Date(member.last_seen_at).toLocaleDateString()}</>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isSelf ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
              <ShieldCheck className="w-3.5 h-3.5" /> {ROLE_LABEL[member.tenant_role]}
            </span>
          ) : (
            <>
              <select
                value={member.tenant_role}
                onChange={(e) => changeRole(e.target.value as TenantRole)}
                className="bg-input border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button
                onClick={toggleStatus}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-muted"
              >
                {member.status === "active" ? "Suspend" : "Restore"}
              </button>
              <button
                onClick={() => setConfirming((v) => !v)}
                className="text-xs text-destructive hover:underline px-2 py-1.5"
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>

      {confirming && (
        <RemoveConfirm
          member={member}
          members={members}
          onCancel={() => setConfirming(false)}
          onConfirm={doRemove}
        />
      )}
    </div>
  );
}

// Removing someone must decide what happens to the leads they own — otherwise
// that work silently disappears from everyone's view.
function RemoveConfirm({
  member,
  members,
  onCancel,
  onConfirm,
}: {
  member: TeamMember;
  members: TeamMember[];
  onCancel: () => void;
  onConfirm: (reassignTo: string | null) => void;
}) {
  const [reassignTo, setReassignTo] = useState<string>("");
  const others = members.filter((m) => m.id !== member.id && m.status === "active");

  return (
    <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-xs text-foreground">
        Remove <strong>{member.email}</strong>? Their account is deleted and they lose access
        immediately.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">Reassign their leads to</label>
        <select
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
          className="bg-input border border-border rounded-lg px-2 py-1.5 text-xs"
        >
          <option value="">Leave unassigned</option>
          {others.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name || m.email}
            </option>
          ))}
        </select>
        <button
          onClick={() => onConfirm(reassignTo || null)}
          className="text-xs bg-destructive text-destructive-foreground rounded-lg px-3 py-1.5"
        >
          Remove
        </button>
        <button onClick={onCancel} className="text-xs text-muted-foreground px-2 py-1.5">
          Cancel
        </button>
      </div>
    </div>
  );
}

function InviteRow({
  invite,
}: {
  invite: {
    id: string;
    email: string;
    tenant_role: TenantRole;
    expires_at: string;
    expired: boolean;
  };
}) {
  const resend = useResendInvite();
  const revoke = useRevokeInvite();
  const [link, setLink] = useState<{ url: string; sent: boolean } | null>(null);

  return (
    <div className="px-4 py-3 bg-card">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate flex items-center gap-2">
            <MailCheck className="w-3.5 h-3.5 text-muted-foreground" />
            {invite.email}
          </div>
          <div className="text-xs text-muted-foreground">
            {ROLE_LABEL[invite.tenant_role]} ·{" "}
            {invite.expired ? (
              <span className="text-destructive">expired</span>
            ) : (
              <>expires {new Date(invite.expires_at).toLocaleDateString()}</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              try {
                // Resend always mints a NEW token (the previous one is unrecoverable —
                // we only kept its hash), so this link is the one that works.
                const res = await resend.mutateAsync(invite.id);
                setLink({ url: res.invite_url, sent: res.email_sent });
                toast.success(
                  res.email_sent ? "A fresh invite is on its way" : "New link ready to share",
                );
              } catch (e: any) {
                toast.error(e.message);
              }
            }}
            disabled={resend.isPending}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-muted disabled:opacity-60"
          >
            <RotateCw className="w-3.5 h-3.5" /> Resend
          </button>
          <button
            onClick={async () => {
              try {
                await revoke.mutateAsync(invite.id);
                toast.success("Invite revoked");
              } catch (e: any) {
                toast.error(e.message);
              }
            }}
            disabled={revoke.isPending}
            className="inline-flex items-center gap-1.5 text-xs text-destructive hover:underline px-2 py-1.5 disabled:opacity-60"
          >
            <X className="w-3.5 h-3.5" /> Revoke
          </button>
        </div>
      </div>

      {link && (
        <InviteLink
          url={link.url}
          email={invite.email}
          sent={link.sent}
          onDismiss={() => setLink(null)}
        />
      )}
    </div>
  );
}
