// /join#token=… — an invited employee creates their account.
//
// The token IS the authorization: single-use, 7-day expiry, and the backend stores
// only its SHA-256 hash. Acceptance is bound to the invited email address, so the
// link is an invitation for one person rather than a public signup coupon.
//
// WHY THE FRAGMENT, NOT A QUERY STRING
// A URL fragment is never transmitted to any server: it stays out of web-server
// access logs, CDN logs, and — critically — out of the `Referer` header. This page
// loads Google Identity Services from accounts.google.com, so with `?token=` the
// full invite link would be handed to Google on every page view. Same reasoning as
// reset-password.tsx.
//
// We still accept `?token=` so links sent before this change keep working, and we
// strip whichever form we found out of the address bar immediately, so the token
// does not linger in browser history or get copied by "share this page".

import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { setSession } from "@/lib/api";
import { fetchInvite, acceptInvite, ROLE_LABEL, ROLE_DESCRIPTION } from "@/lib/team";
import type { InvitePreview } from "@/lib/team";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { toast } from "sonner";
import { Users, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/join")({
  head: () => ({
    meta: [
      { title: "Join your team — Vocera" },
      // Belt and braces alongside the fragment: never send a Referer from this
      // page, so no third-party resource can learn the URL it was loaded with.
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: Join,
});

function Join() {
  // Legacy query-string form, for links mailed before the switch to the fragment.
  const { token: legacyToken } = Route.useSearch();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Captured ONCE and never lost. Earlier versions read the token in an effect and
  // erased the URL in the same pass, so any second run of that effect — a remount,
  // Fast Refresh, the router rewriting location on hydration — re-read a URL the
  // first run had already emptied, and concluded the link had no code in it.
  //
  // Two rules make that impossible now:
  //   1. read during render, before anything can rewrite the URL
  //   2. do not scrub the URL until the token has actually been used
  const captured = useRef<string | null>(null);
  if (captured.current === null && typeof window !== "undefined") {
    captured.current = readToken(window.location) || legacyToken || "";
  }
  const token = captured.current ?? "";

  useEffect(() => {
    // SSR renders nothing useful here; the real read happens on the client.
    if (typeof window === "undefined") return;

    if (!token) {
      setError("This link is missing its invite code.");
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    setError(null);
    fetchInvite(token)
      .then((data) => {
        if (cancelled) return;
        setInvite(data);
        // Scrub only now that the token has served its purpose. Doing this before
        // the fetch is what made every earlier version brittle.
        window.history.replaceState(null, "", window.location.pathname);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function finish(input: { credential?: string; password?: string; full_name?: string }) {
    setSubmitting(true);
    try {
      const res = await acceptInvite(token, input);
      if (res.token) {
        setSession({
          token: res.token,
          refresh_token: (res as any).refresh_token ?? null,
          expires_at: (res as any).expires_at ?? null,
        });
      }
      toast.success(`Welcome to ${invite?.business_name ?? "the team"}`);
      // Employees land straight in the dashboard — never in onboarding, which is
      // the owner's job and which they have no permission to complete. If no
      // session came back (SMTP-less password path), send them to sign in.
      if (res.token) navigate({ to: "/app" });
      else navigate({ to: "/login", search: { tab: "employee" } });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get("password"));
    const confirm = String(fd.get("confirm"));
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    if (password !== confirm) return toast.error("Those passwords don't match");
    await finish({ password, full_name: String(fd.get("full_name") || "") });
  }

  if (checking) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Checking your invite…</p>
      </Shell>
    );
  }

  if (error || !invite) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="w-4 h-4" /> Invite unavailable
        </div>
        <h1 className="mt-2 text-2xl font-bold">This link isn't valid</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-6 text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link to="/login" search={{ tab: "employee" }} className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="w-4 h-4 text-primary" /> Team invitation
      </div>
      <h1 className="mt-2 text-2xl font-bold">Join {invite.business_name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You've been invited as a{" "}
        <span className="text-foreground font-medium">{ROLE_LABEL[invite.tenant_role]}</span> —{" "}
        {ROLE_DESCRIPTION[invite.tenant_role].toLowerCase()}.
      </p>

      <div className="mt-5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Signing up as</span>{" "}
        <span className="font-medium">{invite.email}</span>
      </div>

      <form onSubmit={onSubmit} className="mt-5 grid gap-4">
        <input
          name="full_name"
          type="text"
          placeholder="Your name"
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="Create a password"
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          name="confirm"
          type="password"
          required
          placeholder="Confirm password"
          className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          disabled={submitting}
          className="bg-gradient-primary text-primary-foreground font-medium rounded-lg px-4 py-2.5 shadow-glow disabled:opacity-60"
        >
          {submitting ? "Setting up…" : "Accept invite"}
        </button>
      </form>

      <GoogleSignInButton
        onCredential={(credential) => finish({ credential })}
        text="continue_with"
      />

      <p className="mt-6 text-xs text-muted-foreground">
        Use the Google account for <span className="text-foreground">{invite.email}</span> — this
        invite is for that address only.
      </p>
    </Shell>
  );
}

/**
 * Pull the invite token out of a URL, accepting every shape we have ever emitted:
 *   /join#token=…   current — a fragment is never sent to a server
 *   /join?token=…   links mailed before the switch to the fragment
 *   /join#/?token=… some mail clients rewrite links through a hash router
 *
 * Being generous here costs nothing and means a recipient never sees a dead link
 * because their mail client reformatted it.
 */
function readToken(loc: Location): string {
  const fromHash = new URLSearchParams(loc.hash.replace(/^#\/?\??/, "")).get("token");
  if (fromHash) return fromHash;
  const fromSearch = new URLSearchParams(loc.search).get("token");
  if (fromSearch) return fromSearch;
  // Last resort: a bare "#<token>" with no key at all.
  const bare = loc.hash.replace(/^#/, "");
  if (bare && !bare.includes("=") && bare.length > 20) return bare;
  return "";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-hero">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-8 shadow-card">
        {children}
      </div>
    </div>
  );
}
