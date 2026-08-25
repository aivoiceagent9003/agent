import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { setSession, clearToken } from "@/lib/api";
import { login } from "@/lib/data";
import { toast } from "sonner";
import { Shield } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/admin-login")({
  head: () => ({ meta: [{ title: "Admin sign in — Vocera" }] }),
  component: AdminLogin,
});

function AdminLogin() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const email = String(fd.get("email"));
      const password = String(fd.get("password"));
      if (!email || !password) throw new Error("Email and password required");
      const session = await login(email, password);
      if (session.role !== "admin") {
        clearToken();
        throw new Error("This account is not an admin");
      }
      setSession(session);
      toast.success("Welcome, admin");
      navigate({ to: "/admin" });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-hero">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-8 shadow-card">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="w-4 h-4 text-primary" /> Admin portal
        </div>
        <h1 className="mt-2 text-2xl font-bold">Vocera Admin</h1>
        <form onSubmit={onSubmit} className="mt-6 grid gap-4">
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="Password"
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            disabled={loading}
            className="bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-xs text-muted-foreground text-center">
          <Link to="/" className="hover:text-foreground">
            ← Back to site
          </Link>
        </p>
      </div>
    </div>
  );
}
