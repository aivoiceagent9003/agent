// lib/whatsapp.ts — per-tenant WhatsApp Business settings (client-scoped).
// The token is write-only server-side: reads report token_set, never the value.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, BASE_URL, getToken } from "./api";

const isBrowser = typeof window !== "undefined";

// A file the agent can send to customers. Its own store — NOT a knowledge-base
// document, so it's never chunked/embedded and image-only PDFs are fine.
export interface SendableDoc {
  id: string;
  topic: string; // what callers ask for: project name, "menu", "price list"…
  filename: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  created_at?: string;
}

export interface WhatsappSettings {
  platform_enabled: boolean; // shared platform sender is configured on the server
  enabled: boolean; // this tenant wants WhatsApp on
  display_phone: string; // client's contact number, shown in the message
  // advanced (enterprise bring-your-own-number)
  own_number: boolean;
  provider: "meta" | "360dialog";
  phone_number: string;
  phone_number_id: string;
  token_set: boolean;
  templates: { brochure: string; booking: string };
}

export type WhatsappUpdate = {
  enabled?: boolean;
  display_phone?: string;
  provider?: "meta" | "360dialog";
  phone_number?: string;
  phone_number_id?: string;
  templates?: { document: string; confirmation: string };
  token?: string;
};

export function useWhatsapp() {
  return useQuery({
    queryKey: ["whatsapp"],
    enabled: isBrowser,
    queryFn: async (): Promise<WhatsappSettings> => apiFetch("/api/client/whatsapp"),
  });
}

export function useSaveWhatsapp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WhatsappUpdate) =>
      apiFetch("/api/client/whatsapp", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp"] }),
  });
}

// ─── Sendable documents (own store, separate from Knowledge) ─────────────────

export function useSendableDocs() {
  return useQuery({
    queryKey: ["whatsapp-docs"],
    enabled: isBrowser,
    queryFn: async (): Promise<SendableDoc[]> => apiFetch("/api/client/whatsapp/documents"),
  });
}

// Multipart, so it bypasses apiFetch (which forces a JSON content-type — setting
// it manually would strip the boundary the browser adds).
export async function uploadSendableDoc(file: File, topic: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("topic", topic);
  const token = getToken();
  const res = await fetch(`${BASE_URL}/api/client/whatsapp/documents`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Upload failed");
  return body as { id: string; topic: string; filename: string };
}

export function useUploadSendableDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, topic }: { file: File; topic: string }) => uploadSendableDoc(file, topic),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-docs"] }),
  });
}

export function useRenameSendableDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, topic }: { id: string; topic: string }) =>
      apiFetch(`/api/client/whatsapp/documents/${id}`, {
        method: "PUT",
        body: JSON.stringify({ topic }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-docs"] }),
  });
}

export function useDeleteSendableDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/client/whatsapp/documents/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-docs"] }),
  });
}
