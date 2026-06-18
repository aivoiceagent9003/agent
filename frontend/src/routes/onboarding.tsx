import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2,
  UserCheck,
  Headset,
  Calendar,
  Bell,
  Package,
  Sparkles,
  Phone,
  Check,
  ArrowRight,
  ArrowLeft,
  Upload,
  FileText,
} from "lucide-react";
import { useRequireAuth } from "@/lib/use-auth";
import { VoiceTester } from "@/components/portal/VoiceTester";
import { LiveDataSetup } from "@/components/portal/LiveDataSetup";
import {
  useAgentTemplates,
  useClientKnowledge,
  useAgent,
  useVoices,
  fetchTemplate,
  generatePrompt,
  uploadKnowledgeFile,
  useSaveAgent,
  usePublishAgent,
  type AgentTemplate,
  type LookupConfig,
} from "@/lib/data";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Set up your agent — Vocera" }] }),
  component: Onboarding,
});

const ICONS: Record<string, any> = {
  building: Building2,
  "user-check": UserCheck,
  headset: Headset,
  calendar: Calendar,
  bell: Bell,
  package: Package,
};

const STEPS = ["Choose your agent", "Business setup", "Knowledge", "Live data", "Test", "Review & activate"];

function Onboarding() {
  const ready = useRequireAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: templates = [] } = useAgentTemplates();
  const { data: kb = [] } = useClientKnowledge();
  const { data: agent } = useAgent();
  const { data: voices = [] } = useVoices();
  const saveAgent = useSaveAgent();
  const publishAgent = usePublishAgent();

  const [step, setStep] = useState(0);
  const [working, setWorking] = useState(false);

  // Step 1 — how to build the agent
  const [mode, setMode] = useState<"template" | "custom">("template");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");

  // The base config produced from the chosen template or the custom generator.
  const [builtConfig, setBuiltConfig] = useState<any>(null);

  // Step 2 — business details
  const [agentName, setAgentName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [phone, setPhone] = useState("");
  const [handoff, setHandoff] = useState("");
  const [multilingual, setMultilingual] = useState(true);
  const [voice, setVoice] = useState("");

  // Prefill the business name from the tenant created at signup.
  useEffect(() => {
    if (agent && !businessName) {
      setBusinessName(agent.config?.business_name || agent.name || "");
    }
  }, [agent, businessName]);

  // Step 3 — knowledge upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Step 4 — live data lookups (orders, dues, bookings…)
  const [lookups, setLookups] = useState<LookupConfig[]>([]);

  if (!ready) return null;

  // Config built so far + the latest business-setup overrides. Used for both the
  // live test and the final activation, so testing reflects unsaved settings.
  function draftConfig() {
    const cfg: any = {
      ...(builtConfig || {}),
      agent_name: agentName,
      business_name: businessName,
      allow_multilingual: multilingual,
    };
    if (handoff.trim()) {
      cfg.handoff_number = handoff.trim();
      cfg.enable_handoff = true;
    }
    if (lookups.length) {
      cfg.lookups = lookups;
      cfg.enable_lookups = true;
    }
    if (voice.trim()) cfg.voice = voice.trim();
    return cfg;
  }

  async function buildAndContinue() {
    setWorking(true);
    try {
      let config: any;
      if (mode === "template") {
        if (!selectedId) throw new Error("Please pick an agent to continue");
        const tpl = await fetchTemplate(selectedId);
        config = tpl.config || {};
      } else {
        if (!goal.trim()) throw new Error("Please describe what your agent should do");
        const langs = multilingual ? ["English", "Hindi"] : ["English"];
        const res = await generatePrompt({ goal, languages: langs });
        config = res.config || {};
      }
      setBuiltConfig(config);
      setAgentName(config.agent_name || "Priya");
      if (typeof config.allow_multilingual === "boolean") setMultilingual(config.allow_multilingual);
      if (config.handoff_number) setHandoff(config.handoff_number);
      if (Array.isArray(config.lookups)) setLookups(config.lookups);
      if (config.voice) setVoice(config.voice);
      setStep(1);
    } catch (e: any) {
      toast.error(e.message || "Could not prepare your agent");
    } finally {
      setWorking(false);
    }
  }

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let total = 0;
    try {
      for (const file of Array.from(files)) {
        try {
          const res = await uploadKnowledgeFile(file);
          total += res.chunks_added;
          toast.success(`${file.name}: ${res.chunks_added} chunks added`);
        } catch (e: any) {
          toast.error(`${file.name}: ${e.message || "upload failed"}`);
        }
      }
      if (total > 0) qc.invalidateQueries({ queryKey: ["client", "knowledge"] });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function activate() {
    if (!phone.trim()) {
      toast.error("Please enter the mobile number to automate");
      return;
    }
    setWorking(true);
    try {
      await saveAgent.mutateAsync({ config: draftConfig(), phone_number: phone.trim() });
      await publishAgent.mutateAsync();
      toast.success("Your agent is live!");
      navigate({ to: "/app" });
    } catch (e: any) {
      toast.error(e.message || "Could not activate your agent");
    } finally {
      setWorking(false);
    }
  }

  const selectedTemplate = templates.find((t) => t.id === selectedId) || null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto max-w-4xl px-6 h-16 flex items-center gap-2 font-display font-bold">
          <div className="w-8 h-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            <Phone className="w-4 h-4 text-primary-foreground" />
          </div>
          Vocera
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Step indicator */}
        <ol className="flex items-center gap-2 mb-8 flex-wrap">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <div className={`flex items-center gap-2 ${i === step ? "text-foreground" : "text-muted-foreground"}`}>
                <span
                  className={`w-6 h-6 rounded-full grid place-items-center text-xs font-medium ${
                    i < step
                      ? "bg-gradient-primary text-primary-foreground"
                      : i === step
                        ? "border border-primary text-primary"
                        : "border border-border"
                  }`}
                >
                  {i < step ? <Check className="w-3 h-3" /> : i + 1}
                </span>
                <span className="text-sm hidden sm:inline">{label}</span>
              </div>
              {i < STEPS.length - 1 && <span className="w-6 h-px bg-border" />}
            </li>
          ))}
        </ol>

        {/* ── Step 1: choose your agent ───────────────────────────────────── */}
        {step === 0 && (
          <div>
            <h1 className="text-2xl font-bold">How would you like to start?</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Pick a ready-made agent for your sector, or build a custom one from a description.
            </p>

            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setMode("template")}
                className={`text-sm rounded-lg px-4 py-2 border transition ${
                  mode === "template" ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                Pre-built agents
              </button>
              <button
                onClick={() => setMode("custom")}
                className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-4 py-2 border transition ${
                  mode === "custom" ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <Sparkles className="w-4 h-4" /> Custom
              </button>
            </div>

            {mode === "template" ? (
              <div className="mt-6 grid sm:grid-cols-2 gap-4">
                {templates.map((t: AgentTemplate) => {
                  const Icon = ICONS[t.icon] || Building2;
                  const active = selectedId === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`text-left rounded-xl p-5 border shadow-card transition ${
                        active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:bg-muted/30"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="w-10 h-10 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
                          <Icon className="w-5 h-5 text-primary-foreground" />
                        </div>
                        {active && <Check className="w-5 h-5 text-primary" />}
                      </div>
                      <h3 className="mt-3 font-semibold">{t.label}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card grid gap-3">
                <label className="text-sm text-muted-foreground">Describe what your agent should do</label>
                <textarea
                  rows={5}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. Answer calls for my dental clinic, share treatment prices and timings, and book appointments."
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  We'll generate a tailored agent persona for you. You can refine it later.
                </p>
              </div>
            )}

            <div className="mt-8 flex justify-end">
              <button
                disabled={working || (mode === "template" ? !selectedId : !goal.trim())}
                onClick={buildAndContinue}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-50"
              >
                {working ? "Preparing…" : "Continue"} <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: business setup ──────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h1 className="text-2xl font-bold">Business setup</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Tell us the number to automate and how your agent should sound.
            </p>

            <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card grid gap-5">
              <div className="grid gap-1.5">
                <label className="text-sm text-muted-foreground">Business name</label>
                <input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="e.g. Sunrise Realty"
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Used in the greeting — "…here from [business name]".</p>
              </div>

              <div className="grid gap-2">
                <label className="text-sm text-muted-foreground">Voice</label>
                <p className="text-xs text-muted-foreground -mt-1">
                  Pick how your agent should sound. Choosing a voice names the agent to match — edit the name below if you like.
                </p>
                <div className="grid sm:grid-cols-3 gap-2">
                  {voices.map((v) => {
                    const active = voice === v.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          setVoice(v.id);
                          setAgentName(v.label);
                        }}
                        className={`text-left rounded-lg border px-3 py-2.5 transition ${
                          active
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "border-border hover:bg-muted/30"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{v.label}</span>
                          {active && <Check className="w-4 h-4 text-primary" />}
                        </div>
                        <span className="text-xs text-muted-foreground">{v.note}</span>
                      </button>
                    );
                  })}
                </div>
                {voices.length === 0 && (
                  <p className="text-xs text-muted-foreground">No voices available — check your TTS provider config.</p>
                )}
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm text-muted-foreground">Agent name</label>
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Set from the voice you pick — change it here if you want a different name.</p>
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm text-muted-foreground">Mobile number to automate</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  placeholder="+91XXXXXXXXXX"
                  required
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  Calls to this number will be answered by your AI agent.
                </p>
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm text-muted-foreground">Human handoff number (optional)</label>
                <input
                  value={handoff}
                  onChange={(e) => setHandoff(e.target.value)}
                  type="tel"
                  placeholder="+91XXXXXXXXXX"
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  When a caller asks for a human, the call is warm-transferred here.
                </p>
              </div>

              <label className="flex items-center justify-between gap-3 bg-input border border-border rounded-lg px-3 py-2.5 cursor-pointer">
                <span className="text-sm">Multilingual (answer in the caller's language)</span>
                <button
                  type="button"
                  onClick={() => setMultilingual((v) => !v)}
                  className={`relative w-10 h-6 rounded-full transition ${multilingual ? "bg-gradient-primary" : "bg-muted"}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow transition ${multilingual ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </label>
            </div>

            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep(0)} className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                disabled={!phone.trim() || !agentName.trim() || !businessName.trim()}
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-50"
              >
                Continue <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: knowledge upload ────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h1 className="text-2xl font-bold">Add your knowledge</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload PDFs, Word docs, text files, or images. We extract the text so your agent can answer from it. This is optional — you can add more later.
            </p>

            <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card grid gap-4">
              <label
                className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-10 cursor-pointer hover:bg-muted/30 transition ${uploading ? "opacity-60 pointer-events-none" : ""}`}
              >
                <Upload className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm font-medium">{uploading ? "Uploading…" : "Click to upload files"}</span>
                <span className="text-xs text-muted-foreground">PDF, DOCX, TXT, CSV, or images</span>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md,.csv,.docx,image/*"
                  onChange={(e) => onUpload(e.target.files)}
                  className="hidden"
                />
              </label>

              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                  {kb.length} knowledge chunks
                </div>
                <div className="divide-y divide-border max-h-64 overflow-auto">
                  {kb.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">No knowledge yet.</div>
                  ) : (
                    kb.map((c) => (
                      <div key={c.id} className="flex items-start gap-3 py-3">
                        <FileText className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                        <p className="flex-1 text-sm line-clamp-2">{c.text}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep(1)} className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90"
              >
                {kb.length > 0 ? "Continue" : "Skip for now"} <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: live data lookups ───────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h1 className="text-2xl font-bold">Live data lookups</h1>
            <p className="text-sm text-muted-foreground mt-1">
              For details that change per caller — order status, dues, bookings —
              your agent fetches them live. Tell us where that data lives: your own
              API, or a data sheet you upload. This is optional.
            </p>

            <div className="mt-6">
              <LiveDataSetup lookups={lookups} onChange={setLookups} />
            </div>

            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep(2)} className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(4)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90"
              >
                {lookups.length > 0 ? "Continue" : "Skip for now"} <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: test the agent ──────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h1 className="text-2xl font-bold">Test your agent</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Talk to your agent and hear it reply in its real voice — no call needed. Uses your live config and knowledge base.
            </p>

            <div className="mt-6">
              <VoiceTester config={draftConfig()} />
            </div>

            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep(3)} className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(5)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90"
              >
                Continue <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 6: review & activate ───────────────────────────────────── */}
        {step === 5 && (
          <div>
            <h1 className="text-2xl font-bold">Review &amp; activate</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Confirm the details below. You can change everything later from your dashboard.
            </p>

            <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card divide-y divide-border">
              <Row label="Agent type" value={mode === "template" ? selectedTemplate?.label ?? "Pre-built" : "Custom agent"} />
              <Row label="Business" value={businessName} />
              <Row label="Agent name" value={agentName} />
              <Row label="Voice" value={voices.find((v) => v.id === voice)?.label || "Default"} />
              <Row label="Number to automate" value={phone} />
              <Row label="Human handoff" value={handoff.trim() || "Not set"} />
              <Row label="Multilingual" value={multilingual ? "Yes" : "No"} />
              <Row label="Knowledge chunks" value={String(kb.length)} />
              <Row label="Live data lookups" value={lookups.length ? `${lookups.length} configured` : "None"} />
            </div>

            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep(4)} className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                disabled={working}
                onClick={activate}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-60"
              >
                {working ? "Activating…" : "Activate agent"} <Check className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
