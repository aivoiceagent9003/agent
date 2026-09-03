// /work/messages — team chat in the employee view.
//
// The panel itself is shared with the owner/manager dashboard (/app/messages), so
// both sides of a conversation are the same feature rather than two systems that
// happen to write to the same table.

import { createFileRoute } from "@tanstack/react-router";
import { MessagesPanel } from "@/components/portal/MessagesPanel";

export const Route = createFileRoute("/work/messages")({
  // ?c=<conversation id> — how a notification link opens one specific thread.
  validateSearch: (search: Record<string, unknown>): { c?: string } => ({
    c: typeof search.c === "string" ? search.c : undefined,
  }),
  head: () => ({ meta: [{ title: "Messages — AnswerLabs" }] }),
  component: WorkMessages,
});

function WorkMessages() {
  const { c } = Route.useSearch();

  return (
    <div className="h-screen">
      <MessagesPanel initialConversationId={c} />
    </div>
  );
}
