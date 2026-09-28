// TopBar — the account controls, top right of every dashboard page.
//
// Notifications, the theme switch, Agent settings and Sign out used to sit at the
// bottom of the sidebar, under the nav, where they read as leftovers rather than
// controls. They live here now, in the order dashboards train people to scan:
// what needs attention, preferences, settings, then who you are.
//
// Shared by PortalShell (owners, managers, admins) and EmployeeShell (agents).

import { Link } from "@tanstack/react-router";
import { Building2, ChevronDown, LogOut, Moon, Settings, Shield, Sun } from "lucide-react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDarkMode } from "@/components/ThemeToggle";
import { ROLE_LABEL, type Me } from "@/lib/team";
import { NotificationsButton } from "./Notifications";

const ICON_BUTTON =
  "relative grid place-items-center w-9 h-9 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TopBar({
  me,
  admin = false,
  bell,
  settingsTo,
  onSignOut,
}: {
  /** Undefined for admins, who have no tenant profile. */
  me?: Me;
  admin?: boolean;
  /** Omit to hide the bell — and with it the notification queries. */
  bell?: { open: boolean; onToggle: () => void };
  /** Where the gear goes. Omit to hide it. */
  settingsTo?: string;
  onSignOut: () => void;
}) {
  const [dark, toggleTheme] = useDarkMode();

  // The sidebar's own surface, so the two read as one frame around the page. Its
  // edge — a hairline and the rounded corner into the rail — is drawn by
  // .portal-topbar in styles.css. z-30 keeps it under dialogs, drawers and
  // menus, which all sit at z-50.
  return (
    <header className="portal-topbar sticky top-0 z-30 h-14 shrink-0 flex items-center justify-end gap-1 px-4 md:px-6 bg-sidebar">
      <TooltipProvider delayDuration={300}>
        {bell && (
          <Tip label="Notifications">
            <NotificationsButton
              open={bell.open}
              onToggle={bell.onToggle}
              className={`${ICON_BUTTON} ${bell.open ? "bg-muted text-foreground" : ""}`}
            />
          </Tip>
        )}

        <Tip label={dark ? "Light mode" : "Dark mode"}>
          <button
            type="button"
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
            className={ICON_BUTTON}
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </Tip>

        {settingsTo && (
          <Tip label="Agent settings">
            <Link to={settingsTo} aria-label="Agent settings" className={ICON_BUTTON}>
              <Settings className="w-4 h-4" />
            </Link>
          </Tip>
        )}
      </TooltipProvider>

      <div className="mx-2 h-6 w-px bg-border" aria-hidden />

      <AccountMenu me={me} admin={admin} onSignOut={onSignOut} />
    </header>
  );
}

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

// Who is signed in, and the way out. The business and role that used to fill the
// foot of the employee sidebar live here too.
function AccountMenu({ me, admin, onSignOut }: { me?: Me; admin: boolean; onSignOut: () => void }) {
  const name = admin ? "Administrator" : me?.full_name || me?.email || "Your account";
  const business = me?.tenant.business_name;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg pl-1 pr-2 py-1 text-left hover:bg-muted transition outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted">
        <span className="w-8 h-8 rounded-full bg-primary text-primary-foreground grid place-items-center text-xs font-semibold shrink-0">
          {admin ? <Shield className="w-4 h-4" /> : initials(me)}
        </span>
        <span className="hidden sm:block min-w-0 max-w-40">
          <span className="block text-sm font-medium leading-tight truncate">{name}</span>
          <span className="block text-xs text-muted-foreground leading-tight truncate">
            {admin ? "AnswerLabs" : me ? ROLE_LABEL[me.tenant_role] : ""}
          </span>
        </span>
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium truncate">{name}</p>
          {me?.email && <p className="text-xs text-muted-foreground truncate">{me.email}</p>}
        </DropdownMenuLabel>
        {business && (
          <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
            <Building2 className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              {business}
              {me && ` · ${ROLE_LABEL[me.tenant_role]}`}
            </span>
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut} className="cursor-pointer">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(me?: Me): string {
  return (
    (me?.full_name || me?.email || "?")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
  );
}
