// /reset-password — where Supabase's recovery email lands.
//
// Supabase verifies the emailed token on its side and redirects here with the
// session in the URL HASH (#access_token=…&type=recovery). We read it, post it to
// POST /api/auth/reset with the new password, and the backend applies the change.
//
// Reading from the hash matters: a fragment is never sent to a server or written
// to server access logs, unlike a query string. We also clear it from the address
// bar as soon as it's read, so the token doesn't linger in browser history.

import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BASE_URL } from "@/lib/api";
import { toast } from "sonner";
import { KeyRound, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Set a new password — Vocera" }] }),
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hash.get("access_token");
    if (token) {
      setAccessToken(token);
      // Drop the token from the URL so it isn't kept in history or shared by copy.
      window.history.replaceState(null, "", window.location.pathname);
    }
    setReady(true);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get("password"));
    const confirm = String(fd.get("confirm"));
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    if (password !== confirm) return toast.error("Those passwords don't match");

    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not reset your password");
      toast.success("Password updated — sign in with your new one");
      navigate({ to: "/login" });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!ready) return null;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-hero">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-8 shadow-card">
        {!accessToken ? (
          <>
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4" /> Link expired
            </div>
            <h1 className="mt-2 text-2xl font-bold">This link isn't valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Reset links can only be used once and expire after an hour.
            </p>
            <Link
              to="/forgot-password"
              className="mt-6 inline-block text-sm text-primary hover:underline"
            >
              Request a new link
            </Link>
          </>
        ) : (
          <>
            <div className="w-11 h-11 rounded-xl bg-primary/15 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">Set a new password</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose something at least 8 characters long.
            </p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4">
              <input
                name="password"
                type="password"
                required
                autoComplete="new-password"
                placeholder="New password"
                className="bg-input border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
                placeholder="Confirm new password"
                className="bg-input border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                disabled={loading}
                className="bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow disabled:opacity-60"
              >
                {loading ? "Saving…" : "Update password"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
