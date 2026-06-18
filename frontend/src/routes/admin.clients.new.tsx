import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ClientForm } from "@/components/portal/ClientForm";
import { useCreateTenant } from "@/lib/data";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/clients/new")({
  component: NewClient,
});

function NewClient() {
  const navigate = useNavigate();
  const createTenant = useCreateTenant();
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold">Add client</h1>
      <p className="text-sm text-muted-foreground mt-1">Create a new tenant with its voice agent configuration.</p>
      <div className="mt-6">
        <ClientForm
          onSubmit={async (data) => {
            const { name, phone_number, ...config } = data;
            try {
              await createTenant.mutateAsync({ name, phone_number, config });
              toast.success("Client created");
              navigate({ to: "/admin/clients" });
            } catch (e: any) {
              toast.error(e.message || "Could not create client");
            }
          }}
        />
      </div>
    </div>
  );
}
