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
  Trash2,
  Download,
} from "lucide-react";
import { useRequireAuth } from "@/lib/use-auth";
import { useMe } from "@/lib/team";
import { VoiceTester } from "@/components/portal/VoiceTester";
import { VoicePicker } from "@/components/portal/VoicePicker";
import { LiveDataSetup } from "@/components/portal/LiveDataSetup";
import {
  useAgentTemplates,
  useClientDocuments,
  useDeleteDocument,
  getDocumentDownloadUrl,
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
  head: () => ({ meta: [{ title: "Set up your agent — AnswerLabs" }] }),
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

const STEPS = [
  "Choose your agent",
  "Business setup",
  "Knowledge",
  "Live data",
  "Test",
  "Review & activate",
];

function Onboarding() {
  const ready = useRequireAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Agent configuration is owner-only (the backend returns 403 for everyone else).
  // Bounce employees back to the dashboard rather than showing them a form whose
  // every save would fail.
  const { data: me } = useMe();
  useEffect(() => {
    if (me && me.tenant_role !== "owner") navigate({ to: "/app" });
  }, [me, navigate]);

  const { data: templates = [] } = useAgentTemplates();
  const { data: docs = [] } = useClientDocuments();
  const deleteDocument = useDeleteDocument();
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
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingNotice, setRecordingNotice] = useState("");

  // Hydrate the form from the saved agent (runs once when it loads).
  // - First-run (no number/config yet): only prefill the business name and let
  //   the wizard start at step 0 (Choose your agent).
  // - Already set up (editing from "Agent settings"): load the full config and
  //   jump past the template picker so the client can edit any section directly
  //   instead of re-walking setup from scratch.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!agent || hydrated.current) return;
    hydrated.current = true;
    const cfg: any = agent.config || {};
    // `template_id` is what a client stores now when they pick a pre-built agent;
    // `system_prompt` is the older shape (a copied prompt) and stays here so tenants
    // created before the template engine still skip the wizard.
    const configured =
      !!agent.phone_number ||
      cfg.status === "published" ||
      !!cfg.template_id ||
      !!cfg.system_prompt;

    if (!configured) {
      // First-run wizard. Only prefill a business name the user actually gave us
      // (email/password signups pass one). Google signups have none — leave it
      // empty so they type it here rather than inheriting their Google name.
      setBusinessName(cfg.business_name || "");
      return;
    }

    setBusinessName(cfg.business_name || agent.name || "");

    setBuiltConfig(cfg);
    setAgentName(cfg.agent_name || "Priya");
    if (typeof cfg.allow_multilingual === "boolean") setMultilingual(cfg.allow_multilingual);
    if (typeof cfg.recording_enabled === "boolean") setRecordingEnabled(cfg.recording_enabled);
    if (cfg.recording_notice) setRecordingNotice(cfg.recording_notice);
    if (cfg.handoff_number) setHandoff(cfg.handoff_number);
    if (cfg.voice) setVoice(cfg.voice);
    if (Array.isArray(cfg.lookups)) setLookups(cfg.lookups);
    if (agent.phone_number) setPhone(agent.phone_number);
    setStep(1); // skip "Choose your agent" — they already have one
  }, [agent]);

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
      recording_enabled: recordingEnabled,
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
    // Custom wording is kept only while recording is on, and cleared with an
    // empty string rather than by omitting the key: the API MERGES this object
    // over the stored config, so an absent key leaves the old value in the
    // database and the wording silently reappears the next time recording is
    // switched back on.
    cfg.recording_notice = recordingEnabled ? recordingNotice.trim() : "";
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
      if (typeof config.allow_multilingual === "boolean")
        setMultilingual(config.allow_multilingual);
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
      if (total > 0) {
        qc.invalidateQueries({ queryKey: ["client", "documents"] });
        qc.invalidateQueries({ queryKey: ["client", "knowledge"] });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeDoc(id: string, filename: string) {
    if (!confirm(`Delete "${filename}" and its knowledge? This cannot be undone.`)) return;
    try {
      await deleteDocument.mutateAsync(id);
      toast.success("Document deleted");
    } catch (e: any) {
      toast.error(e.message || "Could not delete document");
    }
  }

  async function downloadDoc(id: string) {
    try {
      const url = await getDocumentDownloadUrl(id);
      window.open(url, "_blank");
    } catch (e: any) {
      toast.error(e.message || "No file to download");
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
          AnswerLabs
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Step indicator */}
        <ol className="flex items-center gap-2 mb-8 flex-wrap">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(i)}
                title={`Go to ${label}`}
                className={`flex items-center gap-2 rounded-lg px-1 py-0.5 hover:opacity-80 transition ${i === step ? "text-foreground" : "text-muted-foreground"}`}
              >
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
              </button>
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
                  mode === "template"
                    ? "border-primary text-primary bg-primary/10"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                Pre-built agents
              </button>
              <button
                onClick={() => setMode("custom")}
                className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-4 py-2 border transition ${
                  mode === "custom"
                    ? "border-primary text-primary bg-primary/10"
                    : "border-border text-muted-foreground hover:text-foreground"
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
                        active
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border bg-card hover:bg-muted/30"
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
                <label className="text-sm text-muted-foreground">
                  Describe what your agent should do
                </label>
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
                <p className="text-xs text-muted-foreground">
                  Used in the greeting — "…here from [business name]".
                </p>
              </div>

              <div className="grid gap-2">
                <label className="text-sm text-muted-foreground">Voice</label>
                <p className="text-xs text-muted-foreground -mt-1">
                  Pick how your agent should sound. Every voice speaks Indian languages (Telugu,
                  Hindi, Tamil…) natively — they differ in tone.
                </p>
                <VoicePicker voices={voices} value={voice} onChange={setVoice} />
                {voices.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No voices available — check your TTS provider config.
                  </p>
                )}
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm text-muted-foreground">Agent name</label>
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  The name your agent introduces itself with on calls (e.g. "Priya here from…").
                  Independent of the voice.
                </p>
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
                <label className="text-sm text-muted-foreground">
                  Human handoff number (optional)
                </label>
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
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow transition ${multilingual ? "left-[18px]" : "left-0.5"}`}
                  />
                </button>
              </label>

              {/* Recording is opt-in, and the disclosure is the whole reason it
                  is allowed — so the wording lives directly under the toggle, as
                  part of the same decision, rather than on a page nobody opens. */}
              <div className="grid gap-2">
                <label className="flex items-center justify-between gap-3 bg-input border border-border rounded-lg px-3 py-2.5 cursor-pointer">
                  <span className="text-sm">Record calls</span>
                  <button
                    type="button"
                    onClick={() => setRecordingEnabled((v) => !v)}
                    className={`relative w-10 h-6 rounded-full transition ${recordingEnabled ? "bg-gradient-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-card shadow transition ${recordingEnabled ? "left-[18px]" : "left-0.5"}`}
                    />
                  </button>
                </label>

                {recordingEnabled ? (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 grid gap-3">
                    <p className="text-sm">
                      Your agent tells every caller at the start of the call that it is being
                      recorded. You must say so before recording someone, so this is spoken
                      automatically — in the caller&apos;s own language.
                    </p>
                    <div className="grid gap-1.5">
                      <label className="text-sm text-muted-foreground">
                        What the agent says <span className="text-xs">(optional)</span>
                      </label>
                      <input
                        value={recordingNotice}
                        onChange={(e) => setRecordingNotice(e.target.value)}
                        placeholder="This call is recorded for quality and training purposes."
                        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave blank to use the default wording above.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Calls are not recorded and no audio is saved. Turn this on to keep
                    recordings for review — your agent will disclose it to every caller.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(0)}
                className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
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
              Upload PDFs, Word docs, text files, or images. We extract the text so your agent can
              answer from it. This is optional — you can add more later.
            </p>

            <div className="mt-6 bg-card border border-border rounded-xl p-6 shadow-card grid gap-4">
              <label
                className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-10 cursor-pointer hover:bg-muted/30 transition ${uploading ? "opacity-60 pointer-events-none" : ""}`}
              >
                <Upload className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {uploading ? "Uploading…" : "Click to upload files"}
                </span>
                <span className="text-xs text-muted-foreground">
                  PDF, DOCX, TXT, CSV, or images
                </span>
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
                  {docs.length} {docs.length === 1 ? "file" : "files"}
                </div>
                <div className="divide-y divide-border max-h-64 overflow-auto">
                  {docs.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      No files yet.
                    </div>
                  ) : (
                    docs.map((d) => (
                      <div key={d.id} className="flex items-center gap-3 py-3">
                        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{d.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {d.chunk_count} {d.chunk_count === 1 ? "chunk" : "chunks"}
                            {d.size_bytes ? ` · ${(d.size_bytes / 1024).toFixed(0)} KB` : ""}
                            {d.status !== "ready" ? ` · ${d.status}` : ""}
                          </p>
                        </div>
                        {d.source === "upload" && (
                          <button
                            onClick={() => downloadDoc(d.id)}
                            title="Download original file"
                            className="text-muted-foreground hover:text-foreground p-1 shrink-0"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => removeDoc(d.id, d.filename)}
                          title="Delete file and its knowledge"
                          className="text-muted-foreground hover:text-destructive p-1 shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90"
              >
                {docs.length > 0 ? "Continue" : "Skip for now"} <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: live data lookups ───────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h1 className="text-2xl font-bold">Live data lookups</h1>
            <p className="text-sm text-muted-foreground mt-1">
              For details that change per caller — order status, dues, bookings — your agent fetches
              them live. Tell us where that data lives: your own API, or a data sheet you upload.
              This is optional.
            </p>

            <div className="mt-6">
              <LiveDataSetup lookups={lookups} onChange={setLookups} />
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => setStep(4)}
                className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium shadow-glow hover:opacity-90"
              >
                {lookups.length > 0 ? "Continue" : "Skip for now"}{" "}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: test the agent ──────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h1 className="text-2xl font-bold">Test your agent</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Talk to your agent and hear it reply in its real voice — no call needed. Uses your
              live config and knowledge base.
            </p>

            <div className="mt-6">
              <VoiceTester config={draftConfig()} />
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
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
              <Row
                label="Agent type"
                value={
                  mode === "template" ? (selectedTemplate?.label ?? "Pre-built") : "Custom agent"
                }
              />
              <Row label="Business" value={businessName} />
              <Row label="Agent name" value={agentName} />
              <Row label="Voice" value={voices.find((v) => v.id === voice)?.label || "Default"} />
              <Row label="Number to automate" value={phone} />
              <Row label="Human handoff" value={handoff.trim() || "Not set"} />
              <Row label="Multilingual" value={multilingual ? "Yes" : "No"} />
              <Row label="Call recording" value={recordingEnabled ? "On — callers are told" : "Off"} />
              <Row label="Knowledge files" value={String(docs.length)} />
              <Row
                label="Live data lookups"
                value={lookups.length ? `${lookups.length} configured` : "None"}
              />
            </div>

            <div className="mt-8 flex justify-between">
              <button
                onClick={() => setStep(4)}
                className="inline-flex items-center gap-2 border border-border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
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
