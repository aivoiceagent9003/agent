// /employee-login — kept as a permanent redirect.
//
// Employee and business sign-in merged into a single /login page with an
// Employee/Business toggle. This route stays so any link already shared (invite
// follow-ups, bookmarks, anything pasted into a WhatsApp group) lands on the right
// side of that toggle instead of 404-ing.

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/employee-login")({
  beforeLoad: () => {
    throw redirect({ to: "/login", search: { tab: "employee" }, replace: true });
  },
});
