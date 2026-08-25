import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { setSession } from "@/lib/api";
import { loginWithGoogle } from "@/lib/data";
import { toast } from "sonner";
import { Phone } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Create your account — Vocera" }] }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  async function onGoogle(credential: string) {
    setLoading(true);
    try {
      const session = await loginWithGoogle(credential);
      const { is_new } = session;
      setSession(session);
      toast.success("Welcome to Vocera!");
      // New users go to onboarding to name their business; returning ones to app.
      navigate({ to: is_new ? "/onboarding" : "/app" });
    } catch (err: any) {
      toast.error(err.message || "Google sign-in failed");
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
          <p className="mt-2 text-sm text-muted-foreground">
            Sign up securely with Google — no passwords to manage. We'll set up your workspace and
            walk you through building your voice agent.
          </p>

          <div className={loading ? "pointer-events-none opacity-60" : ""}>
            <GoogleSignInButton onCredential={onGoogle} text="signup_with" showDivider={false} />
          </div>

          <p className="mt-8 text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link to="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
