import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, TrendingUp, DollarSign, PhoneCall, Users } from "lucide-react";
import { useBusinessStats, fmtUsd } from "@/lib/ops";

export const Route = createFileRoute("/admin/ops/business")({
  component: BusinessDashboard,
});

function BusinessDashboard() {
  const { data, isLoading } = useBusinessStats();
  const tenants = data?.tenants || [];
  const totals = data?.totals;

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <Link
        to="/admin/ops"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Operations
      </Link>
      <h1 className="text-3xl font-bold flex items-center gap-3 mt-3">
        <TrendingUp className="w-7 h-7 text-primary" /> Business Analytics
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        Per-tenant economics. Cost/revenue use the platform rate (override per tenant via config).
      </p>

      {totals && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Stat icon={PhoneCall} label="Calls" value={totals.calls.toLocaleString()} />
          <Stat icon={PhoneCall} label="Minutes" value={totals.minutes.toLocaleString()} />
          <Stat icon={Users} label="Leads" value={totals.leads.toLocaleString()} />
          <Stat icon={DollarSign} label="Revenue" value={fmtUsd(totals.revenue)} />
          <Stat icon={DollarSign} label="Cost" value={fmtUsd(totals.cost)} />
          <Stat
            icon={DollarSign}
            label="Profit"
            value={fmtUsd(totals.profit)}
            accent={totals.profit >= 0}
            warn={totals.profit < 0}
          />
        </div>
      )}

      <div className="mt-8 bg-card border border-border rounded-xl shadow-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Tenant</th>
              <th className="text-right px-4 py-3 font-medium">Calls</th>
              <th className="text-right px-4 py-3 font-medium">Minutes</th>
              <th className="text-right px-4 py-3 font-medium">Leads</th>
              <th className="text-right px-4 py-3 font-medium">Conv.</th>
              <th className="text-right px-4 py-3 font-medium">KB</th>
              <th className="text-right px-4 py-3 font-medium">Storage</th>
              <th className="text-right px-4 py-3 font-medium">Revenue</th>
              <th className="text-right px-4 py-3 font-medium">Cost</th>
              <th className="text-right px-4 py-3 font-medium">Profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tenants.map((t: any) => (
              <tr key={t.tenantId} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.calls}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.minutes}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.leads}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.conversionRate}%</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.knowledgeChunks}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.storageMb} MB</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtUsd(t.revenue)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {fmtUsd(t.cost)}
                </td>
                <td
                  className={`px-4 py-3 text-right tabular-nums font-medium ${t.profit >= 0 ? "text-success" : "text-destructive"}`}
                >
                  {fmtUsd(t.profit)}
                </td>
              </tr>
            ))}
            {!isLoading && tenants.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground">
                  No tenants.
                </td>
              </tr>
            )}
            {isLoading && (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
  warn,
}: {
  icon: any;
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 border bg-card shadow-card ${warn ? "border-destructive/50" : accent ? "border-success/40" : "border-border"}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon
          className={`w-4 h-4 ${warn ? "text-destructive" : accent ? "text-success" : "text-muted-foreground"}`}
        />
      </div>
      <div
        className={`mt-2 text-2xl font-bold ${warn ? "text-destructive" : accent ? "text-success" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
