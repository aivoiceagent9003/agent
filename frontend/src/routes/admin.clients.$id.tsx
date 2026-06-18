import { createFileRoute, Link } from "@tanstack/react-router";
import { useTenant, useUpdateTenant } from "@/lib/data";
import { ClientForm } from "@/components/portal/ClientForm";
import { KnowledgeBase } from "@/components/portal/KnowledgeBase";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/admin/clients/$id")({
  component: EditClient,
});

function EditClient() {
  const { id } = Route.useParams();
  const { data: tenant, isLoading } = useTenant(id);
  const updateTenant = useUpdateTenant(id);

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!tenant) {
    return <div className="p-8">Client not found. <Link to="/admin/clients" className="text-primary">Back</Link></div>;
  }
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link to="/admin/clients" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to clients
      </Link>
      <h1 className="text-3xl font-bold">{tenant.name}</h1>
      <p className="text-sm text-muted-foreground mt-1">{tenant.phone_number}</p>

      <section className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Configuration</h2>
        <ClientForm
          initial={{ name: tenant.name, phone_number: tenant.phone_number, ...tenant.config }}
          onSubmit={async (data) => {
            // Split the flat form back into top-level name/phone + nested config,
            // merging onto the existing config so unrelated keys aren't dropped.
            const { name, phone_number, ...config } = data;
            try {
              await updateTenant.mutateAsync({
                name,
                phone_number,
                config: { ...tenant.config, ...config },
              });
              toast.success("Client updated");
            } catch (e: any) {
              toast.error(e.message || "Could not update client");
            }
          }}
        />
      </section>

      <section className="mt-12">
        <h2 className="text-xl font-semibold mb-4">Knowledge base</h2>
        <KnowledgeBase tenantId={tenant.id} />
      </section>
    </div>
  );
}
