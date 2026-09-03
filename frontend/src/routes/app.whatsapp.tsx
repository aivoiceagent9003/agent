import { createFileRoute } from "@tanstack/react-router";
import { WhatsAppSettings } from "@/components/portal/WhatsAppSettings";

export const Route = createFileRoute("/app/whatsapp")({
  head: () => ({ meta: [{ title: "WhatsApp — AnswerLabs" }] }),
  component: WhatsAppPage,
});

function WhatsAppPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold">WhatsApp</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Files your agent sends to customers, and how your business appears in those messages.
        </p>
      </header>
      <div className="mt-6">
        <WhatsAppSettings />
      </div>
    </div>
  );
}
