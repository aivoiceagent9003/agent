import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PortalShell, clientNav, navFor } from "@/components/portal/PortalShell";
import { useRequireAuth } from "@/lib/use-auth";
import { useMe } from "@/lib/team";
import { useRealtimeSync, setCurrentUserId } from "@/lib/messages";
import { primeSound } from "@/lib/sound";
import { Clock } from "lucide-react";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Dashboard — Vocera" }] }),
  component: AppLayout,
});

function AppLayout() {
  const ready = useRequireAuth();
  const navigate = useNavigate();
  // /me rather than /agent: every role may read it, and it carries the permission
  // list the navigation needs. Employees have no access to the agent config.
  const { data: me, isLoading } = useMe();

  // Messages and notifications arrive on any dashboard screen, not just /app/messages.
  useRealtimeSync(null);
  useEffect(() => { primeSound(); }, []);
  useEffect(() => { setCurrentUserId(me?.user_id ?? null); }, [me?.user_id]);

  // Front-line staff have their own, narrower shell.
  useEffect(() => {
    if (me && me.tenant_role === "agent") navigate({ to: "/work/leads" });
  }, [me, navigate]);

  const isOwner = me?.tenant_role === "owner";
  const setupIncomplete = !!me && !me.tenant.phone_number;

  // An owner whose agent isn't live used to be redirected straight into
  // /onboarding, with no way back and no sense of how much was left. The welcome
  // card on /app now owns that job: it shows the three steps, tracks which are
  // done, and offers the wizard as a button. Employees still can't finish setup —
  // that's the OWNER's to do — so they keep the "nothing to do yet" screen rather
  // than a wizard they have no permission to complete.

  if (!ready || isLoading) return null;
  if (me?.tenant_role === "agent") return null; // redirecting to /work

  if (setupIncomplete && !isOwner) return <SetupPending business={me?.tenant.business_name} />;

  return (
    <PortalShell kind="client" navItems={navFor(clientNav, me)}>
      <Outlet />
    </PortalShell>
  );
}

// What an invited employee sees when their business hasn't gone live yet. There is
// genuinely nothing for them to do — and nothing they are allowed to fix.
function SetupPending({ business }: { business?: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto">
          <Clock className="w-5 h-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-xl font-bold">Setup in progress</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {business ? <strong>{business}</strong> : "Your team"} hasn't finished connecting their
          phone number yet. Once the agent goes live, calls and leads will appear here
          automatically.
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          Nothing to do for now — check back shortly.
        </p>
      </div>
    </div>
  );
}
