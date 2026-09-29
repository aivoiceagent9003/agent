import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { ArrowLeft, Phone, Sparkles, Upload, FileText, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  useCreateCampaign,
  uploadCampaignFile,
  DEFAULT_CAMPAIGN_GREETING,
  type CampaignType,
} from "@/lib/campaigns";
import { KbSourceToggle } from "@/components/portal/KbSourceToggle";

export const Route = createFileRoute("/app/campaigns/new")({ component: NewCampaign });

// Two call types — the whole product in one choice.
const TYPES: { id: CampaignType; label: string; desc: string; example: string; icon: any }[] = [
  {
    id: "broadcast",
    label: "Template Call",
    desc: "A fixed message plays via TTS — no AI. Cheap and massively concurrent.",
    example: "“Your EMI of ₹5,000 is due on the 5th.”",
    icon: Phone,
  },
  {
    id: "ai_sales",
    label: "AI Call",
    desc: "A real AI conversation with your knowledge base, RAG, qualification and lead capture.",
    example: "“We've launched a new project — are you interested?”",
    icon: Sparkles,
  },
];

function NewCampaign() {
  const nav = useNavigate();
  const create = useCreateCampaign();
  const [name, setName] = useState("");
  const [type, setType] = useState<CampaignType>("ai_sales");
  const [fromNumber, setFromNumber] = useState("");
  // AI config
  const [prompt, setPrompt] = useState("");
  const [goal, setGoal] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxDuration, setMaxDuration] = useState(300);
  const [greeting, setGreeting] = useState(DEFAULT_CAMPAIGN_GREETING);
  // Where the agent talks from: the knowledge base, or only these files.
  const [useExistingKb, setUseExistingKb] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const needsFiles = type !== "broadcast" && !useExistingKb && files.length === 0;
  // Broadcast config
  const [message, setMessage] = useState("");

  async function submit() {
    if (!name.trim()) return;
    const config =
      type === "broadcast"
        ? { message }
        : {
            system_prompt: prompt,
            conversation_goal: goal,
            temperature,
            max_duration_seconds: maxDuration,
            campaign_greeting: greeting.trim(),
            kb_source: useExistingKb ? "existing" : "campaign",
          };
    const c = await create.mutateAsync({ name, type, from_number: fromNumber || null, config });
    // The files need the campaign's id, so they go up once it exists. A file that
    // fails is reported and can be re-added from the campaign's Agent tab.
    if (type !== "broadcast" && !useExistingKb) {
      setUploading(true);
      try {
        for (const f of files) {
          try {
            await uploadCampaignFile(c.id, f);
          } catch (e: any) {
            toast.error(`${f.name}: ${e.message || "upload failed"}`);
          }
        }
      } finally {
        setUploading(false);
      }
    }
    nav({ to: "/app/campaigns/$id", params: { id: c.id } });
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <Link
        to="/app/campaigns"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Campaigns
      </Link>
      <h1 className="text-3xl font-bold mt-3">New Campaign</h1>

      <Section title="1 · Call type">
        <div className="grid sm:grid-cols-2 gap-3">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              className={`text-left rounded-xl p-4 border transition ${type === t.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"}`}
            >
              <t.icon className="w-5 h-5 text-primary" />
              <div className="font-medium mt-2">{t.label}</div>
              <div className="text-xs text-muted-foreground mt-1">{t.desc}</div>
              <div className="text-xs text-primary/80 mt-2 italic">{t.example}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="2 · Basics">
        <Field label="Campaign name">
          <input
            className={inp}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Q3 EMI reminders"
          />
        </Field>
        <Field label="Caller ID (from number)">
          <input
            className={inp}
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            placeholder="defaults to tenant number"
          />
        </Field>
      </Section>

      {type === "broadcast" ? (
        <Section title="3 · Broadcast message">
          <Field label="Message (supports {name} and custom fields)">
            <textarea
              className={`${inp} min-h-28`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Namaste {name}, your EMI of {amount} is due on {due_date}."
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Rendered with Sarvam TTS. No AI conversation — the message plays and the call ends.
          </p>
        </Section>
      ) : (
        <Section title="3 · AI configuration">
          <Field label="Opening line">
            <textarea
              className={`${inp} min-h-20`}
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              maxLength={500}
            />
          </Field>
          <p className="text-xs text-muted-foreground -mt-1">
            The first thing the agent says when someone picks up. {"{name}"} becomes the contact's
            name; {"{agent_name}"} and {"{business_name}"} come from your agent settings.
          </p>
          <Field label="System prompt">
            <textarea
              className={`${inp} min-h-28`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="You are a warm sales agent for…"
            />
          </Field>
          <Field label="Conversation goal">
            <input
              className={inp}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Qualify the lead and book a site visit"
            />
          </Field>
          {/* There used to be free-text "Voice" and "Language" boxes here. Calls read
              neither (the voice is `tts_voice`, the language `language_mode`), so both are
              one setting for the whole agent, in Agent settings. */}
          <p className="text-xs text-muted-foreground">
            The call&apos;s voice and language follow your Agent settings.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Temperature: ${temperature}`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="w-full"
              />
            </Field>
            <Field label="Max duration (s)">
              <input
                type="number"
                className={inp}
                value={maxDuration}
                onChange={(e) => setMaxDuration(Number(e.target.value))}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Uses the same voice engine as an inbound call, with lead extraction.
          </p>
        </Section>
      )}

      {type !== "broadcast" && (
        <Section title="4 · What the agent talks about">
          <KbSourceToggle useExisting={useExistingKb} onChange={setUseExistingKb} />
          {!useExistingKb && (
            <div className="rounded-xl border border-border p-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border hover:bg-muted text-sm"
              >
                <Upload className="w-4 h-4" /> Choose files
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files || []);
                  setFiles((prev) => [...prev, ...picked]);
                  e.target.value = "";
                }}
              />
              <p className="text-xs text-muted-foreground mt-2">
                A brochure, price sheet or FAQ about what you're calling about — PDF, Word, text,
                spreadsheet or image.
              </p>
              {files.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <span className="truncate flex-1">{f.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {Math.max(1, Math.round(f.size / 1024))} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="p-1 rounded hover:bg-muted"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>
      )}

      <div className="mt-8 flex gap-2">
        <button
          onClick={submit}
          disabled={!name.trim() || needsFiles || create.isPending || uploading}
          className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50"
        >
          {uploading ? "Uploading files…" : create.isPending ? "Creating…" : "Create & add contacts"}
        </button>
        <Link
          to="/app/campaigns"
          className="px-5 py-2.5 rounded-lg border border-border hover:bg-muted"
        >
          Cancel
        </Link>
      </div>
      {needsFiles && (
        <p className="text-xs text-muted-foreground mt-2">
          Choose at least one file for the agent to talk from, or turn the knowledge base back on.
        </p>
      )}
    </div>
  );
}

const inp = "w-full px-3 py-2 rounded-lg border border-border bg-background text-sm";
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
