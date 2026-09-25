// Changing plan, and what it will cost before it costs it.
//
// Upgrades take money today, so the amount is fetched from the server and shown before
// the button commits anything — a customer should never press "Upgrade" and then find
// out what it cost. Downgrades take nothing and land at the next cycle boundary; the
// panel says which date, because "your plan will change" without a date is the sort of
// vagueness that generates a support ticket.
//
// The server decides direction, proration and effective date (services/billing.js).
// This component only asks and renders — duplicating the rule here is how the page and
// the invoice start disagreeing.

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useChangePlan, usePreviewPlan } from "@/lib/data";

type Plan = {
  id: string;
  name: string;
  monthlyInr: number;
  includedMinutes: number;
  overageInrPerMin: number;
  includedNumbers: number;
  blurb: string;
};

// A rate reads as Rs 4.50, not Rs 4.5 — a price with one decimal looks like a typo
// sitting next to Rs 11,999.
const inr = (n: number) => {
  const v = Number(n || 0);
  return (
    "₹" +
    v.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
};

export function PlanPicker({
  plans,
  currentPlanId,
  pendingPlanId,
  canChange,
}: {
  plans: Plan[];
  currentPlanId: string;
  pendingPlanId?: string | null;
  canChange: boolean;
}) {
  const [picked, setPicked] = useState<Plan | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const previewPlan = usePreviewPlan();
  const changePlan = useChangePlan();

  async function choose(plan: Plan) {
    setPicked(plan);
    setPreview(null);
    try {
      setPreview(await previewPlan.mutateAsync(plan.id));
    } catch (e: any) {
      toast.error(e.message || "Could not work out what that would cost");
      setPicked(null);
    }
  }

  async function confirm() {
    if (!picked) return;
    try {
      const r = await changePlan.mutateAsync(picked.id);
      toast.success(
        r.kind === "upgrade"
          ? `You're on ${r.to.name} — ${inr(r.proratedInr)} charged for the rest of this cycle.`
          : `${r.to.name} takes effect on ${new Date(r.effectiveAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.`,
      );
      setPicked(null);
      setPreview(null);
    } catch (e: any) {
      toast.error(e.message || "Could not change the plan");
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-semibold">Plans</h2>
      {pendingPlanId && (
        <p className="mt-2 text-sm text-warning">
          A change to <strong className="capitalize">{pendingPlanId}</strong> is scheduled for your
          next cycle. Upgrading now cancels it.
        </p>
      )}

      <div className="mt-4 grid md:grid-cols-3 gap-3">
        {plans.map((p) => {
          const current = p.id === currentPlanId;
          return (
            <div
              key={p.id}
              className={`rounded-lg border p-4 flex flex-col ${
                current ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{p.name}</span>
                {current && (
                  <span className="inline-flex items-center gap-1 text-xs text-primary font-medium">
                    <Check className="w-3.5 h-3.5" /> Current
                  </span>
                )}
              </div>
              <div className="mt-2 text-2xl font-bold tabular-nums">
                {inr(p.monthlyInr)}
                <span className="text-sm font-normal text-muted-foreground">/mo</span>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                <li>{p.includedMinutes.toLocaleString("en-IN")} minutes included</li>
                <li>Then {inr(p.overageInrPerMin)}/min</li>
                <li>
                  {p.includedNumbers} number{p.includedNumbers > 1 ? "s" : ""} included
                </li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground flex-1">{p.blurb}</p>
              {!current && (
                <button
                  type="button"
                  disabled={!canChange || previewPlan.isPending}
                  onClick={() => choose(p)}
                  title={canChange ? undefined : "Only the business owner can change the plan"}
                  className="mt-3 w-full rounded-lg border border-primary text-primary px-3 py-2 text-sm font-medium hover:bg-primary/5 transition disabled:opacity-50"
                >
                  {p.monthlyInr > (plans.find((x) => x.id === currentPlanId)?.monthlyInr ?? 0)
                    ? "Upgrade"
                    : "Switch"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {picked && (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
          {previewPlan.isPending || !preview ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Working out what this costs…
            </div>
          ) : (
            <>
              <h3 className="font-medium">
                {preview.kind === "upgrade" ? "Upgrade" : "Switch"} to {preview.to.name}
              </h3>
              {preview.kind === "upgrade" ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Takes effect immediately. You'll be charged{" "}
                  <strong className="text-foreground">{inr(preview.proratedInr)}</strong> for the{" "}
                  {preview.daysRemaining} day{preview.daysRemaining === 1 ? "" : "s"} left in this
                  cycle — the difference only, not the full month.
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  Nothing to pay now. You keep your current allowance until{" "}
                  <strong className="text-foreground">
                    {new Date(preview.effectiveAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "long",
                    })}
                  </strong>
                  , when {preview.to.name} begins.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={confirm}
                  disabled={changePlan.isPending}
                  className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-60"
                >
                  {changePlan.isPending ? "Working…" : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(null);
                    setPreview(null);
                  }}
                  className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted transition"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
