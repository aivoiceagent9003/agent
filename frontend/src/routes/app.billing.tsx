// /app/billing — what this cycle has cost, and what it is on course to cost.
//
// Every number here is derived from calls.duration_seconds by the server (see
// services/billing.js), never from a stored counter. The page renders what it is
// given and computes nothing of its own, so the page and an eventual invoice cannot
// drift apart.
//
// Charting decisions, so they are not re-litigated by taste:
//   - The allowance is a METER, not a chart. One value against one target is a bar
//     with no axis; drawing it as a chart would be a one-bar bar chart.
//   - Daily minutes are ONE series, so there is no legend — the heading names it.
//     One hue for every bar. Colouring taller bars darker would double-encode height
//     and burn the only free channel on information the bar already shows.
//   - Status colour is reserved for actual status. The meter turns amber near the
//     allowance and red past it because those MEAN something; the daily bars stay
//     the brand hue whatever their height.
//   - Numbers wear text tokens, never the series colour.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useBilling, usePlans } from "@/lib/data";
import { useMe } from "@/lib/team";
import { PlanPicker } from "@/components/portal/PlanPicker";
import { InvoiceList } from "@/components/portal/InvoiceList";
import { BillingProfileForm } from "@/components/portal/BillingProfileForm";
import { AlertTriangle, Phone, Timer, TrendingUp, Wallet } from "lucide-react";

export const Route = createFileRoute("/app/billing")({
  head: () => ({ meta: [{ title: "Billing — AnswerLabs" }] }),
  component: Billing,
});

// Whole rupees when it is a whole number, two decimals when it is not. The default
// prints Rs 22,411.1 for a paise value, which reads like a typo on an invoice.
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
const mins = (n: number) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function Billing() {
  const { data, isLoading, isError } = useBilling();
  const { data: catalogue } = usePlans();
  const { data: me } = useMe();
  // Money is owner business. A manager can see what the month is costing so they can
  // manage the queue; only the owner can change what is paid.
  const isOwner = me?.tenant_role === "owner";

  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading billing…</div>;
  if (isError || !data)
    return <div className="p-8 text-sm text-muted-foreground">Could not load billing.</div>;

  const { plan, cycle, usage, charges, projection, daily } = data;
  const over = usage.overageMinutes > 0;
  const near = !over && usage.percentUsed >= 80;

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {day(cycle.start)} – {day(cycle.end)} · day {cycle.daysElapsed} of {cycle.daysTotal}
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm text-muted-foreground">Current plan</div>
          <div className="text-lg font-semibold">{plan.name}</div>
          {plan.assumed && (
            <div className="text-xs text-warning mt-0.5">No plan set — showing Starter</div>
          )}
        </div>
      </div>

      {cycle.isFirstCycle && usage.freeMinutes > 0 && (
        <p className="mt-4 rounded-lg border border-border bg-accent/40 px-4 py-2.5 text-sm">
          First month: <strong>{mins(usage.freeMinutes)} free minutes</strong> on top of your plan
          allowance.
        </p>
      )}

      <AllowanceMeter usage={usage} over={over} near={near} />

      <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile icon={Phone} label="Calls" value={usage.calls.toLocaleString("en-IN")} />
        <Tile
          icon={Timer}
          label="Average call"
          value={usage.averageCallSeconds ? `${usage.averageCallSeconds}s` : "—"}
        />
        <Tile icon={TrendingUp} label="Billable minutes" value={mins(usage.billableMinutes)} />
        <Tile
          icon={Wallet}
          label="This cycle"
          value={inr(charges.totalInr)}
          tone={over ? "warning" : undefined}
        />
      </div>

      <div className="mt-6 grid lg:grid-cols-[1fr_340px] gap-6 items-start">
        <DailyMinutes daily={daily} />
        <Charges charges={charges} usage={usage} projection={projection} plan={plan} over={over} />
      </div>

      <div className="mt-6 space-y-6">
        <PlanPicker
          plans={catalogue?.plans ?? []}
          currentPlanId={plan.id}
          pendingPlanId={data.subscription?.pendingPlan}
          canChange={isOwner}
        />
        <InvoiceList canPay={isOwner} />
        <BillingProfileForm canEdit={isOwner} />
      </div>
    </div>
  );
}

/**
 * One value against one target. A meter, not a chart — and the only place on this page
 * where colour carries state rather than identity.
 */
