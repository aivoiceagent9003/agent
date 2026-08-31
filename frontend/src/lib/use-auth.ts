import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getToken } from "@/lib/api";

// Second line of defence, behind the `beforeLoad` guards on /app and /admin.
//
// beforeLoad catches every client-side navigation before the route renders. These
// hooks stay for the hydration path: on a hard page load the router can resolve
// the initial match from the server's dehydrated state without re-running
// beforeLoad on the client, and that is exactly the case where localStorage was
// unreadable when the decision was first made.
//
// Neither is enforcement. The API is: every router mounts requireClient() or
// requireAdmin() and validates the JWT. A token sitting in localStorage is only a
// claim about who someone is, and nothing here treats it as more than a hint
// about which screen to paint.

/** Client-side auth gate. Returns false until a token is confirmed present. */
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
