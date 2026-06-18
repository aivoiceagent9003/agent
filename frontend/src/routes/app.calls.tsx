import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useClientCalls } from "@/lib/data";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/app/calls")({
  component: CallsList,
});

function CallsList() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useClientCalls(page, PAGE_SIZE);
  const rows = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold">Calls</h1>
      <p className="text-sm text-muted-foreground mt-1">{isLoading ? "Loading…" : `${total} total calls.`}</p>

      <div className="mt-6 bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-5 py-3 font-medium">Caller</th>
              <th className="text-left px-5 py-3 font-medium">Date</th>
              <th className="text-left px-5 py-3 font-medium">Duration</th>
              <th className="text-left px-5 py-3 font-medium">Status</th>
              <th className="text-left px-5 py-3 font-medium">Lead</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-muted/30 transition">
                <td className="px-5 py-3">
                  <Link to="/app/calls/$id" params={{ id: c.id }} className="font-medium hover:text-primary">
                    {c.caller_number}
                  </Link>
                </td>
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
