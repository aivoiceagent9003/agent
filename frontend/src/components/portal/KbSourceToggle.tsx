// KbSourceToggle — where an AI campaign's agent talks from.
// On  = the business's existing knowledge base (the default).
// Off = only files uploaded to this campaign — for something the knowledge base
//       doesn't cover yet, like a project launched last week.
// Used by the campaign builder and the campaign's Agent tab.

import { Switch } from "@/components/ui/switch";

export function KbSourceToggle({
  useExisting,
  onChange,
  disabled,
}: {
  useExisting: boolean;
  onChange: (useExisting: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-xl border border-border p-4 cursor-pointer">
      <span>
        <span className="block text-sm font-medium">Talk about your existing knowledge base</span>
        <span className="block text-xs text-muted-foreground mt-1">
          {useExisting
            ? "The agent answers from the documents already in your knowledge base."
            : "The agent answers ONLY from the files you upload for this campaign. They stay out of your knowledge base — when the campaign ends, we'll ask whether to add them."}
        </span>
      </span>
      {/* The stock "off" track is near-white on this theme, so an off switch read as
          no control at all — and off is exactly the state this choice is about. */}
      <Switch
        checked={useExisting}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mt-0.5 data-[state=unchecked]:bg-muted-foreground/35"
      />
    </label>
  );
}
