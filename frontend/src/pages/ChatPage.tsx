import { ArrowLeft, Bot, CheckCheck, CirclePlus, LifeBuoy, Search, Send, Wrench } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import {
  Assistant,
  newUserMessage,
  statusLabel,
  ticketRef,
  ticketTitle,
  type ChatMessage,
  type ChatOption,
  type ChatRole,
  type ChatTicket,
} from "@/lib/chat";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type Thread = {
  id: string;
  title: string;
  subtitle: string;
  kind: "assistant" | "ticket";
  status?: string;
  ticketKind?: string;
  activity: number;
  unread: number;
};

const STATUS_COLORS: Record<string, string> = {
  new: "#f59e0b",
  onboarding: "#0ea5e9",
  pending_activation: "#8b5cf6",
  completed: "#10b981",
};

function threadFromTicket(ticket: ChatTicket): Thread {
  return {
    id: `ticket:${ticket.id}`,
    title: `${ticketRef(ticket.id)} ${ticketTitle(ticket)}`,
    subtitle: ticket.kind === "fault" ? "Fault ticket" : "Client onboarding",
    kind: "ticket",
    status: ticket.status,
    ticketKind: ticket.kind,
    activity: Date.parse(ticket.createdAt.replace(" ", "T")) || Date.now(),
    unread: 0,
  };
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayStamp(value: number) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/* Render *bold* segments inside message text. */
function richText(text: string): ReactNode {
  const parts = text.split(/(\*[^*]+\*)/g);
  return parts.map((part, index) =>
    part.startsWith("*") && part.endsWith("*") ? (
      <strong key={index}>{part.slice(1, -1)}</strong>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function ThreadAvatar({ thread }: { thread: Thread }) {
  if (thread.kind === "assistant") {
    return (
      <span className="chat-avatar bg-gradient-to-br from-emerald-500 to-teal-600" aria-hidden="true">
        <Bot className="h-5 w-5" />
      </span>
    );
  }
  const color = STATUS_COLORS[thread.status ?? "new"] ?? "#64748b";
  return (
    <span className="chat-avatar" style={{ background: color }} aria-hidden="true">
      {thread.ticketKind === "fault" ? <Wrench className="h-5 w-5" /> : <CirclePlus className="h-5 w-5" />}
    </span>
  );
}

function ThreadRow({ thread, active, onOpen }: { thread: Thread; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      role="listitem"
      className={cn("chat-thread", active && "chat-thread-active")}
      onClick={onOpen}
    >
      <ThreadAvatar thread={thread} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="chat-thread-name">{thread.title}</span>
          <span className="chat-thread-time ml-auto">{formatTime(thread.activity)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          {thread.status ? (
            <span
              className="chat-status-dot"
              style={{ background: STATUS_COLORS[thread.status] ?? "#64748b" }}
              aria-hidden="true"
            />
          ) : null}
          <span className="chat-thread-preview">{thread.status ? statusLabel(thread.status) : thread.subtitle}</span>
          {thread.unread > 0 ? <span className="chat-unread ml-auto">{thread.unread}</span> : null}
        </span>
      </span>
    </button>
  );
}

function Options({ options, onRun }: { options: ChatOption[]; onRun: (option: ChatOption) => void }) {
  return (
    <div className={cn("chat-options", options.length > 3 && "chat-options-list")}>
      {options.map((option) => (
        <button
          key={option.command}
          type="button"
          title={option.label}
          className={cn(
            "chat-option",
            option.tone === "success" && "chat-option-success",
            option.tone === "danger" && "chat-option-danger",
          )}
          onClick={() => onRun(option)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function MessageBubble({ message, onRun }: { message: ChatMessage; onRun: (option: ChatOption) => void }) {
  if (message.kind === "notice") return null;
  const outgoing = message.from === "user";
  return (
    <div className={cn("chat-row", outgoing && "chat-row-out")}>
      <div
        className={cn(
          "chat-bubble",
          outgoing ? "chat-bubble-out" : "chat-bubble-in",
          message.kind === "error" && "chat-bubble-error",
        )}
      >
        {message.card ? (
          <div className="chat-card">
            <p className="chat-card-title">
              {message.card.kind === "fault" ? "🔧 " : "📋 "}
              {message.card.title}
            </p>
            {message.card.lines.map((line) => (
              <p key={line.label} className="chat-card-line">
                <span className="chat-card-label">{line.label}</span>
                <span className="min-w-0 flex-1">{line.value}</span>
              </p>
            ))}
            <span
              className="chat-card-pill"
              style={{
                background: `${STATUS_COLORS[message.card.status] ?? "#64748b"}22`,
                color: STATUS_COLORS[message.card.status] ?? "#64748b",
              }}
            >
              <span className="chat-status-dot" style={{ background: STATUS_COLORS[message.card.status] ?? "#64748b" }} />
              {statusLabel(message.card.status)}
            </span>
          </div>
        ) : null}
        {message.text ? (
          <span>
            {message.text.split("\n").map((line, index) => (
              <Fragment key={index}>
                {index > 0 ? <br /> : null}
                {richText(line)}
              </Fragment>
            ))}
          </span>
        ) : null}
        <span className="chat-meta">
          {formatTime(message.time)}
          {outgoing ? <CheckCheck className="h-3.5 w-3.5" style={{ color: "var(--chat-tick)" }} aria-hidden="true" /> : null}
        </span>
        {message.options?.length ? <Options options={message.options} onRun={onRun} /> : null}
      </div>
    </div>
  );
}

export function ChatPage() {
  usePageMeta("Chats — ISP CENTRIC", "Work tickets through the chat assistant.");
  const { user } = useAuth();
  const role: ChatRole = user?.delegate?.kind === "isp-employee" ? (user.delegate.role ?? "isp-technician") : "owner";
  const displayName = (user?.delegate?.name || user?.firstName || "").split(" ")[0];
  const assistant = useMemo(() => new Assistant(role, displayName), [role, displayName]);

  const [threads, setThreads] = useState<Thread[]>([
    {
      id: "assistant",
      title: "ISP Assistant",
      subtitle: "Ticket bot · always online",
      kind: "assistant",
      activity: Date.now(),
      unread: 0,
    },
  ]);
  const [activeId, setActiveId] = useState("assistant");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seeded = useRef<Record<string, boolean>>({});

  const append = useCallback((threadId: string, items: ChatMessage[]) => {
    if (items.length === 0) return;
    setMessages((current) => ({ ...current, [threadId]: [...(current[threadId] ?? []), ...items] }));
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              activity: Date.now(),
              subtitle:
                thread.kind === "assistant"
                  ? items[items.length - 1].card?.title || items[items.length - 1].text.slice(0, 60) || thread.subtitle
                  : thread.subtitle,
            }
          : thread,
      ),
    );
  }, []);

  const openThread = useCallback(
    (threadId: string, reveal = true) => {
      setActiveId(threadId);
      if (reveal) setMobileOpen(true);
      setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, unread: 0 } : thread)));
      if (!seeded.current[threadId]) {
        seeded.current[threadId] = true;
        setTyping((current) => ({ ...current, [threadId]: true }));
        assistant
          .open(threadId)
          .then((items) => append(threadId, items))
          .catch(() => {})
          .finally(() => setTyping((current) => ({ ...current, [threadId]: false })));
      }
    },
    [append, assistant],
  );

  const refreshThreads = useCallback(() => {
    apiRequest<{ onboardings: ChatTicket[] }>("/api/client/onboardings")
      .then((body) => {
        setThreads((current) => {
          const assistantThread = current.find((thread) => thread.id === "assistant")!;
          const ticketThreads = body.onboardings
            .filter(
              (ticket) =>
                ticket.status !== "completed" || current.some((thread) => thread.id === `ticket:${ticket.id}`),
            )
            .sort((a, b) => Date.parse(b.createdAt.replace(" ", "T")) - Date.parse(a.createdAt.replace(" ", "T")))
            .map((ticket) => {
              const existing = current.find((thread) => thread.id === `ticket:${ticket.id}`);
              const next = threadFromTicket(ticket);
              return existing ? { ...next, unread: existing.unread, activity: Math.max(existing.activity, next.activity) } : next;
            });
          return [assistantThread, ...ticketThreads];
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshThreads();
    const timer = window.setInterval(refreshThreads, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshThreads]);

  useEffect(() => {
    openThread("assistant", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, typing, activeId]);

  async function run(threadId: string, command: string, display?: string) {
    append(threadId, [newUserMessage(display ?? command)]);
    setTyping((current) => ({ ...current, [threadId]: true }));
    try {
      const replies = await assistant.handle(threadId, command);
      const openNotice = replies.find((item) => item.kind === "notice" && item.text.startsWith("open:"));
      const visible = replies.filter((item) => item.kind !== "notice");
      // Update ticket thread cards/statuses when replies carry cards.
      for (const item of visible) {
        if (item.card) {
          setThreads((current) =>
            current.map((thread) =>
              thread.id === `ticket:${item.card!.ticketId}` ? { ...thread, status: item.card!.status } : thread,
            ),
          );
        }
      }
      if (threadId !== activeId && visible.length) {
        setThreads((current) =>
          current.map((thread) => (thread.id === threadId ? { ...thread, unread: thread.unread + visible.length } : thread)),
        );
      }
      append(threadId, visible);
      refreshThreads();
      if (openNotice) openThread(`ticket:${openNotice.text.slice(5)}`);
    } catch {
      append(threadId, [{ ...newUserMessage(""), id: `e${Date.now()}`, from: "bot", kind: "error", text: "Something went wrong — try again." }]);
    } finally {
      setTyping((current) => ({ ...current, [threadId]: false }));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    void run(activeId, text);
  }

  const term = query.trim().toLowerCase();
  const visibleThreads = term
    ? threads.filter((thread) => `${thread.title} ${thread.subtitle}`.toLowerCase().includes(term))
    : threads;
  const activeThread = threads.find((thread) => thread.id === activeId);
  const activeMessages = messages[activeId] ?? [];
  const isTyping = Boolean(typing[activeId]);

  let lastDay = "";

  return (
    <div className="page-shell px-2 py-5 sm:px-6">
      <div className="chat-shell">
        {/* ---------- chat list ---------- */}
        <aside className={cn("chat-list", mobileOpen && "max-lg:hidden")} aria-label="Chats">
          <div className="chat-list-head">
            <span className="chat-avatar bg-gradient-to-br from-indigo-500 to-violet-600" aria-hidden="true">
              <LifeBuoy className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">Chats</p>
              <p className="truncate text-xs opacity-70">Work tickets by chat</p>
            </div>
          </div>
          <label className="chat-search">
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
            />
          </label>
          <div className="chat-threads" role="list">
            {visibleThreads.map((thread, index) => (
              <Fragment key={thread.id}>
                {index > 0 && thread.kind === "ticket" && visibleThreads[index - 1].kind === "assistant" ? (
                  <div className="chat-section" role="presentation">
                    Open tickets
                  </div>
                ) : null}
                <ThreadRow
                  thread={thread}
                  active={thread.id === activeId}
                  onOpen={() => openThread(thread.id)}
                />
              </Fragment>
            ))}
            {visibleThreads.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No chats match.</p>
            ) : null}
          </div>
        </aside>

        {/* ---------- conversation ---------- */}
        <section className={cn("chat-view", !mobileOpen && "max-lg:hidden")} aria-label="Conversation">
          <header className="chat-view-head">
            <button
              type="button"
              className="mr-1 flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-black/10 lg:hidden dark:hover:bg-white/10"
              aria-label="Back to chats"
              onClick={() => setMobileOpen(false)}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            {activeThread ? <ThreadAvatar thread={activeThread} /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{activeThread?.title ?? "Chat"}</p>
              <p className="truncate text-xs opacity-70">
                {activeThread?.kind === "assistant"
                  ? isTyping
                    ? "typing…"
                    : "online · ticket assistant"
                  : activeThread?.subtitle}
              </p>
            </div>
            {activeThread?.kind === "ticket" && activeThread.status ? (
              <span
                className="chat-card-pill mt-0"
                style={{
                  background: `${STATUS_COLORS[activeThread.status] ?? "#64748b"}22`,
                  color: STATUS_COLORS[activeThread.status] ?? "#64748b",
                }}
              >
                <span
                  className="chat-status-dot"
                  style={{ background: STATUS_COLORS[activeThread.status] ?? "#64748b" }}
                  aria-hidden="true"
                />
                {statusLabel(activeThread.status)}
              </span>
            ) : null}
          </header>

          <div className="chat-messages" ref={scrollRef}>
            <div className="chat-notice">
              {activeThread?.kind === "assistant"
                ? "Chat with the ISP assistant — ticket actions apply instantly and are logged to your account."
                : "Actions in this chat apply to this ticket only."}
            </div>
            {activeMessages.map((message) => {
              const stamp = dayStamp(message.time);
              const showDay = stamp !== lastDay;
              if (showDay) lastDay = stamp;
              return (
                <Fragment key={message.id}>
                  {showDay ? <div className="chat-date">{stamp}</div> : null}
                  <MessageBubble message={message} onRun={(option) => void run(activeId, option.command, option.label)} />
                </Fragment>
              );
            })}
            {isTyping ? (
              <div className="chat-row">
                <div className="chat-bubble chat-bubble-in">
                  <span className="chat-typing" aria-label="Assistant is typing">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <form className="chat-composer" onSubmit={submit}>
            {activeId === "assistant" ? (
              <button
                type="button"
                className="chat-send !bg-transparent !text-emerald-600 shadow-none hover:!bg-emerald-600/10 dark:!text-emerald-400"
                aria-label="Show menu"
                title="Show menu"
                onClick={() => void run(activeId, "menu")}
              >
                <Bot className="h-5 w-5" />
              </button>
            ) : null}
            <input
              className="chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={activeId === "assistant" ? "Message the assistant — try “new ticket”" : "Message"}
              aria-label="Message"
              autoComplete="off"
            />
            <button className="chat-send" type="submit" disabled={!input.trim()} aria-label="Send">
              <Send className="h-5 w-5" />
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
