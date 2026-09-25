// Who the invoice is made out to.
//
// This is not a preferences screen. An Indian tax invoice needs a legal name, a place
// of supply and a GSTIN if the customer has one, and the state decides whether the tax
// splits into CGST+SGST or goes out as IGST. Missing details mean no invoice can be
// issued at all, so the form says what is still needed rather than saving quietly and
// failing at cycle close.

import { useEffect, useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";
import { useBillingProfile, useSaveBillingProfile, type BillingProfile } from "@/lib/data";

// GST state codes. The code, not the name, is what the split is computed from — two
// states with similar names are a filing error waiting to happen.
const STATES: [string, string][] = [
  ["37", "Andhra Pradesh"], ["12", "Arunachal Pradesh"], ["18", "Assam"], ["10", "Bihar"],
  ["04", "Chandigarh"], ["22", "Chhattisgarh"], ["07", "Delhi"], ["30", "Goa"],
  ["24", "Gujarat"], ["06", "Haryana"], ["02", "Himachal Pradesh"], ["01", "Jammu & Kashmir"],
  ["20", "Jharkhand"], ["29", "Karnataka"], ["32", "Kerala"], ["31", "Lakshadweep"],
  ["23", "Madhya Pradesh"], ["27", "Maharashtra"], ["14", "Manipur"], ["17", "Meghalaya"],
  ["15", "Mizoram"], ["13", "Nagaland"], ["21", "Odisha"], ["34", "Puducherry"],
  ["03", "Punjab"], ["08", "Rajasthan"], ["11", "Sikkim"], ["33", "Tamil Nadu"],
  ["36", "Telangana"], ["16", "Tripura"], ["09", "Uttar Pradesh"], ["05", "Uttarakhand"],
  ["19", "West Bengal"],
];

export function BillingProfileForm({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useBillingProfile();
  const save = useSaveBillingProfile();
  const [form, setForm] = useState<BillingProfile>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data?.profile) setForm(data.profile);
  }, [data?.profile]);

  if (isLoading) {
    return (
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-semibold">Billing details</h2>
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  const set = (k: keyof BillingProfile) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      // The state name is stored alongside the code so an invoice can print it without
      // a lookup a year from now, when this list may have moved on.
      const state = STATES.find(([code]) => code === form.state_code)?.[1] ?? form.state ?? null;
      await save.mutateAsync({ ...form, state });
      setDirty(false);
      toast.success("Billing details saved");
    } catch (err: any) {
      toast.error(err.message || "Could not save");
    }
  }

  const missing = data?.ready?.missing ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-semibold">Billing details</h2>
        {data?.ready?.ready ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-success">
            <Check className="w-3.5 h-3.5" /> Ready to invoice
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <AlertCircle className="w-3.5 h-3.5" /> Incomplete
          </span>
        )}
      </div>

      {!data?.ready?.ready && missing.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Still needed before an invoice can be raised: {missing.join(", ")}.
        </p>
      )}

      <form onSubmit={submit} className="mt-4 grid sm:grid-cols-2 gap-3">
        <Field label="Registered business name" value={form.legal_name} onChange={set("legal_name")} disabled={!canEdit} className="sm:col-span-2" />
        <Field label="GSTIN" value={form.gstin} onChange={set("gstin")} disabled={!canEdit} placeholder="36AAAAA0000A1Z5" />
        <Field label="PAN" value={form.pan} onChange={set("pan")} disabled={!canEdit} />
        <Field label="Address" value={form.address_line1} onChange={set("address_line1")} disabled={!canEdit} className="sm:col-span-2" />
        <Field label="Address line 2" value={form.address_line2} onChange={set("address_line2")} disabled={!canEdit} className="sm:col-span-2" />
        <Field label="City" value={form.city} onChange={set("city")} disabled={!canEdit} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">State (place of supply)</span>
          <select
            value={form.state_code ?? ""}
            disabled={!canEdit}
            onChange={(e) => set("state_code")(e.target.value)}
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          >
            <option value="">Select…</option>
            {STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Field label="PIN code" value={form.pincode} onChange={set("pincode")} disabled={!canEdit} />
        <Field label="Billing email" value={form.billing_email} onChange={set("billing_email")} disabled={!canEdit} type="email" />
        <Field label="Phone" value={form.phone} onChange={set("phone")} disabled={!canEdit} />

        {canEdit && (
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={!dirty || save.isPending}
              className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save billing details"}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function Field({
  label, value, onChange, disabled, placeholder, type = "text", className = "",
}: {
  label: string; value?: string | null; onChange: (v: string) => void;
  disabled?: boolean; placeholder?: string; type?: string; className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className}`}>
      <span className="text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
    </label>
  );
}