function AllowanceMeter({ usage, over, near }: { usage: any; over: boolean; near: boolean }) {
  const pct = Math.min(100, usage.percentUsed);
  const fill = over ? "bg-destructive" : near ? "bg-warning" : "bg-primary";

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-sm text-muted-foreground">Minutes used</div>
          <div className="mt-0.5 text-3xl font-bold tabular-nums">
            {mins(usage.billableMinutes)}
            <span className="text-lg font-normal text-muted-foreground">
              {" "}
              / {mins(usage.allowanceMinutes)}
            </span>
          </div>
        </div>
        <div className="text-right text-sm">
          {over ? (
            <span className="inline-flex items-center gap-1.5 text-destructive font-medium">
              <AlertTriangle className="w-4 h-4" />
              {mins(usage.overageMinutes)} min over
            </span>
          ) : (
            <span className="text-muted-foreground">
              {mins(usage.remainingMinutes)} min remaining
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 h-2.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${fill} transition-[width]`}
          style={{ width: `${Math.max(pct, usage.billableMinutes > 0 ? 1.5 : 0)}%` }}
          role="progressbar"
          aria-valuenow={usage.percentUsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Allowance used"
        />
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">
        {usage.percentUsed}% of your allowance
      </div>
    </section>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div
        className={`mt-1.5 text-2xl font-bold tabular-nums ${tone === "warning" ? "text-warning" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Minutes per day. One series, so no legend — the heading names it. Bars are capped
 * rather than filling their slot, carry a rounded data-end with a square baseline, and
 * are separated by surface gaps rather than by strokes.
 */
function DailyMinutes({ daily }: { daily: { date: string; minutes: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...daily.map((d) => d.minutes));
  const total = daily.reduce((a, d) => a + d.minutes, 0);
  const busiest = daily.reduce((a, d) => (d.minutes > a.minutes ? d : a), daily[0]);

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">Minutes per day</h2>
        <span className="text-xs text-muted-foreground">
          peak {mins(peak)} min{busiest && peak > 0 ? ` · ${day(busiest.date)}` : ""}
        </span>
      </div>

      {total === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No calls yet this cycle.</p>
      ) : (
        <>
          <div className="mt-5 flex items-end gap-[2px] h-40" role="img" aria-label="Minutes per day this cycle">
            {daily.map((d, i) => {
              const h = d.minutes > 0 ? Math.max(3, (d.minutes / peak) * 100) : 0;
              return (
                <div
                  key={d.date}
                  className="relative flex-1 h-full flex items-end min-w-0"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  {d.minutes > 0 ? (
                    <div
                      className="w-full max-w-[24px] mx-auto bg-primary rounded-t transition-opacity"
                      style={{ height: `${h}%`, opacity: hover === null || hover === i ? 1 : 0.55 }}
                    />
                  ) : (
                    // A day with no calls is still a day. A 1px rule keeps the date
                    // axis honest instead of leaving a gap that reads as missing data.
                    <div className="w-full max-w-[24px] mx-auto h-px bg-border" />
                  )}
                  {hover === i && (
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full z-10 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-card">
                      <div className="font-medium">{mins(d.minutes)} min</div>
                      <div className="text-muted-foreground">{day(d.date)}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Only the ends are labelled. A date under every bar is unreadable at 30
              bars and the tooltip already answers "which day is this?". */}
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{day(daily[0].date)}</span>
            <span>{day(daily[daily.length - 1].date)}</span>
          </div>
        </>
      )}
    </section>
  );
}

function Charges({ charges, usage, projection, plan, over }: any) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-semibold">This cycle</h2>
      <dl className="mt-3 space-y-2 text-sm">
        <Line label={`${plan.name} plan`} value={inr(charges.monthlyInr)} />
        <Line
          label={`Overage · ${mins(usage.overageMinutes)} min @ ${inr(charges.overageInrPerMin)}/min`}
          value={inr(charges.overageInr)}
          muted={!over}
        />
        {charges.extraNumbersInr > 0 && (
          <Line label="Extra numbers" value={inr(charges.extraNumbersInr)} />
        )}
        <div className="pt-2 mt-2 border-t border-border flex items-baseline justify-between">
          <dt className="font-medium">Total so far</dt>
          <dd className="text-xl font-bold tabular-nums">{inr(charges.totalInr)}</dd>
        </div>
      </dl>

      <div className="mt-4 pt-4 border-t border-border">
        <div className="text-xs text-muted-foreground">
          Projected at this pace ({mins(projection.minutes)} min)
        </div>
        <div className="mt-0.5 text-lg font-semibold tabular-nums">{inr(projection.totalInr)}</div>
        {projection.overageMinutes > 0 && (
          <div className="mt-1 text-xs text-warning">
            {mins(projection.overageMinutes)} min over your allowance at this rate
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Calls are billed in 6-second increments, rounded up. Minutes included in your plan
        are used first.
      </p>
    </section>
  );
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={muted ? "text-muted-foreground" : ""}>{label}</dt>
      <dd className={`tabular-nums ${muted ? "text-muted-foreground" : ""}`}>{value}</dd>
    </div>
  );
}
