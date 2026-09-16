import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Phone,
  LayoutDashboard,
  PhoneCall,
  Users,
  LogOut,
  Shield,
  Settings,
  BookOpen,
  Database,
  Activity,
  Radio,
  Gauge,
  Server,
  ShieldAlert,
  TrendingUp,
  Sparkles,
  BellRing,
  Megaphone,
  Zap,
  MessageCircle,
  MessageSquare,
  UsersRound,
  LineChart,
  LifeBuoy,
} from "lucide-react";
import { clearToken } from "@/lib/api";
import { closeRealtime } from "@/lib/realtime";
import { useState } from "react";
import type { ReactNode } from "react";
import type { Me } from "@/lib/team";
import { useAwaitingReplyCount } from "@/lib/support";
import { useConversations } from "@/lib/messages";
import { NotificationsButton, NotificationsPanel } from "./Notifications";

// `perm` is the permission a user must hold for the item to appear. Items without
// one are visible to every signed-in member. Hiding nav is cosmetic — the backend
// middleware (src/api/permissions.js) is what actually enforces access.
type NavItem = {
  to: string;
  label: string;
  icon: any;
  perm?: string;
  /** Optional hook returning a count to show as a badge. Named "use…" because it
   *  is a hook and must obey the rules of hooks — see NavLink below. */
  useBadge?: () => number;
};

export function PortalShell({
  kind,
  navItems,
  children,
}: {
  kind: "client" | "admin";
  navItems: NavItem[];
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [bellOpen, setBellOpen] = useState(false);

  // Admins have no tenant profile, so /api/client/notifications is not theirs to
  // call. Not rendering the bell is what keeps its hooks from running at all.
  const showBell = kind === "client";

  function logout() {
    // Matches EmployeeShell: don't leave a live socket open for whoever signs in
    // next on this device. clearToken() also wipes the query cache (lib/api).
    closeRealtime();
    clearToken();
    router.navigate({ to: "/" });
  }

  // The sidebar used to inherit the DOCUMENT's height (the wrapper is
  // min-h-screen), so "Sign out" sat at the bottom of the page and drifted
  // further down the longer the page got.
  //
  // `sticky top-0 h-screen` pins it to exactly one viewport instead. Deliberately
  // not a fixed-height shell with an internally-scrolling <main>: that would move
  // scrolling off the window and silently break the router's scroll restoration.
  return (
    <div className="forest-portal min-h-screen flex">
      <aside className="sticky top-0 h-screen w-64 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-6 shrink-0 flex items-center gap-2 font-display font-bold">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            {kind === "admin" ? (
              <Shield className="w-4 h-4 text-primary-foreground" />
            ) : (
              <Phone className="w-4 h-4 text-primary-foreground" />
            )}
          </div>
          AnswerLabs{" "}
          {kind === "admin" && (
            <span className="text-xs font-normal text-muted-foreground">Admin</span>
          )}
        </div>
        {/* min-h-0 is what lets this shrink instead of pushing the footer off the
            bottom — a flex child won't go below its content size without it. */}
        <nav className="px-3 flex-1 min-h-0 overflow-y-auto space-y-1">
          {navItems.map((item) => (
            <NavLink key={item.to} item={item} pathname={pathname} />
          ))}
        </nav>
        {showBell && (
          <div className="px-3 pb-3 shrink-0">
            <NotificationsButton
              open={bellOpen}
              onToggle={() => setBellOpen((v) => !v)}
              className={
                bellOpen
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
              }
            />
          </div>
        )}

        <div className="p-3 shrink-0 border-t border-sidebar-border">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>

      {/* Sibling of <main>, not of the nav — see the stacking-context note in
          Notifications.tsx. */}
      {showBell && bellOpen && (
        <NotificationsPanel base="/app" onClose={() => setBellOpen(false)} />
      )}
    </div>
  );
}

export const clientNav: NavItem[] = [
  { to: "/app", label: "Home", icon: LayoutDashboard, perm: "calls:read" },
  { to: "/app/calls", label: "Calls", icon: PhoneCall, perm: "calls:read" },
  { to: "/app/campaigns", label: "Campaigns", icon: Megaphone, perm: "campaigns:read" },
  { to: "/app/instant", label: "Instant Calls", icon: Zap, perm: "campaigns:read" },
  { to: "/app/leads", label: "Leads", icon: Users, perm: "leads:read" },
  // Was "Overview" on /app. The front door is now Home; the numbers live here.
  { to: "/app/analytics", label: "Analytics", icon: LineChart, perm: "calls:read" },
  // No perm: messaging is open to every member of a business — a manager needs to
  // reach their agents regardless of what else they can see.
  { to: "/app/messages", label: "Messages", icon: MessageSquare, useBadge: useMessagesUnread },
  { to: "/app/knowledge", label: "Knowledge", icon: BookOpen, perm: "knowledge:read" },
  // The live per-caller data the agent reads out. Same permission as Knowledge:
  // both are "keep what the agent says accurate", which is a manager's job.
  { to: "/app/data", label: "Live data", icon: Database, perm: "knowledge:read" },
  { to: "/app/whatsapp", label: "WhatsApp", icon: MessageCircle, perm: "whatsapp:read" },
  { to: "/app/team", label: "Team", icon: UsersRound, perm: "team:manage" },
  { to: "/onboarding", label: "Agent settings", icon: Settings, perm: "agent:write" },
];

// Unread direct + group messages, for the nav badge. Mirrors the employee shell,
// which has carried this badge since messaging shipped.
function useMessagesUnread() {
  return useConversations().data?.total_unread ?? 0;
}

// Filter a nav list down to what this member may actually open. Called with
// `undefined` while /me is still loading, in which case nothing is shown yet —
// better than flashing links that vanish a moment later.
export function navFor(items: NavItem[], me: Me | undefined): NavItem[] {
  if (!me) return [];
  // 'team:manage' is not a backend permission — the Team page is owner-only, and
  // every action on it is guarded by requireOwner(). Treat it as an owner check.
  return items.filter((item) => {
    if (!item.perm) return true;
    if (item.perm === "team:manage") return me.tenant_role === "owner";
    return me.permissions.includes(item.perm);
  });
}

// One nav row. Split out of the map so item.useBadge() is called from a
// component body rather than inside a loop — calling it in the map would break the
// rules of hooks the moment two items had different badge hooks.
function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const badge = item.useBadge?.() ?? 0;
  const active =
    pathname === item.to ||
    (item.to !== "/app" && item.to !== "/admin" && pathname.startsWith(item.to));
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === "/app" || item.to === "/admin" }}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
      }`}
    >
      <item.icon className="w-4 h-4" />
      <span className="flex-1">{item.label}</span>
      {badge > 0 && (
        <span className="shrink-0 min-w-5 text-center text-[11px] font-semibold rounded-full px-1.5 py-0.5 bg-primary text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

export const adminNav: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/clients", label: "Clients", icon: Users },
  { to: "/admin/support", label: "Support", icon: LifeBuoy, useBadge: useAwaitingReplyCount },
  { to: "/admin/ops", label: "Operations", icon: Activity },
  { to: "/admin/ops/live", label: "Live Calls", icon: Radio },
  { to: "/admin/ops/latency", label: "Latency", icon: Gauge },
  { to: "/admin/ops/services", label: "Services", icon: Server },
  { to: "/admin/ops/errors", label: "Errors", icon: ShieldAlert },
  { to: "/admin/ops/alerts", label: "Alerts", icon: BellRing },
  { to: "/admin/ops/quality", label: "AI Quality", icon: Sparkles },
  { to: "/admin/ops/business", label: "Business", icon: TrendingUp },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];
