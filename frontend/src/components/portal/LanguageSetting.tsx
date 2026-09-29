// LanguageSetting — which language the agent speaks on calls. Two options:
//   English              — every call is in English.
//   Let the caller choose — after the greeting the agent asks which of these languages
//                           to continue in, and speaks only that one for the rest of the
//                           call (inbound and outbound alike).
// Saved as config.language_mode ('english' | 'caller_choice') and config.caller_languages.
// The backend side of this is src/services/call-language.js — keep the lists in step.

import { Check } from "lucide-react";

export type LanguageMode = "english" | "caller_choice";

// Languages the whole call stack handles end to end (hearing, script, voice).
export const CHOOSABLE_LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "te", name: "Telugu" },
  { code: "hi", name: "Hindi" },
  { code: "ta", name: "Tamil" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "mr", name: "Marathi" },
  { code: "bn", name: "Bengali" },
];
export const DEFAULT_CALLER_LANGUAGES = ["en", "te", "hi"];

const nameOf = (code: string) => CHOOSABLE_LANGUAGES.find((l) => l.code === code)?.name || code;

/** "English, Telugu or Hindi" */
export function languageList(codes: string[]) {
  const names = codes.map(nameOf);
  return names.length <= 1 ? names[0] || "" : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** One line for the review summary. */
export function languageSummary(mode: LanguageMode, codes: string[]) {
  return mode === "english" ? "English" : `Caller chooses — ${languageList(codes)}`;
}

/** The saved setting, read the way the backend reads it (call-language.js languagePlan). */
export function readLanguageSetting(cfg: any): { mode: LanguageMode; languages: string[] } {
  const mode: LanguageMode =
    cfg?.language_mode === "english" || cfg?.language_mode === "caller_choice"
      ? cfg.language_mode
      : cfg?.allow_multilingual === false
        ? "english"
        : "caller_choice";
  const known = CHOOSABLE_LANGUAGES.map((l) => l.code);
  const saved = Array.isArray(cfg?.caller_languages)
    ? known.filter((c) => cfg.caller_languages.includes(c))
    : [];
  return { mode, languages: saved.length >= 2 ? saved : DEFAULT_CALLER_LANGUAGES };
}

export function LanguageSetting({
  mode,
  languages,
  onModeChange,
  onLanguagesChange,
}: {
  mode: LanguageMode;
  languages: string[];
  onModeChange: (m: LanguageMode) => void;
  onLanguagesChange: (codes: string[]) => void;
}) {
  function toggle(code: string) {
    const on = languages.includes(code);
    if (on && languages.length <= 2) return; // a choice needs at least two languages
    const next = on ? languages.filter((c) => c !== code) : [...languages, code];
    // Kept in list order, so wherever they are listed they read "English, Telugu or Hindi".
    onLanguagesChange(CHOOSABLE_LANGUAGES.map((l) => l.code).filter((c) => next.includes(c)));
  }

  return (
    <div className="grid gap-2">
      <label className="text-sm text-muted-foreground">Language</label>
      <div className="grid sm:grid-cols-2 gap-2">
        <Option
          active={mode === "english"}
          onClick={() => onModeChange("english")}
          title="English"
          desc="Every call is in English."
        />
        <Option
          active={mode === "caller_choice"}
          onClick={() => onModeChange("caller_choice")}
          title="Let the caller choose"
          desc="After the greeting, the agent asks which language to continue in, then speaks only that language for the rest of the call."
        />
      </div>

      {mode === "caller_choice" && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 grid gap-3">
          <div className="text-xs text-muted-foreground">Languages the caller can choose from</div>
          <div className="flex flex-wrap gap-2">
            {CHOOSABLE_LANGUAGES.map((l) => {
              const on = languages.includes(l.code);
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => toggle(l.code)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full border text-sm transition ${
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {on && <Check className="w-3.5 h-3.5" />}
                  {l.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            After the greeting your agent asks:{" "}
            <span className="text-foreground">“Which language would you like to continue in?”</span>{" "}
            It lists {languageList(languages)} only if a caller asks for a language not ticked here.
          </p>
        </div>
      )}
    </div>
  );
}

function Option({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left rounded-lg border px-3 py-2.5 transition ${
        active ? "border-primary ring-1 ring-primary bg-primary/5" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
    </button>
  );
}
