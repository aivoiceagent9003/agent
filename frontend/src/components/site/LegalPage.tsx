import type { ReactNode } from "react";
import { SiteNav, SiteFooter } from "./SiteChrome";

/**
 * Shared shell for the legal pages.
 *
 * The review banner is deliberate and should stay until a lawyer has signed the
 * text off. These drafts are accurate about what the system does — the data flows,
 * retention windows, and sub-processors are read off the actual implementation —
 * but accuracy about mechanics is not the same as legal sufficiency, and shipping
 * unreviewed policy text as if it were reviewed is its own liability.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 mb-10 text-sm">
          <strong className="font-semibold">Draft — pending legal review.</strong> This describes
          how Vocera actually handles data today, but it has not yet been reviewed by a lawyer and
          is not a substitute for advice.
        </div>

        <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-2">Last updated {updated}</p>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight mb-3">{heading}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
