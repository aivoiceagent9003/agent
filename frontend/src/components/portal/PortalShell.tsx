import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Phone, LayoutDashboard, PhoneCall, Users, LogOut, Shield, Settings } from "lucide-react";
import { clearToken } from "@/lib/api";
import type { ReactNode } from "react";

type NavItem = { to: string; label: string; icon: any };

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
  { to: "/app", label: "Overview", icon: LayoutDashboard },
  { to: "/app/calls", label: "Calls", icon: PhoneCall },
  { to: "/app/leads", label: "Leads", icon: Users },
];

export const adminNav: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/clients", label: "Clients", icon: Users },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];
