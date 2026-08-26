import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getToken } from "@/lib/api";
import { PortalShell, adminNav } from "@/components/portal/PortalShell";
import { useRequireAdmin } from "@/lib/use-auth";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin — Vocera" }] }),
  // Guarded here rather than in a useEffect. An effect cannot run until after the
  // first render, so an unauthenticated visitor already had the layout mounted and
  // its queries dispatched before anything redirected them. beforeLoad runs before
  // the route renders or loads at all.
  //
  // This is defence in depth, not the enforcement: the API is the real gate (every
  // router mounts requireClient/requireAdmin). A token in localStorage is only a
  // claim, and this code never trusts it for anything but deciding what to paint.
  beforeLoad: () => {
    // There is no localStorage during SSR, so the server cannot tell a signed-in
    // visitor from a signed-out one. Redirecting here would bounce EVERY
    // server-rendered request to the login page. The client re-checks on
    // hydration and on every subsequent navigation.
    if (typeof window === "undefined") return;
    if (!getToken()) throw redirect({ to: "/admin-login" });
  },
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
