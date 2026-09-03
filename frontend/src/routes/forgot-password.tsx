// /forgot-password — request a reset link.
//
// The backend always answers "ok" whether or not the address exists, so this page
// shows the same confirmation either way. That is intentional: a page that says
// "no such account" is a free list of who banks with you.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { BASE_URL } from "@/lib/api";
import { toast } from "sonner";
import { MailCheck, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Reset your password — AnswerLabs" }] }),
  component: ForgotPassword,
});

function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/forgot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) throw new Error("Could not send the reset link");
      setSent(true);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-hero">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-8 shadow-card">
        {sent ? (
          <>
            <div className="w-11 h-11 rounded-xl bg-primary/15 flex items-center justify-center">
              <MailCheck className="w-5 h-5 text-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              If <span className="text-foreground">{email}</span> has an AnswerLabs account, a reset link
              is on its way. It expires in an hour.
            </p>
            <button
              onClick={() => setSent(false)}
              className="mt-6 text-sm text-primary hover:underline"
            >
              Use a different address
            </button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold">Reset your password</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Enter your email and we'll send you a link to set a new one.
            </p>
            <form onSubmit={onSubmit} className="mt-6 grid gap-4">
              <div className="grid gap-1.5">
                <label htmlFor="email" className="text-sm font-medium">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className="bg-input border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                disabled={loading}
                className="bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow disabled:opacity-60"
              >
                {loading ? "Sending…" : "Send reset link"}
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-sm text-center">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
