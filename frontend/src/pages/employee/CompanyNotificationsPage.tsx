import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Bell,
  ChevronDown,
  Router,
  Server,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { SecondaryButton } from "@/components/ui/Buttons";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { employeePage } from "@/lib/employees";
import { playChime } from "@/lib/pushAlerts";
import { cn } from "@/lib/cn";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type NotificationItem = {
  id: string;
  kind: string;
  subject: string;
  detail: string;
  at: string | null;
  open: boolean;
  read: boolean;
};

const kindLabels: Record<string, string> = {
  serverUnreachable: "Servers",
  mikrotikUnreachable: "MikroTik down",
  mikrotikAdded: "MikroTik added",
  ispRegistered: "New ISP",
  communicationsFailed: "Communications",
  paymentsFailed: "Payments",
  gateway: "Billing",
};

type CategoryKey = "all" | "clients" | "mikrotik" | "billing" | "system";
type StatusKey = "new" | "read";

const categoryMeta: Record<
  Exclude<CategoryKey, "all">,
  { label: string; icon: LucideIcon; chip: string }
> = {
  clients: { label: "ISP clients", icon: Users, chip: "bg-violet-500/10 text-violet-500" },
  mikrotik: { label: "MikroTik", icon: Router, chip: "bg-sky-500/10 text-sky-500" },
  billing: { label: "Billing", icon: Wallet, chip: "bg-emerald-500/10 text-emerald-500" },
  system: { label: "System", icon: Server, chip: "bg-amber-500/10 text-amber-500" },
};

const categoryOrder = ["clients", "mikrotik", "billing", "system"] as const;

function categoryOf(kind: string): Exclude<CategoryKey, "all"> {
  if (kind === "ispRegistered") {
    return "clients";
  }
  if (kind === "mikrotikAdded" || kind === "mikrotikUnreachable") {
    return "mikrotik";
  }
  if (kind === "paymentsFailed" || kind === "gateway") {
    return "billing";
  }
  return "system";
}

