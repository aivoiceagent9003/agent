import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PortalShell, adminNav } from "@/components/portal/PortalShell";
import { useRequireAdmin } from "@/lib/use-auth";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin — Vocera" }] }),
  component: AdminLayout,
});

function AdminLayout() {
  const ready = useRequireAdmin();
  if (!ready) return null;
  return (
    <PortalShell kind="admin" navItems={adminNav}>
      <Outlet />
    </PortalShell>
  );
}
