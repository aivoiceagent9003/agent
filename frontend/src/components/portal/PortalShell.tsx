import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Phone, LayoutDashboard, PhoneCall, Users, LogOut, Shield, Settings, BookOpen, Activity, Radio, Gauge, Server, ShieldAlert, TrendingUp, Sparkles, BellRing, Megaphone, Zap, MessageCircle, MessageSquare, UsersRound } from "lucide-react";
import { clearToken } from "@/lib/api";
import type { ReactNode } from "react";
import type { Me } from "@/lib/team";

// `perm` is the permission a user must hold for the item to appear. Items without
// one are visible to every signed-in member. Hiding nav is cosmetic — the backend
// middleware (src/api/permissions.js) is what actually enforces access.
type NavItem = { to: string; label: string; icon: any; perm?: string };

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

  function logout() {
    clearToken();
    router.navigate({ to: "/" });
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-6 flex items-center gap-2 font-display font-bold">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            {kind === "admin" ? <Shield className="w-4 h-4 text-primary-foreground" /> : <Phone className="w-4 h-4 text-primary-foreground" />}
          </div>
          Vocera {kind === "admin" && <span className="text-xs font-normal text-muted-foreground">Admin</span>}
        </div>
        <nav className="px-3 flex-1 space-y-1">
          {navItems.map((item) => {
            const active = pathname === item.to || (item.to !== "/app" && item.to !== "/admin" && pathname.startsWith(item.to));
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}

export const clientNav: NavItem[] = [
  { to: "/app", label: "Overview", icon: LayoutDashboard, perm: "calls:read" },
  { to: "/app/calls", label: "Calls", icon: PhoneCall, perm: "calls:read" },
  { to: "/app/campaigns", label: "Campaigns", icon: Megaphone, perm: "campaigns:read" },
  { to: "/app/instant", label: "Instant Calls", icon: Zap, perm: "campaigns:read" },
  { to: "/app/leads", label: "Leads", icon: Users, perm: "leads:read" },
  // No perm: messaging is open to every member of a business — a manager needs to
  // reach their agents regardless of what else they can see.
  { to: "/app/messages", label: "Messages", icon: MessageSquare },
  { to: "/app/knowledge", label: "Knowledge", icon: BookOpen, perm: "knowledge:read" },
  { to: "/app/whatsapp", label: "WhatsApp", icon: MessageCircle, perm: "whatsapp:read" },
  { to: "/app/team", label: "Team", icon: UsersRound, perm: "team:manage" },
  { to: "/onboarding", label: "Agent settings", icon: Settings, perm: "agent:write" },
];

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

export const adminNav: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/clients", label: "Clients", icon: Users },
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
