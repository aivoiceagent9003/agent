// /login — one sign-in page, two audiences.
//
// The Employee/Business toggle is a ROUTING and COPY switch, not two auth systems:
// both tabs post to the same /api/auth/login and the same Google flow. What differs
// is the helper text, where a successful sign-in lands, and the footer (a business
// owner can self-serve a new account; an employee needs an invite).
//
// Wrong tab is never an error. If an owner signs in under "Employee" we still send
// them to the right place — the tab is a hint about who you are, not a gate.

import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { setSession } from "@/lib/api";
import { login, loginWithGoogle } from "@/lib/data";
import { toast } from "sonner";
import { Phone, Eye, EyeOff } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

type Audience = "employee" | "business";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Vocera" }] }),
  // ?tab=employee lets /employee-login and invite emails deep-link to the right
  // side of the toggle.
  validateSearch: (search: Record<string, unknown>): { tab?: Audience } => ({
    tab:
      search.tab === "business" ? "business" : search.tab === "employee" ? "employee" : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const [audience, setAudience] = useState<Audience>(tab ?? "business");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // One landing rule for both sign-in methods and both tabs.
  function land(role: string, isNew = false) {
    if (role === "admin") {
      navigate({ to: "/admin" });
      return;
    }
    // Only a brand-new business owner needs the setup wizard. /app decides the
    // rest — it redirects owners to onboarding and shows employees a waiting state.
    navigate({ to: isNew ? "/onboarding" : "/app" });
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email"));
    const password = String(fd.get("password"));
    try {
      if (!email || !password) throw new Error("Email and password required");
      const session = await login(email, password);
      const { role } = session;
      setSession(session);
      toast.success("Welcome back!");
      land(role);
    } catch (err: any) {
      toast.error(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function onGoogle(credential: string) {
    setLoading(true);
    try {
      const session = await loginWithGoogle(credential);
      const { role, is_new } = session;
      setSession(session);
      toast.success("Welcome!");
      land(role, is_new);
    } catch (err: any) {
      toast.error(err.message || "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  const isEmployee = audience === "employee";

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
          <h1 className="text-3xl font-bold">Sign in to Vocera</h1>
          <p className="mt-2 text-sm text-muted-foreground">Choose how you work with Vocera.</p>

          {/* Segmented toggle */}
          <div
            role="tablist"
            aria-label="Account type"
            className="mt-6 grid grid-cols-2 gap-1 p-1 rounded-xl bg-muted"
          >
            <TabButton
              active={isEmployee}
              onClick={() => setAudience("employee")}
              label="Employee"
            />
            <TabButton
              active={!isEmployee}
              onClick={() => setAudience("business")}
              label="Business"
            />
          </div>

          <p className="mt-3 text-sm text-muted-foreground">
            {isEmployee
              ? "Sign in with your invite credentials."
              : "Sign in to manage your agent and your team."}
          </p>

          <form onSubmit={onSubmit} className="mt-5 grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="bg-input border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  className="w-full bg-input border border-border rounded-lg px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <Link
                to="/forgot-password"
                className="justify-self-end text-sm text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>

            <button
              disabled={loading}
              className="mt-1 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow hover:opacity-90 transition disabled:opacity-60"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <GoogleSignInButton onCredential={onGoogle} text="signin_with" />

          {/* An employee cannot self-serve an account — they need an invite. */}
          <p className="mt-6 text-sm text-muted-foreground text-center">
            {isEmployee ? (
              <>Don't have an account? Ask your admin to invite you.</>
            ) : (
              <>
                Don't have an account?{" "}
                <Link to="/signup" className="text-primary hover:underline font-medium">
                  Sign up
                </Link>
              </>
            )}
          </p>
          <p className="mt-2 text-sm text-center">
            <Link to="/admin-login" className="text-muted-foreground hover:text-foreground">
              Admin? Sign in here →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-lg px-4 py-2.5 text-sm font-medium transition ${
        active
          ? "bg-gradient-primary text-primary-foreground shadow-glow"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
