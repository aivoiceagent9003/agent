// MessagesPanel — internal team chat. Mounted in BOTH shells (the employee view
// and the owner/manager dashboard), so a manager and an agent are in the same
// conversation rather than two parallel systems.
//
// Three thread kinds: the whole team, 1:1 directs, and Vocera Support (answered
// from the admin panel).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useConversations,
  useMessages,
  useSendMessage,
  useTeammates,
  useOpenDirect,
  useMarkConversationRead,
  type Conversation,
  type Message,
  type Teammate,
} from "@/lib/messages";
import { useMe } from "@/lib/team";
import { Search, Send, Users, LifeBuoy, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

type Filter = "all" | "team" | "direct" | "support";

export function MessagesPanel({
  onActiveChange,
  initialConversationId,
}: {
  /** Lets the shell mute the chime for the thread currently on screen. */
  onActiveChange?: (id: string | null) => void;
  /** From ?c=… — the thread a notification link asked us to open. */
  initialConversationId?: string;
}) {
  const { data, isLoading: loadingConversations } = useConversations();
  const { data: me } = useMe();
  const { data: teammates = [] } = useTeammates();
  const conversations = data?.conversations ?? [];

  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const markRead = useMarkConversationRead();
  const openDirect = useOpenDirect();

  // Open (or reuse) the 1:1 thread with someone and jump straight into it.
  // useOpenDirect awaits its own cache invalidation, so by the time this resolves
  // the new thread is already in `conversations` and setActiveId can find it.
  async function messagePerson(profileId: string) {
    setOpening(profileId);
    try {
      setActiveId(await openDirect.mutateAsync(profileId));
    } catch (e: any) {
      toast.error(e.message || "Could not open that conversation");
    } finally {
      setOpening(null);
    }
  }

  // A notification link names the thread to open. Keyed on the value, so clicking
  // a second notification switches threads instead of leaving you on the first.
  useEffect(() => {
    if (initialConversationId) setActiveId(initialConversationId);
  }, [initialConversationId]);

  // Otherwise open the most recent thread on first load, so the pane is never empty.
  useEffect(() => {
    if (!activeId && !initialConversationId && conversations.length) {
      setActiveId(conversations[0].id);
    }
  }, [conversations, activeId, initialConversationId]);

  useEffect(() => {
    onActiveChange?.(activeId);
    return () => onActiveChange?.(null);
  }, [activeId, onActiveChange]);

  useEffect(() => {
    if (activeId) markRead.mutate(activeId);
    // markRead is a stable mutation object; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (filter !== "all" && c.kind !== filter) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) || (c.last_message?.body || "").toLowerCase().includes(q)
      );
    });
  }, [conversations, filter, search]);

  // Teammates you have no direct thread with yet. Without these, someone you had
  // never messaged was invisible here — they existed only inside the team group,
  // with no way to peel off into a 1:1.
  const startable = useMemo(() => {
    if (filter === "team" || filter === "support") return [];
    const withThread = new Set(
      conversations.filter((c) => c.kind === "direct").flatMap((c) => c.members.map((m) => m.id)),
    );
    const q = search.trim().toLowerCase();
    return teammates.filter(
      (p) =>
        !withThread.has(p.id) &&
        (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
    );
  }, [teammates, conversations, filter, search]);

  const active = conversations.find((c) => c.id === activeId) || null;

  return (
    <div className="flex h-full min-h-0">
      {/* ── Conversation list ── */}
      <aside
        className={`w-full sm:w-80 shrink-0 border-r border-border flex flex-col min-h-0 ${
          activeId ? "hidden sm:flex" : "flex"
        }`}
      >
        <div className="p-5">
          <h1 className="text-xl font-bold">Messages</h1>
        </div>

        <div className="px-5">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="w-full bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="px-5 mt-3 flex gap-1 text-sm">
          {(["all", "team", "direct", "support"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg capitalize transition ${
                filter === f
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="mt-2 flex-1 overflow-y-auto min-h-0">
          {visible.length === 0 && startable.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground text-center">
              No conversations{search ? " match your search" : " yet"}.
            </p>
          ) : (
            visible.map((c) => (
              <ConversationRow
                key={c.id}
                convo={c}
                active={c.id === activeId}
                onClick={() => setActiveId(c.id)}
              />
            ))
          )}

          {startable.length > 0 && (
            <>
              <p className="px-5 pt-5 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Team members
              </p>
              {startable.map((p) => (
                <PersonRow
                  key={p.id}
                  person={p}
                  busy={opening === p.id}
                  onClick={() => messagePerson(p.id)}
                />
              ))}
            </>
          )}
        </div>
      </aside>

      {/* ── Thread ── */}
      <section className={`flex-1 flex flex-col min-h-0 ${activeId ? "flex" : "hidden sm:flex"}`}>
        {active ? (
          <Thread
            convo={active}
            meId={me?.user_id}
            onBack={() => setActiveId(null)}
            onMessagePerson={messagePerson}
          />
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-muted-foreground">
            {/* activeId set but not in the list yet = a brand-new 1:1 whose refetch
                is still in flight. Saying "pick a conversation" there reads as a
                dead end for something that is about to appear. */}
            {activeId && (loadingConversations || openDirect.isPending)
              ? "Opening…"
              : "Pick a conversation to start reading."}
          </div>
        )}
      </section>
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");
}

// Stable per-name colour, so the same person is always the same shade.
const AVATAR_COLORS = [
  "bg-primary",
  "bg-emerald-600",
  "bg-orange-500",
  "bg-sky-600",
  "bg-violet-600",
  "bg-rose-500",
];
function avatarColor(seed: string) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[n];
}

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "w-8 h-8 text-[11px]" : "w-10 h-10 text-xs";
  return (
    <div
      className={`${dim} ${avatarColor(name)} rounded-full grid place-items-center text-white font-semibold shrink-0`}
    >
      {initials(name)}
    </div>
  );
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

function ConversationRow({
  convo,
  active,
  onClick,
}: {
  convo: Conversation;
  active: boolean;
  onClick: () => void;
}) {
  const preview = convo.last_message
    ? `${convo.last_message.from_me ? "You: " : ""}${convo.last_message.body}`
    : "No messages yet";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-5 py-3 flex gap-3 items-start transition border-l-2 ${
        active ? "bg-primary/5 border-primary" : "border-transparent hover:bg-muted/50"
      }`}
    >
      {convo.kind === "support" ? (
        <div className="w-10 h-10 rounded-full bg-primary grid place-items-center text-primary-foreground shrink-0">
          <LifeBuoy className="w-4 h-4" />
        </div>
      ) : (
        <Avatar name={convo.title} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm truncate">{convo.title}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {relativeTime(convo.last_message_at)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">{preview}</span>
          {convo.unread > 0 && (
            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold grid place-items-center">
              {convo.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// A teammate you have no thread with yet, rendered in the sidebar alongside real
// conversations. Everyone on the team is therefore always one click from a 1:1,
// whether or not anybody has messaged them before.
function PersonRow({
  person,
  busy,
  onClick,
}: {
  person: Teammate;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full text-left px-5 py-3 flex gap-3 items-center transition border-l-2 border-transparent hover:bg-muted/50 disabled:opacity-50"
    >
      <span className="relative shrink-0">
        <Avatar name={person.name} />
        {person.online && (
          <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-background" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm truncate">{person.name}</span>
          <span className="text-xs text-muted-foreground shrink-0 capitalize">{person.role}</span>
        </div>
        <span className="block text-xs text-muted-foreground truncate mt-0.5">
          {busy ? "Opening…" : person.online ? "Online — send a message" : "Send a message"}
        </span>
      </div>
    </button>
  );
}

function Thread({
  convo,
  meId,
  onBack,
  onMessagePerson,
}: {
  convo: Conversation;
  meId?: string;
  onBack: () => void;
  onMessagePerson: (profileId: string) => void;
}) {
  const { data: messages = [], isLoading } = useMessages(convo.id);
  const send = useSendMessage();
  const [draft, setDraft] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Switching threads shouldn't carry the roster panel over with it.
  useEffect(() => setShowMembers(false), [convo.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, convo.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft(""); // clear optimistically — retyping a sent message is worse than a rare re-send
    try {
      await send.mutateAsync({ conversationId: convo.id, body });
    } catch (err: any) {
      setDraft(body);
      toast.error(err.message || "Could not send");
    }
  }

  return (
    <>
      <header className="px-5 py-4 border-b border-border flex items-center gap-3">
        <button onClick={onBack} className="sm:hidden p-1 -ml-1" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        {convo.kind === "support" ? (
          <div className="w-10 h-10 rounded-full bg-primary grid place-items-center text-primary-foreground">
            <LifeBuoy className="w-4 h-4" />
          </div>
        ) : (
          <Avatar name={convo.title} />
        )}
        <div className="min-w-0">
          <h2 className="font-bold truncate">{convo.title}</h2>
          <p className="text-xs text-muted-foreground">
            {convo.kind === "team"
              ? `${convo.member_count} members`
              : convo.kind === "support"
                ? "Usually replies within a few hours"
                : convo.members[0]?.role
                  ? convo.members[0].role.charAt(0).toUpperCase() + convo.members[0].role.slice(1)
                  : "Direct message"}
          </p>
        </div>
        {convo.kind === "team" && (
          <button
            onClick={() => setShowMembers((v) => !v)}
            aria-expanded={showMembers}
            aria-label="Team members"
            className={`ml-auto p-2 rounded-lg border transition hover:bg-muted ${
              showMembers ? "border-primary text-primary" : "border-border text-muted-foreground"
            }`}
          >
            <Users className="w-4 h-4" />
          </button>
        )}
      </header>

      {/* The group is where you first meet a colleague, so it is also where you
          should be able to peel off into a private thread with them. */}
      {showMembers && convo.kind === "team" && (
        <div className="border-b border-border bg-muted/30 px-5 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
            In this group
          </p>
          {convo.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">You're the only one here so far.</p>
          ) : (
            <ul className="space-y-2">
              {convo.members.map((m) => (
                <li key={m.id} className="flex items-center gap-3">
                  <Avatar name={m.name} size="sm" />
                  <span className="text-sm truncate">{m.name}</span>
                  <span className="text-xs text-muted-foreground capitalize shrink-0">
                    {m.role}
                  </span>
                  <button
                    onClick={() => {
                      setShowMembers(false);
                      onMessagePerson(m.id);
                    }}
                    className="ml-auto text-xs font-medium text-primary hover:underline shrink-0"
                  >
                    Message
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">
            No messages yet — say hello.
          </p>
        ) : (
          <MessageList messages={messages} meId={meId} showSender={convo.kind !== "direct"} />
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="p-4 border-t border-border flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${convo.title}...`}
          className="flex-1 bg-input border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={!draft.trim() || send.isPending}
          aria-label="Send"
          className="w-11 h-11 rounded-full bg-gradient-primary text-primary-foreground grid place-items-center shadow-glow disabled:opacity-40 shrink-0"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </>
  );
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function MessageList({
  messages,
  meId,
  showSender,
}: {
  messages: Message[];
  meId?: string;
  showSender: boolean;
}) {
  let lastDay = "";
  return (
    <>
      {messages.map((m) => {
        const mine = !!meId && m.sender_id === meId;
        const day = dayLabel(m.created_at);
        const newDay = day !== lastDay;
        lastDay = day;

        return (
          <div key={m.id}>
            {newDay && (
              <div className="flex items-center gap-3 my-5">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">{day}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}

            {mine ? (
              <div className="flex flex-col items-end mb-3">
                <div className="max-w-[75%] bg-gradient-primary text-primary-foreground rounded-2xl px-4 py-2.5 text-sm">
                  {m.body}
                </div>
                <span className="text-[11px] text-muted-foreground mt-1">
                  {new Date(m.created_at).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ) : (
              <div className="mb-3">
                {showSender && (
                  <p className="text-xs text-muted-foreground mb-1 ml-12">{m.sender_name}</p>
                )}
                <div className="flex items-start gap-3">
                  <Avatar name={m.sender_name} size="sm" />
                  <div>
                    <div className="max-w-[75%] bg-muted rounded-2xl px-4 py-2.5 text-sm inline-block">
                      {m.body}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {new Date(m.created_at).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
