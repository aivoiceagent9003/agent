// messages.ts — team messaging + notification data layer.
//
// React Query for history and lists; the WebSocket in realtime.ts for live
// updates. Incoming events patch the cache directly rather than triggering a
// refetch, so a message appears the instant it arrives.

import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { subscribeRealtime } from "./realtime";
import { playNotificationSound } from "./sound";

const isBrowser = typeof window !== "undefined";

export type ConversationKind = "team" | "direct" | "support";

export type Conversation = {
  id: string;
  kind: ConversationKind;
  title: string;
  member_count: number;
  members: { id: string; name: string; role: string }[];
  last_message: { body: string; created_at: string; from_me: boolean; is_system: boolean } | null;
  last_message_at: string;
  unread: number;
};

export type Message = {
  id: string;
  conversation_id?: string;
  sender_id: string | null;
  sender_name: string;
  is_system: boolean;
  body: string;
  created_at: string;
};

export type Teammate = {
  id: string;
  name: string;
  email: string;
  role: string;
  online: boolean;
};

export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

// ─── Conversations ───────────────────────────────────────────────────────────

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    enabled: isBrowser,
    queryFn: async (): Promise<{ conversations: Conversation[]; total_unread: number }> =>
      apiFetch("/api/client/messages"),
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ["messages", conversationId],
    enabled: isBrowser && !!conversationId,
    queryFn: async (): Promise<Message[]> => {
      const r = await apiFetch(`/api/client/messages/${conversationId}`);
      return r.messages || [];
    },
  });
}

export function useTeammates() {
  return useQuery({
    queryKey: ["teammates"],
    enabled: isBrowser,
    queryFn: async (): Promise<Teammate[]> => {
      const r = await apiFetch("/api/client/messages/people");
      return r.people || [];
    },
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: string; body: string }) =>
      apiFetch(`/api/client/messages/${conversationId}`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    // The realtime echo patches the cache, so no invalidate here — that would
    // cause the message to flicker out and back in.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

export function useOpenDirect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: string): Promise<string> => {
      const r = await apiFetch("/api/client/messages/direct", {
        method: "POST",
        body: JSON.stringify({ profile_id: profileId }),
      });
      return r.conversation_id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch(`/api/client/messages/${conversationId}/read`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

// ─── Notifications ───────────────────────────────────────────────────────────

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    enabled: isBrowser,
    queryFn: async (): Promise<{ notifications: AppNotification[]; unread: number }> =>
      apiFetch("/api/client/notifications"),
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      apiFetch("/api/client/notifications/read", {
        method: "POST",
        body: JSON.stringify({ ids: ids || null }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// ─── Live updates ────────────────────────────────────────────────────────────

/**
 * Subscribe the whole app to the realtime stream. Mount ONCE, in the shell.
 *
 * `activeConversationId` suppresses the chime for the thread you're already
 * looking at — a sound for a message visible on screen is pure annoyance.
 */
export function useRealtimeSync(activeConversationId?: string | null) {
  const qc = useQueryClient();
  // Kept in a ref so changing conversations doesn't tear down the subscription.
  const activeRef = useRef(activeConversationId);
  activeRef.current = activeConversationId;

  useEffect(() => {
    if (!isBrowser) return;

    return subscribeRealtime((event) => {
      if (event.type === "message") {
        const msg = event.message as Message;
        const convoId = msg.conversation_id;

        // Append to the open thread's cache if we have it.
        if (convoId) {
          qc.setQueryData<Message[]>(["messages", convoId], (old) => {
            if (!old) return old;
            if (old.some((m) => m.id === msg.id)) return old; // our own echo
            return [...old, msg];
          });
        }

        qc.invalidateQueries({ queryKey: ["conversations"] });

        // Chime only for other people's messages in threads you aren't reading.
        const isMine = msg.sender_id && msg.sender_id === currentUserId;
        const isActive = convoId && convoId === activeRef.current;
        if (!isMine && !isActive) playNotificationSound();
        return;
      }

      if (event.type === "notification") {
        qc.setQueryData<{ notifications: AppNotification[]; unread: number }>(
          ["notifications"],
          (old) =>
            old
              ? {
                  notifications: [event.notification, ...old.notifications],
                  unread: old.unread + 1,
                }
              : old,
        );
        qc.invalidateQueries({ queryKey: ["notifications"] });
        playNotificationSound();
      }
    });
  }, [qc]);
}

// The shell sets this once /me resolves, so the sync above can tell your own
// messages from everyone else's without threading the id through every call.
let currentUserId: string | null = null;
export function setCurrentUserId(id: string | null) {
  currentUserId = id;
}
