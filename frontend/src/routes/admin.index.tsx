import { createFileRoute, Link } from "@tanstack/react-router";
import { useAdminOverview } from "@/lib/data";
import { Users, PhoneCall, Clock, ArrowRightLeft } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

export const Route = createFileRoute("/admin/")({
  component: AdminHome,
});

function AdminHome() {
  const { data: o } = useAdminOverview();
  if (!o) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold">Platform overview</h1>
      <p className="text-sm text-muted-foreground mt-1">All clients, all calls.</p>

      <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat icon={Users} label="Clients" value={o.total_tenants.toString()} />
        <Stat icon={PhoneCall} label="Total calls" value={o.total_calls.toString()} />
        <Stat icon={Clock} label="Total minutes" value={o.total_minutes.toString()} />
        <Stat icon={ArrowRightLeft} label="Leads" value={o.total_leads.toString()} />
      </div>

      <div className="mt-8 bg-card border border-border rounded-xl p-6 shadow-card">
        <h2 className="font-semibold">Calls over time</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={o.callsPerDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={12} />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
              <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }} />
              <Line type="monotone" dataKey="calls" stroke="var(--color-primary)" strokeWidth={2} dot={{ fill: "var(--color-primary)" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-8 bg-card border border-border rounded-xl p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Recent calls</h2>
          <Link to="/admin/clients" className="text-sm text-primary hover:underline">All clients →</Link>
        </div>
        <div className="mt-4 divide-y divide-border">
          {o.recent_calls.map((c) => (
            <div key={c.id} className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">{c.caller_number}</div>
                <div className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()}</div>
              </div>
              <div className="text-sm text-muted-foreground">{Math.round(c.duration_seconds / 60)}m</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="rounded-xl p-5 border border-border bg-card shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-3xl font-bold">{value}</div>
    </div>
  );
}
