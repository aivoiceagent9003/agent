// Notifications — the bell feed, shared by both dashboard shells.
//
// This used to live inside EmployeeShell, which meant owners and managers had no
// bell at all: their notifications were written to the database and then had
// nowhere to appear. Both shells use the same 16rem sticky rail, so the geometry
// carries over unchanged.
//
// Split into a button and a panel ON PURPOSE. `position: sticky` on <aside>
// creates a stacking context, so a z-50 popover rendered inside the rail can never
// rise above <main>. The button goes in the sidebar; the panel must be mounted as
// a sibling of <main>, where z-50 means what it says.

import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Bell, X } from "lucide-react";
import { useNotifications, useMarkNotificationsRead } from "@/lib/messages";
import { soundEnabled, setSoundEnabled, playNotificationSound } from "@/lib/sound";

/** The route prefix of the shell doing the reading. */
export type ShellBase = "/work" | "/app";

/**
 * Notification links are stored SHELL-RELATIVE ("/leads", "/messages?c=…") by
 * src/services/notifications.js: one event notifies several people at once, and an
 * owner and an agent read it in different shells. The reader's own shell supplies
 * the prefix here, at click time.
 *
 * Anything that is not a plain in-app path resolves to null and renders as a
 * non-clickable row, so a malformed link is inert rather than a navigation to
 * somewhere unexpected.
 */
function resolveLink(base: ShellBase, link: string | null): string | null {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return null;
  return `${base}${link}`;
}

/** The sidebar row. `className` carries the shell's own hover/active treatment. */
export function NotificationsButton({
  open,
  onToggle,
  className = "",
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { data } = useNotifications();
  const unread = data?.unread ?? 0;

  return (
    <button
      aria-expanded={open}
      onClick={onToggle}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${className}`}
    >
      <span className="relative">
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-2 -right-2 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold grid place-items-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </span>
      Notifications
    </button>
  );
}

/**
 * Popover anchored to the right of the sidebar, level with the bell.
 *
 * It used to render inline in the sidebar column, which meant a 16rem-wide panel
 * and — on a short window — pushing Sign out off the bottom. Floating it clear of
 * the rail gives it room and leaves the sidebar's own layout alone.
 */
export function NotificationsPanel({ base, onClose }: { base: ShellBase; onClose: () => void }) {
  const router = useRouter();
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

  // Opening a notification is also reading it: mark that one row, close, and go to
  // whatever it is about. Marking only this id rather than everything leaves the
  // rest of the feed unread, which is the whole point of a per-row link.
  function open(id: string, href: string) {
    markRead.mutate([id]);
    onClose();
    router.navigate({ href });
  }

  return (
    <>
      {/* A real backdrop, not a document click listener. Listening for outside
          clicks closed the panel but let the SAME click land on whatever was
          underneath — so dismissing it opened a lead. This swallows the click. */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />

      {/* Sits just clear of the 16rem rail, bottom-aligned with the bell that
          opened it. Fixed, so page scroll cannot drag it away.

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
              items.slice(0, 12).map((n) => {
                const href = resolveLink(base, n.link);
                const row = `w-full text-left px-3 py-2 border-b border-border last:border-0 ${
                  n.read_at ? "opacity-60" : "bg-primary/5"
                }`;
                const inner = (
                  <>
                    <p className="text-xs font-medium">{n.title}</p>
                    {n.body && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                  </>
                );

                return href ? (
                  <button
                    key={n.id}
                    onClick={() => open(n.id, href)}
                    className={`${row} hover:bg-muted transition`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div key={n.id} className={row}>
                    {inner}
                  </div>
                );
              })
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
