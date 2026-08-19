// EmployeeShell — the "EMPLOYEE VIEW" layout for front-line staff (tenant_role
// 'agent'). Deliberately narrow: Leads, Calls, Messages, Settings. No campaigns,
// no knowledge base, no agent configuration — those are owner/manager concerns and
// the API refuses them anyway (src/api/permissions.js).
//
// Owners and managers keep the full dashboard in PortalShell.

import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Users,
  Phone,
  MessageSquare,
  Settings,
  Bell,
  Building2,
  LogOut,
  Activity,
  X,
} from "lucide-react";
import { clearToken } from "@/lib/api";
import { closeRealtime } from "@/lib/realtime";
import { useConversations, useNotifications, useMarkNotificationsRead } from "@/lib/messages";
import { ROLE_LABEL, type Me } from "@/lib/team";
import { soundEnabled, setSoundEnabled, playNotificationSound } from "@/lib/sound";

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
            Vocera
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
          <button
            aria-expanded={bellOpen}
            onClick={() => setBellOpen((v) => !v)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
              bellOpen
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <NotificationBell />
            Notifications
          </button>
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
      {bellOpen && <NotificationList onClose={() => setBellOpen(false)} />}
    </div>
  );
}

function NotificationBell() {
  const { data } = useNotifications();
  const unread = data?.unread ?? 0;
  return (
    <span className="relative">
      <Bell className="w-4 h-4" />
      {unread > 0 && (
        <span className="absolute -top-2 -right-2 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold grid place-items-center">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </span>
  );
}

/**
 * Popover anchored to the right of the sidebar, level with the bell.
 *
 * It used to render inline in the sidebar column, which meant a 16rem-wide panel
 * and — on a short window — pushing Sign out off the bottom. Floating it clear of
 * the rail gives it room and leaves the sidebar's own layout alone.
 */
function NotificationList({ onClose }: { onClose: () => void }) {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const [sound, setSound] = useState(soundEnabled());
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = data?.notifications ?? [];

  return (
    <>
      {/* A real backdrop, not a document click listener. Listening for outside
          clicks closed the panel but let the SAME click land on whatever was
          underneath — so dismissing it opened a lead. This swallows the click. */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />

      {/* Sits just clear of the 16rem rail, bottom-aligned with the bell that
          opened it. Fixed, so page scroll can't drag it away.

          bg-background (a solid token) rather than bg-popover, which carries alpha
          in the dark theme — floating over page content that read as frosted glass
          and the text was unreadable. The themed tint moves to the inner layer,
          where it has something opaque behind it. */}
      <div
        role="dialog"
        aria-label="Notifications"
        className="fixed z-50 bottom-4 left-[16.75rem] w-80 max-w-[calc(100vw-18rem)] rounded-xl border border-border bg-background text-popover-foreground shadow-glow overflow-hidden animate-fade-up"
      >
        <div className="bg-popover">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border">
            <span className="text-xs font-semibold">Notifications</span>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <button
                  onClick={() => markRead.mutate(undefined)}
                  className="text-xs text-primary hover:underline"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={onClose}
                aria-label="Close notifications"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-xs text-muted-foreground text-center">Nothing new.</p>
            ) : (
              items.slice(0, 12).map((n) => (
                <div
                  key={n.id}
                  className={`px-3 py-2 border-b border-border last:border-0 ${
                    n.read_at ? "opacity-60" : "bg-primary/5"
                  }`}
                >
                  <p className="text-xs font-medium">{n.title}</p>
                  {n.body && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Sound is a per-device preference, so it belongs next to the bell
              rather than in account settings that follow you to another machine. */}
          <label className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border text-xs">
            <span className="text-muted-foreground">Alert sound</span>
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => {
                setSound(e.target.checked);
                setSoundEnabled(e.target.checked);
                if (e.target.checked) playNotificationSound(); // confirm it audibly
              }}
              className="accent-current"
            />
          </label>
        </div>
      </div>
    </>
  );
}
