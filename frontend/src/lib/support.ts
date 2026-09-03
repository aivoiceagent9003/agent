// support.ts — admin-side data layer for customer support threads.
//
// The customer half of this already existed: businesses have had a "AnswerLabs
// Support" thread in their Messages page since the messaging feature shipped, and
// the backend endpoints to answer it were built too. Nothing ever read them, so
// every message a customer sent went into a thread no one could open.
//
// Addressed by conversation id rather than by membership: AnswerLabs staff are not
// members of the conversation, which is why this can't reuse the client messages
// layer.
//
// Threads are PER PERSON, not per business, so one company can appear in this
// inbox several times — hence person_name on every row.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import type { Message } from "./messages";

export type SupportThread = {
  conversation_id: string;
  tenant_id: string;
  business_name: string;
  /** Whose thread this is. Null only for a legacy thread nobody has claimed. */
  person_name: string | null;
  person_role: string | null;
  last_message_at: string;
  last_message: string | null;
  /** Last message came from the customer, so nobody has answered it yet. */
  awaiting_reply: boolean;
};

export type SupportThreadDetail = {
  business_name: string | null;
  tenant_id: string;
  person_name: string | null;
  person_role: string | null;
  messages: Message[];
};

/**
 * Every support thread, most recently active first.
 *
 * Polled rather than pushed: the admin realtime socket carries telemetry, and
 * staff are not conversation members so they receive no message events. A short
 * interval is the honest fix until support threads are added to that feed.
 */
export function useSupportThreads() {
  return useQuery({
    queryKey: ["admin", "support"],
    queryFn: () =>
      apiFetch<{ threads: SupportThread[] }>("/api/admin/support").then((r) => r.threads),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

/** Count of threads waiting on a reply — drives the nav badge. */
export function useAwaitingReplyCount() {
  const { data: threads } = useSupportThreads();
  return threads?.filter((t) => t.awaiting_reply).length ?? 0;
}

export function useSupportThread(conversationId: string | null) {
  return useQuery({
    queryKey: ["admin", "support", conversationId],
    queryFn: () => apiFetch<SupportThreadDetail>(`/api/admin/support/${conversationId}`),
    enabled: !!conversationId,
    refetchInterval: 15_000,
  });
}

export function useSendSupportReply(conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ message: Message }>(`/api/admin/support/${conversationId}`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    onSuccess: ({ message }) => {
      // Append to the open thread so the reply lands immediately, then refresh
      // the list so the preview line and awaiting_reply flag catch up.
      qc.setQueryData<SupportThreadDetail>(["admin", "support", conversationId], (prev) =>
        prev ? { ...prev, messages: [...prev.messages, message] } : prev,
      );
      qc.invalidateQueries({ queryKey: ["admin", "support"] });
    },
  });
}
