// GoogleSignInButton — renders the official "Sign in with Google" button using
// Google Identity Services (GIS). On success it hands the Google ID token
// (`credential`) to `onCredential`, which the caller sends to the backend
// (POST /api/auth/google) to exchange for an AnswerLabs session token.
//
// Requires VITE_GOOGLE_CLIENT_ID to be set. If it isn't, the button is hidden so
// the page still works with password auth alone.

import { useEffect, useRef } from "react";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GSI_SRC = "https://accounts.google.com/gsi/client";

declare global {
  interface Window {
    google?: any;
  }
}

// Load the GIS script once, shared across button instances.
let gsiPromise: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google script")));
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google script"));
    document.head.appendChild(script);
  });
  return gsiPromise;
}

export function GoogleSignInButton({
  onCredential,
  text = "signin_with",
  showDivider = true,
}: {
  onCredential: (credential: string) => void;
  text?: "signin_with" | "signup_with" | "continue_with";
  // Show the "or" divider above the button (for pages that also offer a form).
  showDivider?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-initializing GIS on every render.
  const cbRef = useRef(onCredential);
  cbRef.current = onCredential;

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    loadGsi()
      .then(() => {
        if (cancelled || !ref.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp: { credential?: string }) => {
            if (resp?.credential) cbRef.current(resp.credential);
          },
        });
        window.google.accounts.id.renderButton(ref.current, {
          theme: "outline",
          size: "large",
          width: 320,
          text,
          logo_alignment: "center",
        });
      })
      .catch(() => {
        /* script failed to load — leave password auth as the fallback */
      });

    return () => {
      cancelled = true;
    };
  }, [text]);

  if (!GOOGLE_CLIENT_ID) return null;

  return (
    <div className="mt-4">
      {showDivider && (
        <div className="flex items-center gap-3 my-4">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}
      <div ref={ref} className="flex justify-center" />
    </div>
  );
}
