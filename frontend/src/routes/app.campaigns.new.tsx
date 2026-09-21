import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { ArrowLeft, Phone, Sparkles } from "lucide-react";
import { useState } from "react";
import { useCreateCampaign, type CampaignType } from "@/lib/campaigns";

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
  const [voice, setVoice] = useState("");
  const [language, setLanguage] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxDuration, setMaxDuration] = useState(300);
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
            voice,
            response_language: language,
            temperature,
            max_duration_seconds: maxDuration,
          };
    const c = await create.mutateAsync({ name, type, from_number: fromNumber || null, config });
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Voice">
              <input
                className={inp}
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                placeholder="Aoede"
              />
            </Field>
            <Field label="Language">
              <input
                className={inp}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="auto / English / Hindi"
              />
            </Field>
          </div>
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
            Uses the same voice engine as an inbound call, your knowledge base, RAG, and lead extraction.
          </p>
        </Section>
      )}

      <div className="mt-8 flex gap-2">
        <button
          onClick={submit}
          disabled={!name.trim() || create.isPending}
          className="px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Create & add contacts"}
        </button>
        <Link
          to="/app/campaigns"
          className="px-5 py-2.5 rounded-lg border border-border hover:bg-muted"
        >
          Cancel
        </Link>
      </div>
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
