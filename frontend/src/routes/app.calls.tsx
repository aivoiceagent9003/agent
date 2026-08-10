import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { useState } from "react";
import { useClientCalls } from "@/lib/data";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/app/calls")({
  component: CallsRoute,
});

// `/app/calls/$id` is a CHILD of this route, so this component must render the
// nested route. Show the call detail when a child (the $id route) is active,
// otherwise show the calls list.
function CallsRoute() {
  const childMatches = useChildMatches();
  return childMatches.length > 0 ? <Outlet /> : <CallsList />;
}

type Tab = "all" | "inbound" | "outbound";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All calls" },
  { id: "inbound", label: "↘ Inbound" },
  { id: "outbound", label: "↗ Outbound" },
];

function CallsList() {
  const [tab, setTab] = useState<Tab>("all");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useClientCalls(page, PAGE_SIZE, tab === "all" ? undefined : tab);
  const rows = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function selectTab(next: Tab) {
    setTab(next);
    setPage(1); // filters change the result set — restart pagination
  }

  const noun = tab === "inbound" ? "inbound calls" : tab === "outbound" ? "outbound calls" : "total calls";

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold">Calls</h1>
      <p className="text-sm text-muted-foreground mt-1">{isLoading ? "Loading…" : `${total} ${noun}.`}</p>

      {/* Inbound / Outbound separation so clients don't have to hunt through a mixed list. */}
      <div className="mt-6 inline-flex rounded-lg border border-border bg-card p-1 shadow-card">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTab(t.id)}
            className={`px-4 py-1.5 text-sm rounded-md transition ${
              tab === t.id
                ? "bg-gradient-primary text-primary-foreground shadow-glow"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Caller</th>
              {tab === "all" && <th className="text-left px-5 py-3 font-medium">Direction</th>}
              <th className="text-left px-5 py-3 font-medium">Date</th>
              <th className="text-left px-5 py-3 font-medium">Duration</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
              <th className="text-left px-5 py-3 font-medium">Lead</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={tab === "all" ? 6 : 5} className="px-5 py-10 text-center text-muted-foreground">
                  No {noun} yet.
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30 transition">
                <td className="px-5 py-3">
                  <Link to="/app/calls/$id" params={{ id: c.id }} className="font-medium hover:text-primary">
                    {c.caller_number}
                  </Link>
                </td>
                {tab === "all" && (
                  <td className="px-5 py-3">
                    {(c as any).direction === "outbound" ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">↗ Outbound</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">↘ Inbound</span>
                    )}
                  </td>
                )}
                <td className="px-5 py-3 text-muted-foreground">{new Date(c.created_at).toLocaleString()}</td>
                <td className="px-5 py-3">{Math.floor(c.duration_seconds / 60)}m {c.duration_seconds % 60}s</td>
                <td className="px-5 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === "active" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                    {c.status}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {c.has_lead ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">Lead</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted transition">Prev</button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg border border-border disabled:opacity-50 hover:bg-muted transition">Next</button>
        </div>
      </div>
    </div>
  );
}
