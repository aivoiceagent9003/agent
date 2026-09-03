// EmployeeShell — the "EMPLOYEE VIEW" layout for front-line staff (tenant_role
// 'agent'). Deliberately narrow: Leads, Calls, Messages, Settings. No campaigns,
// no knowledge base, no agent configuration — those are owner/manager concerns and
// the API refuses them anyway (src/api/permissions.js).
//
// Owners and managers keep the full dashboard in PortalShell.

import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { Users, Phone, MessageSquare, Settings, Building2, LogOut, Activity } from "lucide-react";
import { clearToken } from "@/lib/api";
import { closeRealtime } from "@/lib/realtime";
import { useConversations } from "@/lib/messages";
import { ROLE_LABEL, type Me } from "@/lib/team";
import { NotificationsButton, NotificationsPanel } from "./Notifications";

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
    // scroll restoration.
    <div className="min-h-screen flex bg-background">
      <aside className="sticky top-0 h-screen w-64 shrink-0 border-r border-border flex flex-col">
        <div className="p-5 shrink-0">
          <Link to="/work/leads" className="flex items-center gap-2 font-display font-bold text-lg">
            <div className="w-8 h-8 rounded-lg bg-gradient-primary grid place-items-center shadow-glow">
              <Activity className="w-4 h-4 text-primary-foreground" />
            </div>
            AnswerLabs
          </Link>
          <p className="mt-2 text-[11px] font-semibold tracking-wider text-muted-foreground">
            EMPLOYEE VIEW
          </p>
        </div>

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

        <div className="px-3 pb-3 shrink-0">
          <NotificationsButton
            open={bellOpen}
            onToggle={() => setBellOpen((v) => !v)}
            className={
              bellOpen
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }
          />
        </div>

        <div className="p-3 shrink-0 border-t border-border space-y-3">
          <div className="rounded-lg bg-muted/60 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="truncate">{me?.tenant.business_name || "Your business"}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Viewing as {me ? ROLE_LABEL[me.tenant_role] : "—"}
            </p>
          </div>

          <div className="flex items-center gap-2 px-1">
            <div className="w-8 h-8 rounded-full bg-primary grid place-items-center text-primary-foreground text-xs font-semibold shrink-0">
              {(me?.full_name || me?.email || "?")
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0]?.toUpperCase())
                .join("")}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{me?.full_name || "You"}</p>
              <p className="text-xs text-muted-foreground truncate">{me?.email}</p>
            </div>
          </div>

          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>

      {/* Rendered OUTSIDE the sidebar on purpose. `position: sticky` creates a
          stacking context, so while this lived inside <aside> its z-50 was scoped
          to the rail and could never rise above <main> — the panel came out
          underneath the page content. As a sibling of <main> it sits in the root
          stacking context and z-50 means what it says. */}
      {bellOpen && <NotificationsPanel base="/work" onClose={() => setBellOpen(false)} />}
    </div>
  );
}
