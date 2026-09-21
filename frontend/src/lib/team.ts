// team.ts — Session identity + team management data layer.
//
// Two concerns that belong together because both answer "who is this person and
// what may they do":
//   • useMe()      — the signed-in user's role + permission list (drives navigation)
//   • useTeam()    — members and pending invites (the Team page)
//   • invite/join  — the owner→employee flow
//
// Follows the conventions in data.ts: React Query hooks over apiFetch, queries
// disabled during SSR.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, BASE_URL } from "./api";
import type { Lead } from "./mock-data";

const isBrowser = typeof window !== "undefined";

export type TenantRole = "owner" | "manager" | "agent";

export type Me = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  tenant_role: TenantRole;
  permissions: string[];
  tenant: {
    id: string | null;
    name: string | null;
    business_name: string | null;
    phone_number: string | null;
    status: string;
  };
};

export type TeamMember = {
  id: string;
  email: string;
  full_name: string | null;
  tenant_role: TenantRole;
  status: "active" | "suspended";
  last_seen_at: string | null;
  created_at: string;
};

export type TeamInvite = {
  id: string;
  email: string;
  tenant_role: TenantRole;
  expires_at: string;
  created_at: string;
  expired: boolean;
};

export const ROLE_LABEL: Record<TenantRole, string> = {
  owner: "Owner",
  manager: "Manager",
  agent: "Agent",
};

export const ROLE_DESCRIPTION: Record<TenantRole, string> = {
  owner: "Full access, including agent settings, billing and the team",
  manager: "Calls, leads, campaigns, WhatsApp and knowledge — no agent settings",
  agent: "Calls and leads only — view and update lead status",
};

// ─── Session ─────────────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    enabled: isBrowser,
    // Role changes are rare; avoid refetching this on every window focus.
    staleTime: 60_000,
    queryFn: async (): Promise<Me> => apiFetch("/api/client/me"),
  });
}

/** Does the signed-in user hold this permission? Safe before `me` has loaded. */
export function hasPermission(me: Me | undefined, permission: string): boolean {
  return !!me?.permissions?.includes(permission);
}

// ─── Team ────────────────────────────────────────────────────────────────────

/**
 * Team roster. `enabled` exists because front-line agents have no team:read
 * permission — calling this for them is a guaranteed 403 that React Query would
 * then retry. Pass `hasPermission(me, "team:read")` from screens that only
 * sometimes need it.
 */
export function useTeam({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["team"],
    enabled: isBrowser && enabled,
    queryFn: async (): Promise<{
      members: TeamMember[];
      invites: TeamInvite[];
      can_manage: boolean;
      /** False when the server has no SMTP configured — invites must be shared by hand. */
      email_delivery: boolean;
    }> => apiFetch("/api/client/team"),
  });
}

/** Both invite mutations return the join link ONCE, plus whether email got out. */
export type InviteResult = {
  invite_url: string;
  email_sent: boolean;
};

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      email: string;
      tenant_role: TenantRole;
    }): Promise<InviteResult & { invite: TeamInvite }> =>
      apiFetch("/api/client/team/invite", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
}

export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<InviteResult> =>
      apiFetch(`/api/client/team/invite/${id}/resend`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/client/team/invite/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
}

export function useUpdateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      tenant_role?: TenantRole;
      status?: "active" | "suspended";
    }) =>
      apiFetch(`/api/client/team/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team"] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reassign_to }: { id: string; reassign_to?: string | null }) =>
      apiFetch(`/api/client/team/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ reassign_to: reassign_to || null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      qc.invalidateQueries({ queryKey: ["client", "leads"] });
    },
  });
}

// ─── Invite acceptance (public — the invitee has no account yet) ─────────────

export type InvitePreview = {
  email: string;
  tenant_role: TenantRole;
  business_name: string;
  expires_at: string;
};

/** Unauthenticated: never send a token header here. */
export async function fetchInvite(token: string): Promise<InvitePreview> {
  const res = await fetch(`${BASE_URL}/api/public/invite/${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "This invite link is no longer valid.");
  return body;
}

export async function acceptInvite(
  token: string,
  input: { credential?: string; password?: string; full_name?: string },
): Promise<{ token: string; role: string; tenant_role: TenantRole; tenant_id: string }> {
  const res = await fetch(`${BASE_URL}/api/public/invite/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Could not complete your signup.");
  return body;
}

// ─── Lead workflow ───────────────────────────────────────────────────────────

// Staff-facing vocabulary. 'qualified' and 'won' were collapsed into 'converted'
// by sql/messaging.sql — a distinction nobody was maintaining by hand.
export const LEAD_STATUSES = ["new", "contacted", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  converted: "Converted",
  lost: "Lost",
};

export function useUpdateLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      status?: LeadStatus;
      assigned_to?: string | null;
      notes?: string;
      follow_up_needed?: boolean;
    }) =>
      apiFetch(`/api/client/leads/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["client", "leads"] });
      qc.invalidateQueries({ queryKey: ["lead", vars.id] });
      qc.invalidateQueries({ queryKey: ["lead-activity", vars.id] });
    },
  });
}

export type LeadActivity = {
  id: number;
  action: string;
  detail: Record<string, any>;
  actor_id: string | null;
  actor_name: string;
  created_at: string;
};

export type LeadDetail = Lead & {
  /** Signed, expiring URL for the call recording. Null if the call wasn't recorded. */
  recording_url: string | null;
  duration_seconds: number | null;
  /** The call verbatim, in the language it was spoken. Parse with parseTranscript(). */
  transcript: string | null;
  assignee: { id: string; name: string } | null;
  email: string | null;
  alt_phone: string | null;
  /** Derived from the extractor's 0-100 interest score, shown out of 10. */
  priority_score: number | null;
  priority_reason: string | null;
};

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ["lead", id],
    enabled: isBrowser && !!id,
    queryFn: async (): Promise<LeadDetail> => {
      const r = await apiFetch(`/api/client/leads/${id}`);
      return r.lead;
    },
  });
}

export type LeadComment = {
  id: string;
  body: string;
  author_id: string | null;
  author_name: string;
  parent_id: string | null;
  edited_at: string | null;
  created_at: string;
  is_mine: boolean;
};

export function useLeadComments(leadId: string | null) {
  return useQuery({
    queryKey: ["lead-comments", leadId],
    enabled: isBrowser && !!leadId,
    queryFn: async (): Promise<LeadComment[]> => {
      const r = await apiFetch(`/api/client/leads/${leadId}/comments`);
      return r.comments || [];
    },
  });
}

export function useAddComment(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; parent_id?: string | null }) =>
      apiFetch(`/api/client/leads/${leadId}/comments`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-comments", leadId] }),
  });
}

export function useEditComment(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      apiFetch(`/api/client/leads/${leadId}/comments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-comments", leadId] }),
  });
}

export function useDeleteComment(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/client/leads/${leadId}/comments/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-comments", leadId] }),
  });
}

export function useLogCall(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (outcome?: string) =>
      apiFetch(`/api/client/leads/${leadId}/log-call`, {
        method: "POST",
        body: JSON.stringify({ outcome: outcome || "called" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["lead-activity", leadId] });
      qc.invalidateQueries({ queryKey: ["client", "leads"] });
    },
  });
}

export function useLeadActivity(leadId: string | null) {
  return useQuery({
    queryKey: ["lead-activity", leadId],
    enabled: isBrowser && !!leadId,
    queryFn: async (): Promise<LeadActivity[]> => {
      const r = await apiFetch(`/api/client/leads/${leadId}/activity`);
      return r.activity || [];
    },
  });
}
