import { useEffect, useRef, useState } from "react";
import { MessageCircle, Check, Trash2, Upload, FileText } from "lucide-react";
import {
  useWhatsapp,
  useSaveWhatsapp,
  useSendableDocs,
  useUploadSendableDoc,
  useRenameSendableDoc,
  useDeleteSendableDoc,
} from "@/lib/whatsapp";

// Messages send from the platform's WhatsApp number, so the client sets NO API keys.
// They set the contact number customers should see, and upload the files the agent
// can send — one per topic (a real-estate firm lists projects; a café lists "Menu";
// a clinic lists "Price list").
//
// These files are stored on their own, NOT in the knowledge base: they exist to be
// handed to the customer as-is, so there's no text extraction and an image-only
// brochure PDF works fine.
export function WhatsAppSettings() {
  const { data, isLoading } = useWhatsapp();
  const save = useSaveWhatsapp();

  const [phone, setPhone] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setPhone(data.display_phone || "");
  }, [data]);

  async function onSave() {
    await save.mutateAsync({ enabled: true, display_phone: phone.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  if (isLoading || !data)
    return <div className="text-sm text-muted-foreground">Loading WhatsApp…</div>;

  if (!data.platform_enabled) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <MessageCircle className="w-5 h-5 text-green-500" />
          <h3 className="font-semibold">WhatsApp</h3>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
          WhatsApp sending isn't switched on for the platform yet. Once it's live, your agent will
          send documents and confirmations automatically — no setup needed from you.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-green-500" />
          <h3 className="font-semibold">How your messages appear</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          When it fits the conversation, your agent sends the right document or a confirmation to
          the customer's WhatsApp — automatically. Messages go out with <b>your business name</b>{" "}
          and the contact number below, so customers know it's from you.
        </p>

        <label className="block max-w-xs">
          <span className="block text-xs font-medium text-muted-foreground mb-1">
            Contact number to show customers
          </span>
          <input
            className={inp}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+9199…"
          />
        </label>

        <button
          onClick={onSave}
          disabled={save.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          {saved ? (
            <>
              <Check className="w-4 h-4" /> Saved
            </>
          ) : save.isPending ? (
            "Saving…"
          ) : (
            "Save"
          )}
        </button>
      </div>

      <SendableDocuments />
    </div>
  );
}

// Upload + manage the files the agent can send. Own store — nothing here reaches
// the knowledge base, and nothing in Knowledge shows up here.
function SendableDocuments() {
  const { data: docs = [], isLoading } = useSendableDocs();
  const upload = useUploadSendableDoc();
  const rename = useRenameSendableDoc();
  const remove = useDeleteSendableDoc();

  const fileRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  async function onUpload() {
    if (!file) return;
    setError("");
    try {
      await upload.mutateAsync({ file, topic: topic.trim() });
      setTopic("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div>
        <h3 className="font-semibold">Documents the agent can send</h3>
        <p className="text-sm text-muted-foreground mt-1">
          The agent sends the document whose <b>topic</b> matches what the caller asked about — so
          name it the way callers say it. These files are only sent to customers; they're separate
          from <b>Knowledge</b> (which is what your agent reads to answer questions).
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inp} flex-1 min-w-48`}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What it's about (e.g. My Home Apas, Menu, Price list)"
          />
          <input
            ref={fileRef}
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-border file:bg-muted file:text-sm file:cursor-pointer"
          />
        </div>
        <button
          onClick={onUpload}
          disabled={!file || upload.isPending}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          <Upload className="w-4 h-4" /> {upload.isPending ? "Uploading…" : "Add document"}
        </button>
        {error && <div className="text-xs text-destructive">{error}</div>}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading documents…</div>
      ) : docs.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No documents yet — add one per topic above.
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5"
            >
              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                className={`${inp} flex-1 min-w-40`}
                defaultValue={d.topic}
                placeholder="Topic"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== d.topic) rename.mutate({ id: d.id, topic: next });
                }}
              />
              <span className="text-xs text-muted-foreground truncate max-w-56" title={d.filename}>
                {d.filename}
              </span>
              <button
                onClick={() => remove.mutate(d.id)}
                className="p-2 rounded-lg border border-border hover:bg-muted text-destructive"
                title="Remove"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inp = "px-3 py-2 rounded-lg border border-border bg-background text-sm w-full";
