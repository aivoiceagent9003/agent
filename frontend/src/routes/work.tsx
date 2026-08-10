// /work — the employee view layout.
//
// Front-line staff (tenant_role 'agent') live here. Owners and managers are sent to
// /app instead, so nobody has two competing homes.
//
// This is also where the app-wide realtime subscription is mounted, so messages and
// notifications arrive (and chime) on any employee screen, not just Messages.

import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EmployeeShell } from "@/components/portal/EmployeeShell";
import { useRequireAuth } from "@/lib/use-auth";
import { useMe } from "@/lib/team";
import { useRealtimeSync, setCurrentUserId } from "@/lib/messages";
import { primeSound } from "@/lib/sound";
import { Clock } from "lucide-react";

export const Route = createFileRoute("/work")({
  head: () => ({ meta: [{ title: "Vocera — Employee" }] }),
  component: WorkLayout,
});

function WorkLayout() {
  const ready = useRequireAuth();
  const navigate = useNavigate();
  const { data: me, isLoading } = useMe();

  // Muted while you're looking at the thread the message arrived in.
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  useRealtimeSync(activeConversation);

  useEffect(() => {
    primeSound();
  }, []);

  useEffect(() => {
    setCurrentUserId(me?.user_id ?? null);
  }, [me?.user_id]);

  // Owners and managers get the full dashboard.
  useEffect(() => {
    if (me && me.tenant_role !== "agent") navigate({ to: "/app" });
  }, [me, navigate]);

  if (!ready || isLoading) return null;
  if (me && me.tenant_role !== "agent") return null; // redirecting

  // Same guard as /app: an employee can't finish setup, so don't strand them in it.
  if (me && !me.tenant.phone_number) {
    return (
      <EmployeeShell me={me}>
        <div className="min-h-screen grid place-items-center px-4">
          <div className="max-w-md text-center">
            <div className="w-12 h-12 rounded-xl bg-muted grid place-items-center mx-auto">
              <Clock className="w-5 h-5 text-muted-foreground" />
            </div>
            <h1 className="mt-4 text-xl font-bold">Setup in progress</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {me.tenant.business_name || "Your team"} hasn't finished connecting their phone
              number yet. Once the agent goes live, calls and leads appear here automatically.
            </p>
          </div>
        </div>
      </EmployeeShell>
    );
  }

  return (
    <EmployeeShell me={me}>
      <Outlet />
    </EmployeeShell>
  );
}

// Shared by the child routes so they can mute the chime for the open thread.
export { };
