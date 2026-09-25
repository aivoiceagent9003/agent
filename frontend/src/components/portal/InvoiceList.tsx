// Invoice history, and the Pay now button.
//
// PAY NOW DOES NOT TAKE MONEY. No gateway is wired. Pressing it records the intent and
// the invoice stays exactly as it was — it does not flip to "paid", because an invoice
// that says paid when nothing was paid is the one billing bug that cannot be explained
// away afterwards. The button says so plainly rather than pretending, and when a
// provider is chosen nothing on this screen has to change.

import { AlertCircle, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useInvoices, usePayInvoice, type Invoice } from "@/lib/data";

const inr = (n: number) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const on = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

const STATUS: Record<Invoice["status"], { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  open: { label: "Due", cls: "bg-warning/15 text-warning" },
  paid: { label: "Paid", cls: "bg-success/15 text-success" },
  void: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

export function InvoiceList({ canPay }: { canPay: boolean }) {
  const { data, isLoading } = useInvoices();
  const pay = usePayInvoice();

  if (isLoading) {
    return (
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Invoices</h2>
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  const invoices = data?.invoices ?? [];

  async function payNow(inv: Invoice) {
    try {
      const r = await pay.mutateAsync(inv.id);
      toast.success(r.message || "Payment recorded as pending.");
    } catch (e: any) {
      toast.error(e.message || "Could not start the payment");
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">Invoices</h2>
        {invoices.length > 0 && (
          <span className="text-xs text-muted-foreground">{invoices.length} on record</span>
        )}
      </div>

      {data?.migrationPending ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
          Invoicing isn't set up yet — <code className="text-xs">sql/billing.sql</code> needs to be
          run. Your usage above is tracked either way.
        </p>
      ) : invoices.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No invoices yet. Your first one is raised when this cycle closes.
        </p>
      ) : (
        <div className="mt-3 divide-y divide-border">
          {invoices.map((i) => {
            const s = STATUS[i.status] ?? STATUS.open;
            const overdue = i.status === "open" && i.due_at && new Date(i.due_at) < new Date();
            return (
              <div key={i.id} className="py-3 flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-medium tabular-nums">{i.number}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                      {overdue ? "Overdue" : s.label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {on(i.period_start)} – {on(i.period_end)}
                    {i.status === "open" && i.due_at && ` · due ${on(i.due_at)}`}
                    {i.status === "paid" && i.paid_at && ` · paid ${on(i.paid_at)}`}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-lg font-semibold tabular-nums">{inr(i.totalInr)}</span>
                  {i.status === "open" && (
                    <button
                      type="button"
                      onClick={() => payNow(i)}
                      disabled={!canPay || pay.isPending}
                      title={canPay ? undefined : "Only the business owner can pay an invoice"}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                    >
                      {pay.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Pay now
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toast.info("Invoice PDFs are coming soon.")}
                    className="grid place-items-center w-8 h-8 rounded-lg border border-border text-muted-foreground hover:text-foreground transition"
                    aria-label={`Download invoice ${i.number}`}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Online payment isn't switched on yet. "Pay now" records that you want to pay and our
        team confirms it — nothing is charged automatically.
      </p>
    </section>
  );
}
