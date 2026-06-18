import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/settings")({
  component: AdminSettings,
});

function AdminSettings() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold">Settings</h1>
      <p className="text-sm text-muted-foreground mt-1">Platform-wide configuration.</p>
      <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card text-sm text-muted-foreground">
        Settings UI placeholder — wire to your admin endpoints when ready.
      </div>
    </div>
  );
}
