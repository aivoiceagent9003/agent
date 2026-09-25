// /app/leads/$id — thin wrapper. The page is components/portal/LeadDetail.tsx, shared with
// the other portal so the two can never drift apart.

import { createFileRoute } from "@tanstack/react-router";
import { LeadDetail } from "@/components/portal/LeadDetail";

export const Route = createFileRoute("/app/leads/$id")({
  head: () => ({ meta: [{ title: "Lead — AnswerLabs" }] }),
  component: Page,
});

function Page() {
  const { id } = Route.useParams();
  return <LeadDetail id={id} backTo="/app/leads" />;
}
