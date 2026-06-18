import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getToken } from "@/lib/api";

/** Client-side auth gate. Replace token validation with server check when wired. */
export function useRequireAuth() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = getToken();
    if (!t) {
      navigate({ to: "/login" });
      return;
    }
    setReady(true);
  }, [navigate]);
  return ready;
}

export function useRequireAdmin() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = getToken();
    if (!t) {
      navigate({ to: "/admin-login" });
      return;
    }
    setReady(true);
  }, [navigate]);
  return ready;
}
