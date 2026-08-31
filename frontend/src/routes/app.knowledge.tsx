import { createFileRoute } from "@tanstack/react-router";
import { KnowledgeManager } from "@/components/portal/KnowledgeManager";

export const Route = createFileRoute("/app/knowledge")({
  head: () => ({ meta: [{ title: "Knowledge — Vocera" }] }),
  component: KnowledgePage,
});

function KnowledgePage() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold">Knowledge</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Files your agent answers from. Upload, download, or delete them any time — deleting a file
          removes its knowledge from the agent.
        </p>
      </header>
      <div className="mt-6">
        <KnowledgeManager />
      </div>
    </div>
  );
}
