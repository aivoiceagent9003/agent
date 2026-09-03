import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { LifeBuoy, Send, CornerDownLeft } from "lucide-react";
import {
  useSupportThreads,
  useSupportThread,
  useSendSupportReply,
  type SupportThread,
} from "@/lib/support";

export const Route = createFileRoute("/admin/support")({
  head: () => ({ meta: [{ title: "Support — AnswerLabs Admin" }] }),
  component: SupportInbox,
});

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function SupportInbox() {
  const { data: threads = [], isLoading } = useSupportThreads();
  const [selected, setSelected] = useState<string | null>(null);

  // Open the thread that has been waiting longest, so the page lands on the work
  // rather than on an empty pane.
  useEffect(() => {
    if (selected || !threads.length) return;
    const waiting = threads.filter((t) => t.awaiting_reply);
    const target = waiting.length ? waiting[waiting.length - 1] : threads[0];
    setSelected(target.conversation_id);
  }, [threads, selected]);

  const waitingCount = threads.filter((t) => t.awaiting_reply).length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <LifeBuoy className="w-7 h-7 text-primary" />
          Support
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Loading conversations…"
            : threads.length === 0
              ? "Nobody has messaged yet."
              : waitingCount > 0
                ? `${waitingCount} ${waitingCount === 1 ? "conversation is" : "conversations are"} waiting on a reply.`
                : "Everything answered."}
        </p>
      </header>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
        <ThreadList threads={threads} selected={selected} onSelect={setSelected} />
        <ThreadView conversationId={selected} />
      </div>
    </div>
  );
}

function ThreadList({
  threads,
  selected,
  onSelect,
}: {
  threads: SupportThread[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs uppercase tracking-wide text-muted-foreground font-medium">
        Conversations
      </div>
      <ul className="divide-y divide-border max-h-[calc(100vh-16rem)] overflow-y-auto">
        {threads.length === 0 && (
          <li className="px-4 py-6 text-sm text-muted-foreground">Nothing here yet.</li>
        )}
        {threads.map((t) => {
          const active = t.conversation_id === selected;
          return (
            <li key={t.conversation_id}>
              <button
                onClick={() => onSelect(t.conversation_id)}
                className={`w-full text-left px-4 py-3 transition ${
                  active ? "bg-muted/60" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  {/* One row is one PERSON's thread. Lead with them — a company
                      with three staff would otherwise be three identical rows. */}
                  <span className="font-medium text-sm truncate">
                    {t.person_name ?? "Unknown person"}
                  </span>
                  {/* The queue signal: the last word was the customer's. */}
                  {t.awaiting_reply && (
                    <span className="shrink-0 mt-0.5 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 bg-primary/15 text-primary">
                      Waiting
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {t.business_name}
                  {t.person_role ? " · " + t.person_role : ""}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-1">
                  {t.last_message ?? "No messages yet"}
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  {timeAgo(t.last_message_at)}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function ThreadView({ conversationId }: { conversationId: string | null }) {
  const { data, isLoading } = useSupportThread(conversationId);
  const send = useSendSupportReply(conversationId);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages.length]);

  if (!conversationId) {
    return (
      <section className="bg-card border border-border rounded-xl shadow-card p-10 text-center text-sm text-muted-foreground">
        Select a conversation to read it.
      </section>
    );
  }

  function submit() {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(body, { onError: () => setDraft(body) });
  }

  return (
    <section className="bg-card border border-border rounded-xl shadow-card flex flex-col h-[calc(100vh-16rem)]">
      <div className="px-5 py-3 border-b border-border">
        <h2 className="font-semibold text-sm">
          {data?.person_name ?? "…"}
          {data?.business_name ? (
            <span className="font-normal text-muted-foreground"> · {data.business_name}</span>
          ) : null}
        </h2>
        {/* Staff need to know this thread is private to one person: what they say
            here is not visible to the rest of that business. */}
        <p className="text-xs text-muted-foreground">
          Private to {data?.person_name ?? "this person"}. Replies are sent as AnswerLabs Support, not
          under your own name.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {data?.messages.map((m) => {
          // is_system marks our side of the thread — the customer sees one
          // consistent "AnswerLabs Support" identity regardless of which admin replies.
          const ours = m.is_system;
          return (
            <div key={m.id} className={`flex ${ours ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-xl px-3.5 py-2.5 text-sm ${
                  ours ? "bg-gradient-primary text-primary-foreground" : "bg-muted text-foreground"
                }`}
              >
                <div className="text-[11px] opacity-70 mb-0.5">
                  {ours ? "AnswerLabs Support" : m.sender_name || "Customer"} · {timeAgo(m.created_at)}
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border p-3 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the convention in every
            // chat app, so typing a multi-line reply doesn't post half of it.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Write a reply…"
          className="flex-1 resize-none bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          onClick={submit}
          disabled={!draft.trim() || send.isPending}
          className="inline-flex items-center gap-2 bg-gradient-primary text-primary-foreground rounded-lg px-4 py-2.5 text-sm font-medium shadow-glow hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
          {send.isPending ? "Sending…" : "Send"}
        </button>
      </div>

      {send.isError && (
        <p className="px-5 pb-3 text-xs text-destructive">
          That didn&apos;t send. Your text is still in the box — try again.
        </p>
      )}
      <p className="px-5 pb-3 text-[11px] text-muted-foreground/70 flex items-center gap-1">
        <CornerDownLeft className="w-3 h-3" /> Enter to send · Shift + Enter for a new line
      </p>
    </section>
  );
}
