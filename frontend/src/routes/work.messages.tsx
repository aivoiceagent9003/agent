// /work/messages — team chat in the employee view.
//
// The panel itself is shared with the owner/manager dashboard (/app/messages), so
// both sides of a conversation are the same feature rather than two systems that
// happen to write to the same table.

import { createFileRoute } from "@tanstack/react-router";
import { MessagesPanel } from "@/components/portal/MessagesPanel";

export const Route = createFileRoute("/work/messages")({
  head: () => ({ meta: [{ title: "Messages — Vocera" }] }),
  component: WorkMessages,
});

function WorkMessages() {
  return (
    <div className="h-screen">
      <MessagesPanel />
    </div>
  );
}
