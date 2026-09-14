import { useState } from "react";
import { toast } from "sonner";
import { Sparkles, Trash2, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { compileCompanyRules, type CompanyRule } from "@/lib/data";

// "Is the agent doing what you need?" — asked right under the voice tester, because
// the moment someone has just HEARD the agent is the moment they can actually say
// what is wrong with it. Asking the same question on a cold setup form got answers
// like "be professional"; asking it here gets "don't quote a price before you know
// which project they mean".
//
// Their plain English is compiled server-side into rules for the COMPANY layer, which
// sits beneath their industry template. Two real-estate firms share a template and
// still get different calls — that difference lives here.
//
// Controlled, like LiveDataSetup: the parent owns the array and saves it with the
// rest of the agent config, so a rule added here is live in the tester immediately.

const MAX_RULES = 40;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

type Rejection = { text: string; reason: string; suggestion?: string };

export function CompanyRules({
  rules,
  onChange,
  config,
}: {
  rules: CompanyRule[];
  onChange: (next: CompanyRule[]) => void;
  /** The draft config, so the compiler knows whose agent it is writing for. */
  config?: any;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);

  const full = rules.length >= MAX_RULES;

  async function submit() {
    const feedback = text.trim();
    if (!feedback || pending) return;

    setPending(true);
    setRejected([]);
    try {
      const res = await compileCompanyRules({ feedback, config });
      const added: CompanyRule[] = (res.rules || []).map((r) => ({
        id: newId(),
        text: r.text,
        source: r.source,
        created_at: new Date().toISOString(),
      }));

      if (added.length) {
        onChange([...rules, ...added].slice(0, MAX_RULES));
        toast.success(added.length === 1 ? "Rule added" : `${added.length} rules added`);
        setText("");
      }
      setRejected(res.rejected || []);

      // Nothing usable came back at all — say so, rather than leaving a button that
      // looks like it did nothing.
      if (!added.length && !(res.rejected || []).length) {
        toast.error("Couldn't turn that into a rule. Try describing the behaviour you want.");
      }
    } catch (e: any) {
      toast.error(e.message || "Could not add that right now");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" /> Anything it should do differently?
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          You've just heard your agent. If something was missing, wrong, or not how your business
          does it, say so in plain English — we'll turn it into instructions and you can test it
          again straight away.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={pending || full}
          rows={4}
          placeholder={
            "e.g. Always ask which project they're calling about before talking about price. Don't offer site visits on Sunday — we're closed. If they ask for the builder directly, take their number and say someone will call back."
          }
          className="mt-3 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-y disabled:opacity-60"
        />

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {full
              ? `You've reached ${MAX_RULES} rules — remove one to add another.`
              : "Write it the way you'd explain it to a new receptionist."}
          </span>
          <button
            onClick={submit}
            disabled={!text.trim() || pending || full}
            className="shrink-0 inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-50"
          >
            {pending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Adding…
              </>
            ) : (
              <>
                Add to my agent <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Asks that collide with a safety or accuracy rule. Shown in their own words
          with the nearest thing we can actually do, so a "no" still moves them
          forward rather than reading as a broken feature. */}
      {rejected.map((r, i) => (
        <div
          key={`${r.text}-${i}`}
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">We can't set that one up</div>
              <p className="mt-1 text-xs text-muted-foreground italic">"{r.text}"</p>
              <p className="mt-2 text-xs">{r.reason}</p>
              {r.suggestion && (
                <p className="mt-2 text-xs">
                  <span className="font-medium">What we can do instead: </span>
                  {r.suggestion}
                </p>
              )}
            </div>
            <button
              onClick={() => setRejected(rejected.filter((_, idx) => idx !== i))}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {rules.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm">
            Your agent's rules{" "}
            <span className="font-normal text-muted-foreground">({rules.length})</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            These apply on top of your industry setup, on every call.
          </p>

          <ul className="mt-3 divide-y divide-border">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="mt-1.5 w-1 h-1 rounded-full bg-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{r.text}</p>
                  {r.source && (
                    <p className="mt-1 text-xs text-muted-foreground italic truncate">
                      you said: "{r.source}"
                    </p>
                  )}
                </div>
                <button
                  onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
                  className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-muted"
                  aria-label="Remove rule"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
