import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { setToken } from "@/lib/api";
import { login } from "@/lib/data";
import { toast } from "sonner";
import { Phone } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Vocera" }] }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email"));
    const password = String(fd.get("password"));
    try {
      if (!email || !password) throw new Error("Email and password required");
      const { token } = await login(email, password);
      setToken(token);
      toast.success("Welcome back!");
      navigate({ to: "/app" });
    } catch (err: any) {
      toast.error(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between p-12 bg-gradient-hero relative overflow-hidden">
        <Link to="/" className="flex items-center gap-2 font-display font-bold text-lg z-10">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            <Phone className="w-4 h-4 text-primary-foreground" />
          </div>
          Vocera
        </Link>
        <div className="z-10">
          <p className="text-2xl font-display max-w-md leading-snug">
            "Vocera handles every after-hours call so our agents only deal with qualified leads."
          </p>
          <p className="mt-4 text-sm text-muted-foreground">— Sunrise Realty</p>
        </div>
        <div className="absolute -bottom-32 -right-32 w-[500px] h-[500px] rounded-full bg-primary/30 blur-3xl" />
      </div>
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-bold">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">Access your client dashboard.</p>
          <form onSubmit={onSubmit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">Email</label>
              <input name="email" type="email" required className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">Password</label>
              <input name="password" type="password" required className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <button disabled={loading} className="mt-2 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow hover:opacity-90 transition disabled:opacity-60">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="mt-6 text-sm text-muted-foreground text-center">
            New to Vocera? <Link to="/signup" className="text-primary hover:underline">Create an account</Link>
          </p>
          <p className="mt-2 text-xs text-muted-foreground text-center">
            Admin? <Link to="/admin-login" className="text-primary hover:underline">Sign in here</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
