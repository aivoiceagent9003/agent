import { createFileRoute } from "@tanstack/react-router";
import {
  Zap,
  Copy,
  Check,
  RefreshCw,
  Webhook,
  Phone,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  useInstantInfo,
  useUpdateInstant,
  useRotateInstantToken,
  DEFAULT_SKIP_STATUSES,
  type InstantInfo,
} from "@/lib/instant";

export const Route = createFileRoute("/app/instant")({ component: InstantCalls });

const PRESET_LABELS: Record<string, string> = {
  generic: "Generic webhook",
  zoho: "Zoho CRM",
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  meta_lead_ads: "Meta Lead Ads",
  google_lead_ads: "Google Lead Ads",
};

function InstantCalls() {
  const { data: info, isLoading } = useInstantInfo();
  const update = useUpdateInstant();
  const rotate = useRotateInstantToken();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, k: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(k);
    setTimeout(() => setCopied(null), 1500);
  };

  // Caller-ID field: seed from server, save on blur.
  const [from, setFrom] = useState("");
  useEffect(() => {
    if (info) setFrom(info.from_number || "");
  }, [info?.from_number]);
  const fromChanged = !!info && from.trim() !== (info.from_number || "");

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold flex items-center gap-3">
        <Zap className="w-7 h-7 text-primary" /> Instant Calls
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        The moment your CRM, website form, or lead ads get a new entry, your AI agent calls them —
        within seconds. No campaign to create, start or schedule.
      </p>

      {isLoading || !info ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="bg-card border border-border rounded-xl p-5 flex items-center justify-between">
            <div>
              <div className="font-semibold text-sm">
                Instant calling is {info.enabled ? "on" : "off"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {info.enabled
                  ? "New entries POSTed to the URL below are called immediately."
                  : "Incoming entries are rejected until you turn this on."}
              </div>
            </div>
            <button
              onClick={() => update.mutate({ enabled: !info.enabled })}
              disabled={update.isPending}
              className={`relative w-11 h-6 rounded-full transition ${info.enabled ? "bg-success" : "bg-muted"}`}
              aria-label="Toggle instant calls"
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${info.enabled ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
          </div>

          <div className="bg-card border border-border rounded-xl p-5 space-y-2">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Phone className="w-4 h-4 text-primary" /> Caller ID (from number)
            </h3>
            <p className="text-xs text-muted-foreground">
              The number leads see when the AI calls. Enter it in full international format, e.g.{" "}
              <code className="text-[11px]">+918071583556</code> — a national format like{" "}
              <code className="text-[11px]">08071583556</code> is rejected by the carrier.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="+918071583556"
                className="flex-1 min-w-56 px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
              <button
                onClick={() => update.mutate({ from_number: from.trim() })}
                disabled={!fromChanged || update.isPending}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                {update.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            {!from.trim() && (
              <p className="text-xs text-amber-500">
                No caller ID set — calls fall back to your tenant number, which may be in the wrong
                format. Set it explicitly here.
              </p>
            )}
          </div>

          <CallRules info={info} update={update} />

          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Webhook className="w-4 h-4 text-primary" /> Connect your system
            </h3>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Which system will send new entries?
              </div>
              <div className="flex flex-wrap gap-2">
                {info.presets.map((p) => (
                  <button
                    key={p}
                    onClick={() => update.mutate({ preset: p })}
                    className={`text-xs px-3 py-1.5 rounded-full border ${info.active_preset === p ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:bg-muted"}`}
                  >
                    {PRESET_LABELS[p] || p}
                  </button>
                ))}
              </div>
            </div>

            <Copyable label="POST URL" value={info.url} k="url" copied={copied} onCopy={copy} />
            <div>
              <Copyable
                label={`Header — ${info.header}`}
                value={info.token}
                k="token"
                copied={copied}
                onCopy={copy}
              />
              <button
                onClick={() => rotate.mutate()}
                disabled={rotate.isPending}
                className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted"
              >
                <RefreshCw className={`w-3 h-3 ${rotate.isPending ? "animate-spin" : ""}`} /> Rotate
                token
              </button>
            </div>

            <p className="text-xs text-muted-foreground">
              Calls use your agent's settings (prompt, voice, language, knowledge base) and show up
              in Calls with leads captured — your suppression / DND list is respected.
            </p>
          </div>

          <SetupGuide info={info} copied={copied} onCopy={copy} />
        </div>
      )}
    </div>
  );
}

