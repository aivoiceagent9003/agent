import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { registerCacheReset } from "../lib/api";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { OrbField, type Variant } from "../components/site/OrbField";
import { VisualPreloader } from "../components/VisualPreloader";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-gradient">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">Something went wrong.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => { router.invalidate(); reset(); }}
            className="rounded-md bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
          <a href="/" className="rounded-md border border-border px-4 py-2 text-sm">Go home</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Vocera — AI Voice Agents That Never Miss a Call" },
      { name: "description", content: "Multilingual AI voice agents that answer calls, capture leads, and hand off to humans — built for modern businesses." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// Apply the saved theme before first paint, so there's no flash of the wrong theme.
// Dark is the DEFAULT: only an explicit saved 'light' choice opts out. Runs in <head>
// where document.documentElement already exists.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('vocera-theme');if(t!=='light')document.documentElement.classList.add('dark');}catch(e){document.documentElement.classList.add('dark');}})();`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

// Exactly two pages carry a signature, and each one always carries the same one.
// Anything else — dashboards, onboarding, employee views, password flows — gets a
// plain background, because an animated canvas behind a table of leads is noise.
//
// This used to be a localStorage preference with a floating switcher, so the
// marketing page's identity depended on whatever the last visitor clicked.
function signatureFor(pathname: string): Variant | null {
  if (pathname === "/") return "ribbon";      // Waveform — the public site
  if (pathname === "/login") return "orb";    // Orb — sign in
  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Let the token setters in lib/api wipe cached data when the signed-in identity
  // changes. Registered here because this is where the QueryClient is in scope,
  // and lib/api must not import React.
  useEffect(() => {
    registerCacheReset(() => queryClient.clear());
  }, [queryClient]);

  // The orb is a marketing flourish — keep it off the data-dense client/admin
  // dashboards so it never competes with leads, calls, or tables.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const signature = signatureFor(pathname);
  return (
    <QueryClientProvider client={queryClient}>
      {signature && <OrbField variant={signature} />}
      <VisualPreloader>
        <Outlet />
      </VisualPreloader>
      <Toaster theme="dark" position="top-right" />
    </QueryClientProvider>
  );
}
