// /app/messages — team chat for owners and managers.
//
// Same panel the employee view mounts at /work/messages, so a manager and an agent
// are talking in one conversation rather than two parallel systems.

import { createFileRoute } from "@tanstack/react-router";
import { MessagesPanel } from "@/components/portal/MessagesPanel";

export const Route = createFileRoute("/app/messages")({
  // ?c=<conversation id> — how a notification link opens one specific thread.
  validateSearch: (search: Record<string, unknown>): { c?: string } => ({
    c: typeof search.c === "string" ? search.c : undefined,
  }),
  head: () => ({ meta: [{ title: "Messages — AnswerLabs" }] }),
  component: AppMessages,
});

function AppMessages() {
  const { c } = Route.useSearch();

  // The dashboard shell scrolls its main area; the panel manages its own internal
  // scrolling, so pin it to the viewport height.
  return (
    <div className="h-screen">
      <MessagesPanel initialConversationId={c} />
    </div>
  );
}
