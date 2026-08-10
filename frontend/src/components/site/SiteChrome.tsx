import { Link } from "@tanstack/react-router";
import { Phone, Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";
import { currentTheme, toggleTheme } from "@/lib/theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  // Read the class the no-flash script already applied (avoids a hydration mismatch).
  useEffect(() => { setDark(currentTheme() === "dark"); }, []);
  return (
    <button
      type="button"
      aria-label="Toggle dark mode"
      title={dark ? "Switch to light" : "Switch to dark"}
      onClick={() => setDark(toggleTheme() === "dark")}
      className="grid place-items-center w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground transition"
    >
      {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

export function SiteNav() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-lg bg-background/70 border-b border-border">
      <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-display font-bold text-lg">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            <Phone className="w-4 h-4 text-primary-foreground" />
          </div>
          Vocera
        </Link>
        <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
          <a href="#features" className="hover:text-foreground transition">Features</a>
          <a href="#how" className="hover:text-foreground transition">How it works</a>
          <a href="#demos" className="hover:text-foreground transition">Demos</a>
          <a href="#pricing" className="hover:text-foreground transition">Pricing</a>
          <a href="#contact" className="hover:text-foreground transition">Contact</a>
        </nav>
        <div className="flex items-center gap-2">
          <a href="#contact" className="hidden sm:inline text-sm text-muted-foreground hover:text-foreground transition px-3 py-2">Book a demo</a>
          <ThemeToggle />
          <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground transition px-3 py-2">Sign in</Link>
          <Link to="/signup" className="text-sm font-medium bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 shadow-glow hover:opacity-90 transition">Sign up</Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="mx-auto max-w-7xl px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-primary" />
          <span>© {new Date().getFullYear()} Vocera. All rights reserved.</span>
        </div>
        <div className="flex gap-6">
          <Link to="/signup" className="hover:text-foreground">Sign up</Link>
          <Link to="/login" className="hover:text-foreground">Client login</Link>
          <Link to="/admin-login" className="hover:text-foreground">Admin</Link>
        </div>
      </div>
    </footer>
  );
}