// ─── Per-CRM setup guide (Zoho done; others coming) ──────────────────────────
function SetupGuide({
  info,
  copied,
  onCopy,
}: {
  info: InstantInfo;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const preset = info.active_preset;
  // The one URL clients paste into their CRM — token pre-appended so no header needed.
  const notifyUrl = `${info.url}?token=${info.token}`;

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-sm font-semibold"
      >
        <BookOpen className="w-4 h-4 text-primary" />
        Step-by-step: connect {PRESET_LABELS[preset] || preset}
        {open ? (
          <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 ml-auto text-muted-foreground" />
        )}
      </button>

      {open &&
        (preset === "zoho" ? (
          <ZohoGuide notifyUrl={notifyUrl} copied={copied} onCopy={onCopy} />
        ) : preset === "salesforce" ? (
          <SalesforceGuide url={info.url} token={info.token} copied={copied} onCopy={onCopy} />
        ) : preset === "google_lead_ads" ? (
          <GoogleGuide url={info.url} token={info.token} copied={copied} onCopy={onCopy} />
        ) : preset === "meta_lead_ads" ? (
          <MetaGuide notifyUrl={notifyUrl} token={info.token} copied={copied} onCopy={onCopy} />
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            A guided walkthrough for {PRESET_LABELS[preset] || preset} is coming soon. For now: in
            your system, create a webhook / automation that sends a <b>POST</b> to the URL above
            whenever a new record is created, including the contact's{" "}
            <code className="text-[11px]">phone</code> (and optionally{" "}
            <code className="text-[11px]">name</code>). Prefer JSON body. Once it fires with a phone
            number, the AI calls automatically.
          </p>
        ))}
    </div>
  );
}

