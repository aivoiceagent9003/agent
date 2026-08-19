// lib/instant.ts — Instant Calls (tenant-level CRM → immediate AI call).
// Separate from campaigns on purpose: nothing to create, start or schedule.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

const isBrowser = typeof window !== "undefined";

export interface InstantInfo {
  enabled: boolean;
  url: string;
  token: string;
  header: string;
  presets: string[];
  active_preset: string;
  from_number: string;
  skip_recent_days: number;
  skip_statuses: string[];
}

// Statuses that mean "already worked — don't auto-call". Suggested default in the UI.
export const DEFAULT_SKIP_STATUSES = [
  "contacted",
  "qualified",
  "converted",
  "closed",
  "lost",
  "customer",
  "unqualified",
  "junk",
  "not interested",
];

export function useInstantInfo() {
  return useQuery({
    queryKey: ["instant-call"],
    enabled: isBrowser,
    queryFn: async (): Promise<InstantInfo> => apiFetch("/api/client/instant-call"),
  });
}

export function useUpdateInstant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      enabled?: boolean;
      preset?: string;
      from_number?: string;
      skip_recent_days?: number;
      skip_statuses?: string[];
    }) => apiFetch("/api/client/instant-call", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instant-call"] }),
  });
}

export function useRotateInstantToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/api/client/instant-call/rotate", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instant-call"] }),
  });
}
