import { createFileRoute, Link } from "@tanstack/react-router";
import { useTenants } from "@/lib/data";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/admin/clients")({
  component: ClientsList,
});

function ClientsList() {
  const { data: tenants = [] } = useTenants();
  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Clients</h1>
          <p className="text-sm text-muted-foreground mt-1">{tenants.length} active clients.</p>
        </div>
        <Link to="/admin/clients/new" className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow hover:opacity-90">
          <Plus className="w-4 h-4" /> Add client
        </Link>
      </header>

      <div className="mt-6 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Name</th>
              <th className="text-left px-5 py-3 font-medium">Phone</th>
              <th className="text-left px-5 py-3 font-medium">Calls</th>
              <th className="text-left px-5 py-3 font-medium">Minutes</th>
              <th className="text-left px-5 py-3 font-medium">Leads</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tenants.map((t) => {
              return (
                <tr key={t.id} className="hover:bg-muted/30 transition">
                  <td className="px-5 py-3 font-medium">{t.name}</td>
                  <td className="px-5 py-3 text-muted-foreground">{t.phone_number}</td>
                  <td className="px-5 py-3">{t.stats.total_calls}</td>
                  <td className="px-5 py-3">{t.stats.total_minutes}</td>
                  <td className="px-5 py-3">{t.stats.total_leads}</td>
                  <td className="px-5 py-3 text-right">
                    <Link to="/admin/clients/$id" params={{ id: t.id }} className="text-primary hover:underline text-sm">Edit</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