function ZohoGuide({
  notifyUrl,
  copied,
  onCopy,
}: {
  notifyUrl: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div className="mt-4 space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        Do this once. Takes about 5 minutes. Make sure you've set your <b>Caller ID</b> above first.
      </p>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Your webhook URL (already includes your token — paste this whole thing into Zoho)
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs break-all">
            {notifyUrl}
          </code>
          <button
            onClick={() => onCopy(notifyUrl, "notify")}
            className="p-2 rounded-lg border border-border hover:bg-muted"
          >
            {copied === "notify" ? (
              <Check className="w-4 h-4 text-success" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      <Step n={1} title="Create the webhook">
        In Zoho CRM, click the <b>Setup</b> gear (top-right) → <b>Automation</b> → <b>Actions</b> →{" "}
        <b>Webhooks</b> → <b>Configure Webhook</b>. Fill in:
        <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">
          <li>
            <b>Name:</b> Instant call on new lead
          </li>
          <li>
            <b>URL to Notify:</b> paste the URL above
          </li>
          <li>
            <b>Method:</b> POST
          </li>
          <li>
            <b>Module:</b> Leads
          </li>
          <li>
            <b>Authorization Type:</b> General
          </li>
        </ul>
      </Step>

      <Step n={2} title="Set the Body to Raw → JSON">
        Find the <b>Body</b> section and set <b>Type → Raw → JSON</b>.
        <span className="block mt-1 text-amber-500">Do not pick Form-Data — it won't work.</span>
      </Step>

      <Step n={3} title="Add the Module Parameters">
        Add these rows. The <b>Parameter Name</b> on the left must be typed <b>exactly</b> as shown:
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5">Parameter Name</th>
                <th className="text-left px-3 py-1.5">Module</th>
                <th className="text-left px-3 py-1.5">Field</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-3 py-1.5 font-mono">Phone</td>
                <td className="px-3 py-1.5">Leads</td>
                <td className="px-3 py-1.5">Phone</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">Mobile</td>
                <td className="px-3 py-1.5">Leads</td>
                <td className="px-3 py-1.5">Mobile</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">Full_Name</td>
                <td className="px-3 py-1.5">Leads</td>
                <td className="px-3 py-1.5">First Name</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">Lead_Status</td>
                <td className="px-3 py-1.5">Leads</td>
                <td className="px-3 py-1.5">Lead Status</td>
              </tr>
            </tbody>
          </table>
        </div>
        <span className="block mt-1 text-muted-foreground text-xs">
          <b>Lead_Status</b> lets us call only new leads and skip ones already marked Contacted —
          turn that on under “Only call new leads” above.
        </span>
        Then <b>Save</b> the webhook.
      </Step>

      <Step n={4} title="Create the trigger (workflow rule)">
        Go to <b>Setup</b> → <b>Automation</b> → <b>Workflow Rules</b> → <b>Create Rule</b>.
        <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">
          <li>
            <b>Module:</b> Leads
          </li>
          <li>
            <b>When:</b> On a record action → <b>Create</b>
          </li>
          <li>
            <b>Condition:</b> All Leads
          </li>
          <li>
            <b>Instant Action:</b> Webhook → select <b>Instant call on new lead</b>
          </li>
        </ul>
        Save and activate the rule.
      </Step>

      <Step n={5} title="Test it">
        Add a new Lead with a <b>Phone or Mobile number filled in</b>. Your AI agent calls within
        seconds, and the call shows up in <b>Calls</b>.
        <span className="block mt-1 text-muted-foreground">
          If nothing happens, the lead almost always had an empty phone field — that's the #1 cause.
        </span>
      </Step>
    </div>
  );
}

function SalesforceGuide({
  url,
  token,
  copied,
  onCopy,
}: {
  url: string;
  token: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  })();
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return (
    <div className="mt-4 space-y-4 text-sm">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
        Salesforce is more involved than Zoho (≈15 min, needs an <b>admin</b>). If you'd rather skip
        it, a tool like Zapier or Make can connect a “New Salesforce Lead” trigger to a webhook in a
        few clicks. Otherwise, follow these three parts exactly.
      </div>

      <div className="space-y-2">
        <Copyable
          label="Named Credential URL (the origin only)"
          value={origin}
          k="sf-origin"
          copied={copied}
          onCopy={onCopy}
        />
        <Copyable
          label="URL Path (for the HTTP Callout)"
          value={path}
          k="sf-path"
          copied={copied}
          onCopy={onCopy}
        />
        <Copyable
          label="token value (query parameter)"
          value={token}
          k="sf-token"
          copied={copied}
          onCopy={onCopy}
        />
      </div>

      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
        Part 1 · Named Credential
      </div>

      <Step n={1} title="Create the External Credential">
        Setup → <b>Named Credentials</b> → <b>External Credentials</b> tab → <b>New</b>. Label{" "}
        <code>InstantCallCred</code>, Authentication Protocol <b>Custom</b>.
        <span className="block mt-1 text-amber-500">
          Use <b>Custom</b>, not “No Authentication” — the latter creates no principal, and the
          callout can't get access.
        </span>
      </Step>

      <Step n={2} title="Add a Principal">
        Open the <b>InstantCallCred</b> record (click its blue label — the Principals section is on
        the detail page). In <b>Principals</b> → <b>New</b>: Parameter Name <code>Default</code>,
        Sequence <code>1</code>, Identity Type <b>Named Principal</b>. Leave auth fields blank →
        Save.
      </Step>

      <Step n={3} title="Create the Named Credential">
        <b>Named Credentials</b> tab → <b>New</b>. Label <code>InstantCall</code>, URL = the{" "}
        <b>Named Credential URL</b> above, External Credential <code>InstantCallCred</code>.
        <b> Uncheck</b> “Generate Authorization Header”, enable for callouts → Save.
      </Step>

      <Step n={4} title="Grant access — and assign it to the user">
        Setup → <b>Permission Sets</b> → new set <b>InstantCall Access</b> →{" "}
        <b>External Credential Principal Access</b> → add <code>InstantCallCred - Default</code> →
        Save.
        <span className="block mt-1 text-amber-500">
          Then <b>Manage Assignments</b> → assign the set to the user who creates leads. The flow
          runs as that user; without this the callout fails with “We couldn't access the
          credential(s).”
        </span>
      </Step>

      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
        Part 2 · HTTP Callout
      </div>

      <Step n={5} title="Create the callout (no body, query params)">
        In your Flow, <b>＋ → Action → Create HTTP Callout</b>. Label <code>InstantCallQ</code>,
        Method <b>POST</b>, Named Credential <code>InstantCall</code>.
        <ul className="mt-2 space-y-1 list-disc pl-5 text-muted-foreground">
          <li>
            <b>URL Path:</b> paste the <b>URL Path</b> above (no “?”).
          </li>
          <li>
            <b>Query Parameter Keys:</b> add four keys — <code>token</code>, <code>phone</code>,{" "}
            <code>name</code>, <code>status</code>.
          </li>
          <li>
            <b>Request Body:</b> leave it <b>empty</b>.
          </li>
          <li>
            <b>Sample response:</b> <code>{`{"ok":true}`}</code> → Save.
          </li>
        </ul>
        <span className="block mt-1 text-amber-500">
          Don't type a sample body — any text there creates a required Apex Body input (“Enter a
          value for the Body input parameter”).
        </span>
      </Step>

      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
        Part 3 · Flow
      </div>

      <Step n={6} title="Create a record-triggered Flow">
        Setup → <b>Flows</b> → New → <b>Record-Triggered Flow</b>. Object <b>Lead</b>, trigger{" "}
        <b>A record is created</b>, optimize for <b>Actions and Related Records</b>. Then on the{" "}
        <b>Start</b> element add a <b>Run Asynchronously</b> path.
        <span className="block mt-1 text-amber-500">
          The action must sit on the async path — Salesforce can't make a callout during the record
          save.
        </span>
      </Step>

      <Step n={7} title="Add the action and map the values">
        On the async path, <b>＋ → Action → InstantCallQ</b>. Set the three query values:
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5">Key</th>
                <th className="text-left px-3 py-1.5">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-3 py-1.5 font-mono">token</td>
                <td className="px-3 py-1.5 font-mono break-all">{token}</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">phone</td>
                <td className="px-3 py-1.5 font-mono">{`{!$Record.Phone}`}</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">name</td>
                <td className="px-3 py-1.5 font-mono">{`{!$Record.FirstName}`}</td>
              </tr>
              <tr>
                <td className="px-3 py-1.5 font-mono">status</td>
                <td className="px-3 py-1.5 font-mono">{`{!$Record.Status}`}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <span className="block mt-1 text-muted-foreground text-xs">
          <b>status</b> lets us call only new leads and skip ones already marked Contacted — enable
          it under “Only call new leads” above.
        </span>
      </Step>

      <Step n={8} title="Activate & test">
        Name it “Call new leads”, Save and <b>Activate</b>. Create a Lead with a <b>Phone number</b>{" "}
        — the AI calls within a few seconds (async runs just after the save), and the call appears
        in <b>Calls</b>.
        <span className="block mt-1 text-muted-foreground">
          If it doesn't ring, check Setup → <b>Paused And Failed Flow Interviews</b> and the
          flow-error email for the exact reason.
        </span>
      </Step>
    </div>
  );
}

