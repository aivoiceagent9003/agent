// lib/campaigns.ts — Campaign Automation data layer (client/tenant-scoped).
//
// React Query hooks + mutations over /api/client/campaigns/*, mirroring lib/data.ts
// conventions (apiFetch, invalidate on mutate, enabled only in browser).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, BASE_URL, getToken } from "./api";

const isBrowser = typeof window !== "undefined";

export type CampaignType = "broadcast" | "ai_sales" | "ai_followup" | "event";
export type CampaignStatus = "draft" | "scheduled" | "running" | "paused" | "completed" | "archived";

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  direction: string;
  from_number: string | null;
  config: any;
  schedule: any;
  retry_policy: any;
  compliance: any;
  created_at: string;
  contacts?: { total: number; completed: number };
}

export interface CampaignContact {
  id: string;
  name: string | null;
  phone: string;
  status: string;
  disposition: string | null;
  attempts: number;
  segment: string | null;
  last_contacted_at: string | null;
  custom_fields: Record<string, any>;
}

export interface CampaignMetrics {
  calls: number; answered: number; conversations: number; ai_minutes: number;
  human_transfers: number; qualified_leads: number; meetings_booked: number;
  no_answer: number; failed: number; cost: number; revenue: number;
  language_dist: Record<string, number>;
}

// ─── Queries ────────────────────────────────────────────────────────────────
export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    enabled: isBrowser,
    queryFn: async (): Promise<Campaign[]> => (await apiFetch("/api/client/campaigns")).campaigns || [],
  });
}

export function useCampaign(id: string) {
  return useQuery({
    queryKey: ["campaign", id],
    enabled: isBrowser && !!id,
    queryFn: async (): Promise<Campaign> => apiFetch(`/api/client/campaigns/${id}`),
  });
}

export function useCampaignContacts(id: string, page = 1) {
  return useQuery({
    queryKey: ["campaign", id, "contacts", page],
    enabled: isBrowser && !!id,
    queryFn: async () => apiFetch(`/api/client/campaigns/${id}/contacts?page=${page}&limit=50`),
  });
}

export function useCampaignAnalytics(id: string) {
  return useQuery({
    queryKey: ["campaign", id, "analytics"],
    enabled: isBrowser && !!id,
    refetchInterval: 8000,
    queryFn: async (): Promise<CampaignMetrics> => (await apiFetch(`/api/client/campaigns/${id}/analytics`)).metrics,
  });
}

export function useCampaignLogs(id: string) {
  return useQuery({
    queryKey: ["campaign", id, "logs"],
    enabled: isBrowser && !!id,
    refetchInterval: 6000,
    queryFn: async () => (await apiFetch(`/api/client/campaigns/${id}/logs`)).logs || [],
  });
}

export function useCampaignMonitor() {
  return useQuery({
    queryKey: ["campaigns", "monitor"],
    enabled: isBrowser,
    refetchInterval: 3000,
    queryFn: async () => apiFetch("/api/client/campaigns/monitor"),
  });
}

export function useDialerInfo() {
  return useQuery({
    queryKey: ["campaigns", "dialer"],
    enabled: isBrowser,
    queryFn: async () => apiFetch("/api/client/campaigns/dialer"),
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────
export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Campaign>) => apiFetch("/api/client/campaigns", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function useUpdateCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Campaign>) => apiFetch(`/api/client/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campaign", id] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });
}

export function useCampaignAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "stop" | "duplicate" | "unschedule") =>
      apiFetch(`/api/client/campaigns/${id}/${action}`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campaign", id] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });
}

// Schedule the campaign to start automatically at a specific date/time.
export function useScheduleStart(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (startAt: string) =>
      apiFetch(`/api/client/campaigns/${id}/start`, { method: "POST", body: JSON.stringify({ start_at: startAt }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["campaign", id] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/client/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function usePasteContacts(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => apiFetch(`/api/client/campaigns/${id}/contacts/paste`, { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id, "contacts"] }),
  });
}

export async function importContactsCsv(id: string, file: File) {
  const token = getToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE_URL}/api/client/campaigns/${id}/contacts/import`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Import failed");
  return body;
}

// ─── Data sources ───────────────────────────────────────────────────────────
export interface ContactSource {
  id: string;
  kind: "file" | "google_sheet" | "database" | "csv" | "paste" | "manual";
  name: string | null;
  filename: string | null;
  config: any;
  status: string;
  row_count: number;
  last_synced_at: string | null;
  last_result: any;
  created_at: string;
}

export function useSources(campaignId: string) {
  return useQuery({
    queryKey: ["campaign", campaignId, "sources"],
    enabled: isBrowser && !!campaignId,
    refetchInterval: 10000,
    queryFn: async (): Promise<ContactSource[]> => (await apiFetch(`/api/client/campaigns/${campaignId}/sources`)).sources || [],
  });
}

export function useCreateSource(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: string; name?: string; config: any }) =>
      apiFetch(`/api/client/campaigns/${campaignId}/sources`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaign", campaignId, "sources"] });
      qc.invalidateQueries({ queryKey: ["campaign", campaignId, "contacts"] });
    },
  });
}

export function useSyncSource(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch(`/api/client/campaigns/${campaignId}/sources/${sourceId}/sync`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", campaignId, "sources"] }),
  });
}

export function useDeleteSource(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch(`/api/client/campaigns/${campaignId}/sources/${sourceId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", campaignId, "sources"] }),
  });
}

// ─── Real-time ingress (CRM / webhook / lead ads) ────────────────────────────
export function useTriggerInfo(campaignId: string) {
  return useQuery({
    queryKey: ["campaign", campaignId, "trigger"],
    enabled: isBrowser && !!campaignId,
    queryFn: async () => apiFetch(`/api/client/campaigns/${campaignId}/trigger`),
  });
}

export function useSetPreset(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (preset: string) =>
      apiFetch(`/api/client/campaigns/${campaignId}/trigger/preset`, { method: "PUT", body: JSON.stringify({ preset }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", campaignId, "trigger"] }),
  });
}

export const STATUS_COLOR: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  scheduled: "bg-blue-500/15 text-blue-500 border-blue-500/30",
  running: "bg-success/15 text-success border-success/30",
  paused: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  completed: "bg-primary/15 text-primary border-primary/30",
  archived: "bg-muted text-muted-foreground border-border",
};
