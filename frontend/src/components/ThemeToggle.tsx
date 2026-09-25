// ThemeToggle — one control, every surface.
//
// This used to live inside components/site/SiteChrome.tsx, which meant the switch
// existed on the marketing site and nowhere else: the people who spend all day in the
// product — clients in /app, employees in /work — had no way to reach the dark theme at
// all. Moved here so the portals can use it without importing public-site chrome.
//
// The class on <html> is applied before first paint by the no-flash script in
// __root.tsx; this only handles explicit toggles. `dark` is read in an effect rather
// than during render because the server has no idea which theme the browser resolved,
// and guessing produces a hydration mismatch.

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { currentTheme, toggleTheme } from "@/lib/theme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(currentTheme() === "dark");
  }, []);
  return (
    <button
      type="button"
      aria-label="Toggle dark mode"
      title={dark ? "Switch to light" : "Switch to dark"}
      onClick={() => setDark(toggleTheme() === "dark")}
      className={
        className ||
        "grid place-items-center w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition"
      }
    >
      {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

/**
 * The same control wearing a sidebar row's clothes, so it sits beside "Sign out"
 * rather than looking like a button somebody dropped into the nav.
 */
export function ThemeToggleRow() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(currentTheme() === "dark");
  }, []);
  return (
    <button
      type="button"
      onClick={() => setDark(toggleTheme() === "dark")}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition"
    >
      {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
