// EmployeeShell — the "EMPLOYEE VIEW" layout for front-line staff (tenant_role
// 'agent'). Deliberately narrow: Leads, Calls, Messages, Settings. No campaigns,
// no knowledge base, no agent configuration — those are owner/manager concerns and
// the API refuses them anyway (src/api/permissions.js).
//
// Owners and managers keep the full dashboard in PortalShell.

import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { Users, Phone, MessageSquare, Settings } from "lucide-react";
import { clearToken } from "@/lib/api";
import { closeRealtime } from "@/lib/realtime";
import { useConversations } from "@/lib/messages";
import type { Me } from "@/lib/team";
import { NotificationsPanel } from "./Notifications";
import { TopBar } from "./TopBar";
import { Logo } from "@/components/Brand";

const NAV = [
  { to: "/work/leads", label: "Leads", icon: Users },
  { to: "/work/calls", label: "Calls", icon: Phone },
  { to: "/work/messages", label: "Messages", icon: MessageSquare, badge: "messages" as const },
  { to: "/work/settings", label: "Settings", icon: Settings },
];

export function EmployeeShell({ me, children }: { me?: Me; children: ReactNode }) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: convos } = useConversations();
  const [bellOpen, setBellOpen] = useState(false);

  const unreadMessages = convos?.total_unread ?? 0;

  function logout() {
    closeRealtime(); // don't leave a socket open for the next person on this device
    clearToken();
    router.navigate({ to: "/login", search: { tab: "employee" } });
  }

  return (
    // The sidebar used to inherit the DOCUMENT's height (the wrapper is
    // min-h-screen), so Notifications and Sign out sat at the bottom of the page
    // and drifted with its length.
    //
    // `sticky top-0 h-screen` pins it to exactly one viewport instead.
    // Deliberately not a fixed-height shell with an internally-scrolling <main>:
    // that would move scrolling off the window and silently break the router's
    // scroll restoration. The top bar is sticky for the same reason.
    <div className="forest-portal min-h-screen flex">
      {/* No border: the rail and the top bar are one surface, and the only edge is
          the canvas's — see .forest-portal in styles.css. The brand row is the top
          bar's height so the logo sits level with the controls across from it. */}
      <aside className="sticky top-0 h-screen w-64 shrink-0 flex flex-col">
        <div className="h-14 px-5 shrink-0 flex items-center">
          <Link to="/work/leads" aria-label="AnswerLabs home">
            <Logo />
          </Link>
        </div>
        <p className="px-5 pt-3 pb-2 shrink-0 text-[11px] font-semibold tracking-wider text-muted-foreground">
          EMPLOYEE VIEW
        </p>

        {/* min-h-0 is what lets this shrink instead of pushing the footer off the
            bottom — a flex child won't go below its content size without it. */}
        <nav className="px-3 flex-1 min-h-0 overflow-y-auto space-y-1">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.to);
            const badge = item.badge === "messages" ? unreadMessages : 0;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
                  active
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
                {badge > 0 && (
                  <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-[11px] font-semibold grid place-items-center">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* The identity card that used to fill the foot of this rail (business,
          role, name, email) is in the top bar's account menu now, beside Sign out. */}
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          me={me}
          bell={{ open: bellOpen, onToggle: () => setBellOpen((v) => !v) }}
          onSignOut={logout}
        />
        <main className="flex-1 min-w-0">{children}</main>
      </div>

      {/* Rendered OUTSIDE the top bar on purpose — see the stacking-context note
          in Notifications.tsx. */}
      {bellOpen && <NotificationsPanel base="/work" onClose={() => setBellOpen(false)} />}
    </div>
  );
}