export function CompanyNotificationsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY NOTIFICATIONS — ISP CENTRIC", "Company notifications.");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<StatusKey>("new");
  const [category, setCategory] = useState<CategoryKey>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [viewedIds, setViewedIds] = useState<Set<string>>(new Set());
  const audioRef = useRef<AudioContext | null>(null);
  const pushOnRef = useRef(false);
  const seenRef = useRef<Set<string> | null>(null);

  const loadFeed = useCallback(() => {
    apiRequest<{ notifications: NotificationItem[] }>("/api/employee/company/notifications/feed")
      .then((body) => {
        const fresh = new Set(body.notifications.map((item) => item.id));
        if (seenRef.current !== null && pushOnRef.current) {
          if (body.notifications.some((item) => !seenRef.current!.has(item.id))) {
            playChime(audioRef.current);
          }
        }
        seenRef.current = fresh;
        setItems(body.notifications);
        setLoaded(true);
        setError("");
      })
      .catch((cause: unknown) => {
        setLoaded(true);
        setError(cause instanceof Error ? cause.message : "Notifications could not be loaded.");
      });
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    loadFeed();
    const timer = setInterval(loadFeed, 10000);
    return () => clearInterval(timer);
  }, [employee, loadFeed]);

  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      navigator.serviceWorker
        .getRegistration("/push-sw.js")
        .then((registration) => registration?.pushManager.getSubscription())
        .then((subscription) => {
          pushOnRef.current = Boolean(subscription);
        })
        .catch(() => {});
    }
    // Browsers keep AudioContext suspended until a user gesture — unlock it on
    // the first interaction so the chime can ring afterwards.
    const unlock = () => {
      audioRef.current ??= new AudioContext();
      void audioRef.current.resume();
    };
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  const unread = items.filter((item) => !item.read).length;
  const viewItems = useMemo(
    () =>
      items.filter((item) =>
        status === "new" ? !item.read || viewedIds.has(item.id) : item.read,
      ),
    [items, status, viewedIds],
  );
  const categoryCounts = useMemo(() => {
    const tally: Partial<Record<CategoryKey, number>> = {};
    for (const item of viewItems) {
      const key = categoryOf(item.kind);
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [viewItems]);
  const visible =
    category === "all" ? viewItems : viewItems.filter((item) => categoryOf(item.kind) === category);

  const groups = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA");
    const out: { label: string; rows: NotificationItem[] }[] = [];
    for (const item of visible) {
      const day = (item.at ?? "").slice(0, 10);
      const label = day === today ? "Today" : day === yesterday ? "Yesterday" : day || "Earlier";
      const last = out[out.length - 1];
      if (last && last.label === label) {
        last.rows.push(item);
      } else {
        out.push({ label, rows: [item] });
      }
    }
    return out;
  }, [visible]);

  function markRead(payload: { itemIds?: string[]; all?: boolean }) {
    apiRequest<{ notifications: NotificationItem[] }>(
      "/api/employee/company/notifications/read",
      { method: "POST", body: JSON.stringify(payload) },
    )
      .then((body) => {
        setItems(body.notifications);
        setViewedIds((prev) => {
          const next = new Set(prev);
          if (payload.all) {
            for (const item of body.notifications) next.add(item.id);
          } else {
            for (const id of payload.itemIds ?? []) next.add(id);
          }
          return next;
        });
      })
      .catch(() => undefined);
  }

  function toggleItem(item: NotificationItem) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
    if (!item.read) markRead({ itemIds: [item.id] });
  }

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.status !== "approved") {
    return <Navigate to="/employee/account" replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Notifications" description="Recent alerts and events for the company." />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SecondaryButton to={employeePage(employee, "/company-settings/notifications/settings")}>
          Notification settings
        </SecondaryButton>
        {unread > 0 ? (
          <SecondaryButton type="button" onClick={() => markRead({ all: true })}>
            Mark all read
          </SecondaryButton>
        ) : null}
      </div>
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {!loaded ? (
        <LiveLoad label="Loading notifications" />
      ) : items.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Bell />}
            title="No notifications yet"
            description="Alerts about ISP clients, MikroTiks, and company APIs will show up here."
          />
        </div>
      ) : (
        <>
          <div
            className="mt-6 inline-flex rounded-xl border border-border bg-surface-muted/70 p-1"
            role="tablist"
            aria-label="Notification state"
          >
            {(
              [
                ["new", "New", unread],
                ["read", "Read", items.length - unread],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={status === key}
                onClick={() => setStatus(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold transition duration-fast ease-out",
                  status === key
                    ? "bg-surface text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[0.6rem] font-bold leading-none",
                    status === key
                      ? "bg-primary/10 text-primary"
                      : "bg-foreground/10 text-muted-foreground",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Notification categories">
            <button
              type="button"
              onClick={() => setCategory("all")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out",
                category === "all"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-surface text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              All
              <span
                className={cn(
                  "inline-flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold leading-none",
                  category === "all" ? "bg-primary text-white" : "bg-foreground/10 text-muted-foreground",
                )}
              >
                {viewItems.length > 99 ? "99+" : viewItems.length}
              </span>
            </button>
            {categoryOrder.map((key) => {
              const meta = categoryMeta[key];
              const count = categoryCounts[key] ?? 0;
              if (count === 0 && category !== key) return null;
              const Icon = meta.icon;
              const active = category === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-surface text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {meta.label}
                  <span
                    className={cn(
                      "inline-flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold leading-none",
                      active ? "bg-primary text-white" : "bg-foreground/10 text-muted-foreground",
                    )}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                </button>
              );
            })}
          </div>
          {visible.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                icon={<Bell />}
                title={status === "new" ? "You're all caught up" : "Nothing here yet"}
                description={
                  status === "new"
                    ? "New company alerts will show up here."
                    : category === "all"
                      ? "Notifications you open will be listed here."
                      : "No notifications in this category."
                }
              />
            </div>
          ) : (
            <div className="mt-5 grid gap-5">
              {groups.map((group) => (
                <section key={group.label}>
                  <h3 className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {group.label}
                  </h3>
                  <ul className="grid gap-2">
                    {group.rows.map((item) => {
                      const expanded = expandedIds.has(item.id);
                      const meta = categoryMeta[categoryOf(item.kind)];
                      const Icon = meta.icon;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => toggleItem(item)}
                            aria-expanded={expanded}
                            className={cn(
                              "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left shadow-xs transition-colors",
                              item.read
                                ? "border-border bg-surface hover:bg-surface-muted/40"
                                : "border-primary/50 bg-primary/5 hover:border-primary",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                                meta.chip,
                              )}
                            >
                              <Icon className="h-4 w-4" aria-hidden="true" />
                            </span>
                            <span className="grid min-w-0 flex-1 gap-1">
                              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                                {item.subject}
                                <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                                  {kindLabels[item.kind] ?? item.kind}
                                </span>
                                {!item.read ? (
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5",
                                      "text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-primary",
                                    )}
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                                    New
                                  </span>
                                ) : null}
                                {item.open ? (
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5",
                                      "text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-destructive",
                                    )}
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
                                    Ongoing
                                  </span>
                                ) : null}
                              </p>
                              {expanded && item.detail ? (
                                <p className="text-sm text-muted-foreground">{item.detail}</p>
                              ) : null}
                            </span>
                            <span className="flex shrink-0 items-center gap-2 pt-1.5">
                              {item.at ? (
                                <time className="text-xs text-muted-foreground" dateTime={item.at}>
                                  {item.at.slice(11, 16)}
                                </time>
                              ) : null}
                              <ChevronDown
                                className={cn(
                                  "h-3.5 w-3.5 text-muted-foreground transition-transform duration-fast",
                                  expanded && "rotate-180",
                                )}
                                aria-hidden="true"
                              />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
