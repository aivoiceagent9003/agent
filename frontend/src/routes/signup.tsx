import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { setToken } from "@/lib/api";
import { signup, login } from "@/lib/data";
import { toast } from "sonner";
import { Phone } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Create your account — Vocera" }] }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const business_name = String(fd.get("business_name"));
    const email = String(fd.get("email"));
    const password = String(fd.get("password"));
    try {
      if (!business_name || !email || !password) throw new Error("All fields are required");
      await signup(email, password, business_name);
      // Account is created with email already confirmed, so log straight in
      // and send them into onboarding to configure their agent.
      try {
        const { token } = await login(email, password);
        setToken(token);
        toast.success("Welcome to Vocera!");
        navigate({ to: "/onboarding" });
      } catch {
        toast.success("Account created — please sign in.");
        navigate({ to: "/login" });
      }
    } catch (err: any) {
      toast.error(err.message || "Could not create account");
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
            "Set up your AI voice agent in minutes — it answers every call and captures every lead."
          </p>
          <p className="mt-4 text-sm text-muted-foreground">— Get started free</p>
        </div>
        <div className="absolute -bottom-32 -right-32 w-[500px] h-[500px] rounded-full bg-primary/30 blur-3xl" />
      </div>
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-bold">Create your account</h1>
          <p className="mt-2 text-sm text-muted-foreground">Start building your voice agent today.</p>
          <form onSubmit={onSubmit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">Business name</label>
              <input name="business_name" type="text" required className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">Email</label>
              <input name="email" type="email" required className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm text-muted-foreground">Password</label>
              <input name="password" type="password" required minLength={6} className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <button disabled={loading} className="mt-2 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow hover:opacity-90 transition disabled:opacity-60">
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
          <p className="mt-6 text-xs text-muted-foreground text-center">
            Already have an account? <Link to="/login" className="text-primary hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