function GoogleGuide({
  url,
  token,
  copied,
  onCopy,
}: {
  url: string;
  token: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div className="mt-4 space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        Google sends each new lead straight to us. Do this once on your Lead Form. Make sure your{" "}
        <b>Caller ID</b> is set above, and that your form asks for a <b>phone number</b>.
      </p>

      <div className="space-y-2">
        <Copyable label="Webhook URL" value={url} k="g-url" copied={copied} onCopy={onCopy} />
        <Copyable
          label="Key (paste this in Google's “Key” field)"
          value={token}
          k="g-key"
          copied={copied}
          onCopy={onCopy}
        />
      </div>

      <Step n={1} title="Open your Lead Form's webhook settings">
        In <b>Google Ads</b>, open the campaign or asset that has your <b>Lead Form</b> → edit it →
        scroll to <b>Lead delivery</b> / <b>Webhook integration</b>.
      </Step>
      <Step n={2} title="Paste the URL and Key">
        <ul className="mt-1 space-y-1 list-disc pl-5 text-muted-foreground">
          <li>
            <b>Webhook URL:</b> paste the Webhook URL above.
          </li>
          <li>
            <b>Key:</b> paste the Key above (that's your instant-call token — Google sends it back
            so we know it's you).
          </li>
        </ul>
      </Step>
      <Step n={3} title="Send test data">
        Click <b>Send test data</b> in Google Ads. You should get a success response, and see{" "}
        <code className="text-[11px]">[INSTANT] ingress preset=google_lead_ads</code> in your logs.
        <span className="block mt-1 text-muted-foreground">
          Test leads carry a fake phone, so they may not ring — but a success + log line means the
          connection works.
        </span>
      </Step>
      <Step n={4} title="Go live">
        Save the form. Real leads now call automatically — we read Google's{" "}
        <code className="text-[11px]">PHONE_NUMBER</code> and{" "}
        <code className="text-[11px]">FULL_NAME</code> fields for you.
      </Step>
    </div>
  );
}

function MetaGuide({
  notifyUrl,
  token,
  copied,
  onCopy,
}: {
  notifyUrl: string;
  token: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div className="mt-4 space-y-4 text-sm">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
        Meta's webhook doesn't include the phone number directly (it needs an app + review to fetch
        it), so the simplest reliable way is to pass leads through <b>Zapier</b> or <b>Make</b> — or
        Meta's built-in CRM sync. Both take a few minutes and need no Meta app.
      </div>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Your webhook URL (token included — paste into Zapier/Make)
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs break-all">
            {notifyUrl}
          </code>
          <button
            onClick={() => onCopy(notifyUrl, "m-url")}
            className="p-2 rounded-lg border border-border hover:bg-muted"
          >
            {copied === "m-url" ? (
              <Check className="w-4 h-4 text-success" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
        Option A · Zapier or Make (recommended)
      </div>
      <Step n={1} title="Create the trigger">
        In Zapier (or Make), new Zap → Trigger <b>Facebook Lead Ads</b> → <b>New Lead</b>. Connect
        your Facebook Page and select the lead form.
      </Step>
      <Step n={2} title="Add a webhook action">
        Action <b>Webhooks by Zapier → POST</b>.
        <ul className="mt-1 space-y-1 list-disc pl-5 text-muted-foreground">
          <li>
            <b>URL:</b> paste the webhook URL above.
          </li>
          <li>
            <b>Payload type:</b> JSON.
          </li>
          <li>
            <b>Data:</b> <code className="text-[11px]">phone</code> → the form's Phone field;{" "}
            <code className="text-[11px]">name</code> → Full Name.
          </li>
        </ul>
      </Step>
      <Step n={3} title="Turn it on & test">
        Publish the Zap, then submit a test lead with Meta's <b>Lead Ads Testing Tool</b>. You'll
        see <code className="text-[11px]">[INSTANT] ingress</code> in your logs and the phone rings.
      </Step>

      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
        Option B · Route through your CRM
      </div>
      <Step n={1} title="Connect Meta to your CRM">
        If you already send Meta leads into Zoho or Salesforce (via Meta's native CRM integration),
        you don't need anything here — just set up that CRM's guide instead. Meta → CRM → us.
      </Step>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
        {n}
      </div>
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="mt-1 text-xs leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function CallRules({
  info,
  update,
}: {
  info: InstantInfo;
  update: ReturnType<typeof useUpdateInstant>;
}) {
  const [days, setDays] = useState<number>(info.skip_recent_days || 30);
  const daysOn = info.skip_recent_days > 0;
  useEffect(() => {
    if (info.skip_recent_days > 0) setDays(info.skip_recent_days);
  }, [info.skip_recent_days]);

  const statusOn = info.skip_statuses.length > 0;
  const [statusText, setStatusText] = useState<string>(info.skip_statuses.join(", "));
  useEffect(() => {
    setStatusText(info.skip_statuses.join(", "));
  }, [info.skip_statuses.join(",")]);
  const parse = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-primary" /> Only call new leads
      </h3>

      {/* Status rule — the main one for CRM manual entries */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={statusOn}
            onChange={(e) =>
              update.mutate({ skip_statuses: e.target.checked ? DEFAULT_SKIP_STATUSES : [] })
            }
          />
          <span>Skip leads whose status is already worked (Contacted, Qualified, …)</span>
        </label>
        {statusOn && (
          <div className="pl-6 space-y-1">
            <div className="text-xs text-muted-foreground">
              Statuses to skip — call goes out only when the lead's status is <b>not</b> one of
              these:
            </div>
            <input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              onBlur={() => {
                const next = parse(statusText);
                if (next.join(",").toLowerCase() !== info.skip_statuses.join(","))
                  update.mutate({ skip_statuses: next });
              }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              placeholder="contacted, qualified, converted, closed, lost"
            />
            <div className="text-xs text-muted-foreground">
              Send the lead's status in the webhook (e.g. Zoho{" "}
              <code className="text-[11px]">Lead_Status</code>, Salesforce{" "}
              <code className="text-[11px]">Status</code>). A lead marked New (or with no status) is
              called; one marked Contacted is skipped.
            </div>
          </div>
        )}
      </div>

      {/* Recent-contact guard — for people who reached us before */}
      <label className="flex flex-wrap items-center gap-2 text-sm border-t border-border pt-3">
        <input
          type="checkbox"
          checked={daysOn}
          onChange={(e) => update.mutate({ skip_recent_days: e.target.checked ? days || 30 : 0 })}
        />
        <span>Also skip anyone we've already called in the last</span>
        <input
          type="number"
          min={1}
          max={365}
          value={days}
          disabled={!daysOn}
          onChange={(e) => setDays(Number(e.target.value))}
          onBlur={() => {
            if (daysOn && days !== info.skip_recent_days) update.mutate({ skip_recent_days: days });
          }}
          className="w-16 px-2 py-1 rounded-lg border border-border bg-background text-sm disabled:opacity-50"
        />
        <span>days</span>
      </label>
      <p className="text-xs text-muted-foreground">
        You can also skip one specific lead by sending{" "}
        <code className="text-[11px]">do_not_call: true</code> in the webhook.
      </p>
    </div>
  );
}

function Copyable({
  label,
  value,
  k,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  k: string;
  copied: string | null;
  onCopy: (v: string, k: string) => void;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-xs break-all">
          {value}
        </code>
        <button
          onClick={() => onCopy(value, k)}
          className="p-2 rounded-lg border border-border hover:bg-muted"
        >
          {copied === k ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
