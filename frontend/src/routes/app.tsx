import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PortalShell, clientNav } from "@/components/portal/PortalShell";
import { useRequireAuth } from "@/lib/use-auth";
import { useAgent } from "@/lib/data";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Dashboard — Vocera" }] }),
  component: AppLayout,
});

function AppLayout() {
  const ready = useRequireAuth();
  const navigate = useNavigate();
  const { data: agent, isLoading } = useAgent();

  // A client whose agent has no number to automate yet hasn't finished setup —
  // send them to onboarding before they can use the dashboard.
  const needsOnboarding = !!agent && !agent.phone_number;
  useEffect(() => {
    if (ready && needsOnboarding) navigate({ to: "/onboarding" });
  }, [ready, needsOnboarding, navigate]);

  if (!ready || isLoading) return null;
  if (needsOnboarding) return null; // redirecting to onboarding
  return (
    <PortalShell kind="client" navItems={clientNav}>
      <Outlet />
    </PortalShell>
  );
}
