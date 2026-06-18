// data.ts — Real backend data layer for the dashboard.
//
// Each hook returns data in the SAME shape the screens previously imported from
// mock-data.ts, so the UI/markup stays untouched — only the source changes from
// a static array to a live React Query fetch against the voice-agent API.
//
// Field-name remaps live here (not in the components):
//   backend avg_call_duration_seconds -> avg_duration_seconds
//   backend calls_last_7_days[{date,count}] -> callsPerDay[{day,calls}]
//   backend knowledge .content -> .text
//   transcript "user: ..."/"assistant: ..." -> "[Caller] ..."/"[Agent] ..."

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, BASE_URL, getToken } from "./api";
import type { Call, Lead, Tenant } from "./mock-data";

// Queries must not run during SSR (token + window are client-only).
const isBrowser = typeof window !== "undefined";

const weekday = (date: string) =>
  new Date(date).toLocaleDateString("en", { weekday: "short" });

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; role: string; tenant_id: string | null }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Login failed");
  return body;
}

// Self-serve client signup. Provisions auth user + tenant + profile server-side
// (POST /api/signup), then the caller can log in with the same credentials.
export async function signup(
  email: string,
  password: string,
  business_name: string,
): Promise<{ success: boolean; tenant_id: string; message: string }> {
  const res = await fetch(`${BASE_URL}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, business_name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Signup failed");
  return body;
}

// ─── Agent builder / onboarding (client self-serve) ─────────────────────────

export interface AgentTemplate {
  id: string;
  label: string;
  description: string;
  icon: string;
  suggested_kb_topics: string[];
}

export interface Voice {
  id: string;
  label: string;
  gender: string;
  note: string;
}

export function useAgentTemplates() {
  return useQuery({
    queryKey: ["agent", "templates"],
    enabled: isBrowser,
    queryFn: async (): Promise<AgentTemplate[]> => apiFetch("/api/client/agent/templates"),
  });
}

export function useVoices() {
  return useQuery({
    queryKey: ["agent", "voices"],
    enabled: isBrowser,
    queryFn: async (): Promise<Voice[]> => apiFetch("/api/client/agent/voices"),
  });
}

// The client's current agent (tenant + config). Used by the onboarding gate to
// decide whether they still need to set up their agent.
export function useAgent() {
  return useQuery({
    queryKey: ["agent", "current"],
    enabled: isBrowser,
    retry: false,
    queryFn: async (): Promise<any> => apiFetch("/api/client/agent"),
  });
}

export async function fetchTemplate(id: string): Promise<any> {
  return apiFetch(`/api/client/agent/templates/${id}`);
}

export async function generatePrompt(input: {
  agent_name?: string;
  languages?: string[];
  goal: string;
  next_steps?: string;
  faqs?: string;
  sample_transcript?: string;
}): Promise<{ system_prompt: string; config: any }> {
  return apiFetch("/api/client/agent/generate-prompt", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function useSaveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { config?: any; phone_number?: string }) =>
      apiFetch("/api/client/agent", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "current"] }),
  });
}

export function usePublishAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/api/client/agent/publish", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "current"] }),
  });
}

// Test the agent in the browser before deploying. Runs the SAME llm + RAG
// pipeline as a real call, against the (possibly unsaved) draft config.
export async function testAgent(
  message: string,
  session_id: string,
  config?: any,
): Promise<{ reply: string; used_knowledge: boolean }> {
  return apiFetch("/api/client/agent/test", {
    method: "POST",
    body: JSON.stringify({ message, session_id, config }),
  });
}

export async function resetTest(session_id: string): Promise<void> {
  await apiFetch("/api/client/agent/test/reset", {
    method: "POST",
    body: JSON.stringify({ session_id }),
  });
}

// ─── Knowledge base (client self-serve) ─────────────────────────────────────

export function useClientKnowledge() {
  return useQuery({
    queryKey: ["client", "knowledge"],
    enabled: isBrowser,
    queryFn: async (): Promise<KbChunk[]> => {
      const rows = await apiFetch("/api/client/agent/knowledge");
      return (rows || []).map((r: any) => ({
        id: r.id,
        text: r.content,
        source: r.source,
        created_at: r.created_at,
      }));
    },
  });
}

// Upload a file (pdf/txt/docx/image/…) — the backend extracts the text and
// ingests it into this client's knowledge base. Uses multipart, so it bypasses
// apiFetch's JSON Content-Type (the browser sets the multipart boundary).
export async function uploadKnowledgeFile(
  file: File,
): Promise<{ chunks_added: number; filename: string; chars: number }> {
  const token = getToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE_URL}/api/client/agent/knowledge/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Upload failed");
  return body;
}

// ─── Live data lookups (orders, dues, bookings…) ────────────────────────────
// Dynamic, per-caller data the agent fetches at call time — backed by either the
// client's own API ('http') or a data sheet they upload here ('table').

export interface LookupParam {
  name: string;
  description?: string;
  required?: boolean;
}

export interface LookupConfig {
  name: string;
  description?: string;
  parameters?: LookupParam[];
  backend:
    | { type: "http"; url: string; method?: string; headers?: Record<string, string> }
    | { type: "table"; dataset: string };
}

export interface LookupDataset {
  dataset: string;
  rows: number;
}

export function useLookups() {
  return useQuery({
    queryKey: ["client", "lookups"],
    enabled: isBrowser,
    queryFn: async (): Promise<{
      enable_lookups: boolean;
      lookups: LookupConfig[];
      datasets: LookupDataset[];
    }> => apiFetch("/api/client/agent/lookups"),
  });
}

export function useSaveLookups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { lookups: LookupConfig[]; enable_lookups?: boolean }) =>
      apiFetch("/api/client/agent/lookups", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["client", "lookups"] }),
  });
}

// Upload a CSV data sheet for the 'table' backend (multipart, so it bypasses
// apiFetch's JSON Content-Type).
export async function uploadLookupSheet(
  dataset: string,
  file: File,
): Promise<{ dataset: string; rows_added: number; columns: string[] }> {
  const token = getToken();
  const form = new FormData();
  form.append("dataset", dataset);
  form.append("file", file);
  const res = await fetch(`${BASE_URL}/api/client/agent/lookups/dataset`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Upload failed");
  return body;
}

export async function deleteLookupDataset(dataset: string): Promise<void> {
  await apiFetch(`/api/client/agent/lookups/dataset/${encodeURIComponent(dataset)}`, {
    method: "DELETE",
  });
}

// ─── Client (tenant-scoped) ─────────────────────────────────────────────────

export interface ClientOverview {
  total_calls: number;
  total_minutes: number;
  total_leads: number;
  handoff_count: number;
  avg_duration_seconds: number;
  callsPerDay: { day: string; calls: number }[];
}

export function useClientOverview() {
  return useQuery({
    queryKey: ["client", "overview"],
    enabled: isBrowser,
    queryFn: async (): Promise<ClientOverview> => {
      const o = await apiFetch("/api/client/overview");
      return {
        total_calls: o.total_calls,
        total_minutes: o.total_minutes,
        total_leads: o.total_leads,
        handoff_count: o.handoff_count,
        avg_duration_seconds: o.avg_call_duration_seconds,
        callsPerDay: (o.calls_last_7_days || []).map((r: any) => ({
          day: weekday(r.date),
          calls: r.count,
        })),
      };
    },
  });
}

export function useClientCalls(page: number, limit: number) {
  return useQuery({
    queryKey: ["client", "calls", page, limit],
    enabled: isBrowser,
    queryFn: async (): Promise<{ calls: Call[]; total: number }> => {
      const r = await apiFetch(`/api/client/calls?page=${page}&limit=${limit}`);
      return { calls: r.calls || [], total: r.total || 0 };
    },
  });
}

export interface CallDetail {
  call: Call;
  lead: Lead | null;
}

// Convert a stored transcript into the "[Agent]/[Caller]" prefixed format the
// call-detail view already parses, regardless of how the backend labelled rows.
function formatTranscript(raw: string): string {
  if (!raw) return "";
  return raw
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (t.startsWith("[")) return t; // already prefixed — leave as-is
      const m = t.match(
        /^(user|caller|customer|assistant|agent|bot|system)\s*:\s*(.*)$/i,
      );
      if (!m) return `[Caller] ${t}`;
      const role = m[1].toLowerCase();
      const who =
        role === "assistant" || role === "agent" || role === "bot" || role === "system"
          ? "Agent"
          : "Caller";
      return `[${who}] ${m[2]}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function useClientCall(id: string) {
  return useQuery({
    queryKey: ["client", "call", id],
    enabled: isBrowser && !!id,
    queryFn: async (): Promise<CallDetail> => {
      const c = await apiFetch(`/api/client/calls/${id}`);
      return {
        call: { ...c, transcript: formatTranscript(c.transcript), has_lead: !!c.lead },
        lead: c.lead || null,
      };
    },
  });
}

export function useClientLeads() {
  return useQuery({
    queryKey: ["client", "leads"],
    enabled: isBrowser,
    queryFn: async (): Promise<Lead[]> => {
      const r = await apiFetch("/api/client/leads?page=1&limit=100");
      return r.leads || [];
    },
  });
}

// CSV export needs a blob (not JSON), so it bypasses apiFetch and triggers a
// browser download directly.
export async function exportLeadsCsv() {
  const token = getToken();
  const res = await fetch(`${BASE_URL}/api/client/leads/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "leads.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Admin (platform-wide) ──────────────────────────────────────────────────

export interface AdminOverview {
  total_tenants: number;
  total_calls: number;
  total_minutes: number;
  total_leads: number;
  callsPerDay: { day: string; calls: number }[];
  recent_calls: {
    id: string;
    tenant_name: string;
    caller_number: string;
    duration_seconds: number;
    created_at: string;
  }[];
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ["admin", "overview"],
    enabled: isBrowser,
    queryFn: async (): Promise<AdminOverview> => {
      const o = await apiFetch("/api/admin/overview");
      return {
        total_tenants: o.total_tenants,
        total_calls: o.total_calls,
        total_minutes: o.total_minutes,
        total_leads: o.total_leads,
        callsPerDay: (o.calls_last_7_days || []).map((r: any) => ({
          day: weekday(r.date),
          calls: r.count,
        })),
        recent_calls: o.recent_calls || [],
      };
    },
  });
}

export interface TenantWithStats extends Tenant {
  stats: { total_calls: number; total_minutes: number; total_leads: number };
}

export function useTenants() {
  return useQuery({
    queryKey: ["admin", "tenants"],
    enabled: isBrowser,
    queryFn: async (): Promise<TenantWithStats[]> => apiFetch("/api/admin/tenants"),
  });
}

export function useTenant(id: string) {
  return useQuery({
    queryKey: ["admin", "tenant", id],
    enabled: isBrowser && !!id,
    queryFn: async (): Promise<Tenant> => apiFetch(`/api/admin/tenants/${id}`),
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) =>
      apiFetch("/api/admin/tenants", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "tenants"] }),
  });
}

export function useUpdateTenant(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) =>
      apiFetch(`/api/admin/tenants/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
      qc.invalidateQueries({ queryKey: ["admin", "tenant", id] });
    },
  });
}

// ─── Knowledge base (admin, per-tenant) ─────────────────────────────────────

export interface KbChunk {
  id: string;
  text: string;
  source?: string;
  created_at?: string;
}

export function useKnowledge(tenantId: string) {
  return useQuery({
    queryKey: ["admin", "kb", tenantId],
    enabled: isBrowser && !!tenantId,
    queryFn: async (): Promise<KbChunk[]> => {
      const rows = await apiFetch(`/api/admin/tenants/${tenantId}/knowledge`);
      return (rows || []).map((r: any) => ({
        id: r.id,
        text: r.content,
        source: r.source,
        created_at: r.created_at,
      }));
    },
  });
}

export function useAddKnowledge(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/admin/tenants/${tenantId}/knowledge`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "kb", tenantId] }),
  });
}

export function useDeleteChunk(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) =>
      apiFetch(`/api/admin/tenants/${tenantId}/knowledge/${chunkId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "kb", tenantId] }),
  });
}

export function useClearKnowledge(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/admin/tenants/${tenantId}/knowledge`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "kb", tenantId] }),
  });
}
