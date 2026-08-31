// theme.ts — light/dark switching. The dark palette already exists in styles.css
// under the `.dark` class; this just toggles that class on <html> and remembers the
// choice. A no-flash init script in __root.tsx applies the saved/system theme before
// first paint, so this module only handles explicit toggles at runtime.

const KEY = "vocera-theme";
export type Theme = "light" | "dark";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
