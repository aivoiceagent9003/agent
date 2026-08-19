// /work/settings — profile only.
//
// No Security or Sessions tabs, per the design. Password changes go through the
// existing /forgot-password flow (which already emails a verified reset link), and
// session management isn't meaningful until refresh tokens land — see Phase 5 in
// REMEDIATION_PLAN.md. A tab that promises either and delivers neither is worse
// than no tab.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMe, ROLE_LABEL } from "@/lib/team";
import { apiFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, User } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/work/settings")({
  head: () => ({ meta: [{ title: "Settings — Vocera" }] }),
  component: WorkSettings,
});

function WorkSettings() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed the form once /me resolves.
  useEffect(() => {
    if (!me) return;
    setFullName(me.full_name || "");
    setPhone((me as any).phone || "");
  }, [me]);

  const dirty = !!me && (fullName !== (me.full_name || "") || phone !== ((me as any).phone || ""));

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/api/client/me", {
        method: "PATCH",
        body: JSON.stringify({ full_name: fullName, phone }),
      });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Profile updated");
    } catch (e: any) {
      toast.error(e.message || "Could not save your profile");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFullName(me?.full_name || "");
    setPhone((me as any)?.phone || "");
  }

  const initials = (me?.full_name || me?.email || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <button
        onClick={() => navigate({ to: "/work/leads" })}
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      <header className="mt-4">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your profile.</p>
      </header>

      <section className="mt-8 border border-border rounded-xl bg-card p-6 flex items-center gap-5">
        <div className="w-20 h-20 rounded-full bg-primary grid place-items-center text-primary-foreground text-2xl font-bold shrink-0">
          {initials}
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold">{me?.full_name || "Your name"}</h2>
            {me && (
              <span className="rounded-full bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-medium">
                {ROLE_LABEL[me.tenant_role]}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{me?.email}</p>
        </div>
      </section>

      <section className="mt-6 border border-border rounded-xl bg-card p-6">
        <h2 className="font-semibold flex items-center gap-2">
          <User className="w-4 h-4 text-muted-foreground" /> Personal information
        </h2>

        <div className="mt-5 grid sm:grid-cols-2 gap-5">
          <Field label="Full name">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>

          <Field label="Email address" hint="Your login address. Contact your admin to change it.">
            {/* Read-only on purpose: changing a login address needs a verification
                round-trip, and a typo here would lock you out of your own account. */}
            <input
              value={me?.email || ""}
              readOnly
              className="w-full bg-muted border border-border rounded-lg px-3 py-2.5 text-sm text-muted-foreground cursor-not-allowed"
            />
          </Field>

          <Field label="Mobile number">
            <div className="flex">
              <span className="inline-flex items-center px-3 rounded-l-lg border border-r-0 border-border bg-muted text-sm text-muted-foreground">
                +91
              </span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="97654 32109"
                className="w-full bg-input border border-border rounded-r-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </Field>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={reset}
            disabled={!dirty}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Reset
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </label>
  );
}
