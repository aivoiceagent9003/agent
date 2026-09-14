import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { LookupSheetManager } from "@/components/portal/LookupSheetManager";
import { LiveDataSetup } from "@/components/portal/LiveDataSetup";
import { useLookups, useSaveLookups, type LookupConfig } from "@/lib/data";

export const Route = createFileRoute("/app/data")({
  head: () => ({ meta: [{ title: "Live data — AnswerLabs" }] }),
  component: LiveDataPage,
});

// Live data — the per-caller records the agent reads out on a call.
//
// Two things live here, and they are deliberately separate. The sheets are the
// data itself and change as the client's own figures do. The lookups underneath
// are the configuration: which sheet the agent searches and what a caller can
// identify themselves with.
//
// Both were previously reachable only during onboarding, which is the gap this
// page closes — once a client finished setting up, there was no screen anywhere
// that let them replace a stale sheet or point a lookup at a different one.

function LiveDataPage() {
  return (
    <div className="p-8 max-w-5xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold">Live data</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The data sheets your agent looks callers up in — balances, orders, bookings. Upload a new
          version whenever your figures change, and the agent uses it on the next call.
        </p>
      </header>

      <div className="mt-6">
        <LookupSheetManager />
      </div>

      <LookupSettings />
    </div>
  );
}

// The lookup configuration, folded away because it is set once and the data above
// is what people come here for.
function LookupSettings() {
  const { data } = useLookups();
  const save = useSaveLookups();
  const [open, setOpen] = useState(false);
  const [lookups, setLookups] = useState<LookupConfig[]>([]);
  const [dirty, setDirty] = useState(false);

  // Seed from the server, but never overwrite edits in progress.
  useEffect(() => {
    if (data?.lookups && !dirty) setLookups(data.lookups);
  }, [data?.lookups, dirty]);

  function change(next: LookupConfig[]) {
    setDirty(true);
    setLookups(next);
  }

  async function persist() {
    try {
      await save.mutateAsync({ lookups });
      setDirty(false);
      toast.success("Lookups saved");
    } catch (e: any) {
      toast.error(e.message || "Could not save lookups");
    }
  }

  return (
    <section className="mt-10 border-t border-border pt-6">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm font-medium hover:text-primary transition"
      >
        {open ? "Hide" : "Show"} lookup settings
      </button>
      <p className="text-sm text-muted-foreground mt-1">
        Which sheet the agent searches, and what a caller can give to find their record.
      </p>

      {open && (
        <div className="mt-4 grid gap-4">
          <LiveDataSetup lookups={lookups} onChange={change} showSave={false} />
          {dirty && (
            <div className="flex items-center gap-3">
              <button
                onClick={persist}
                disabled={save.isPending}
                className="text-sm bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 font-medium shadow-glow disabled:opacity-60"
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              <span className="text-xs text-muted-foreground">You have unsaved changes.</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
