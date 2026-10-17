import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
} from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

export type Subscriber = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  username: string;
  routerId: string;
  routerName: string;
  packageId: string;
  packageName: string;
  serial: string;
  status: string;
  connection: "online" | "offline" | "unknown";
  billingStatus: string;
  expiry: string | null;
  buildingName: string;
  houseNumber: string;
  staticIp: string;
  rateLimit: string;
  downloadMbps: number | null;
  uploadMbps: number | null;
  live: { connection: string; ip: string; mac: string; uptime: string; router: string; lastSeen: string | null; rates?: { rxBps: number; txBps: number } | null };
  usage: { days: { day: string; bytesIn: number; bytesOut: number }[]; monthBytesIn: number; monthBytesOut: number };
  sessions: { login: string | null; logout: string | null; duration: number; ip: string; bytesIn: number; bytesOut: number; cause: string }[];
  devices: { mac: string; ip: string; sessions: number; seconds: number; bytesIn: number; bytesOut: number; online: boolean; onlineFor: string; lastSeen: string | null }[];
  billing: {
    invoices: { id: string; amount: string; purpose: string; status: string; reference: string; createdAt: string }[];
    payments: { id: string; amount: string; method: string; reference: string; createdAt: string }[];
    outstanding: string;
    nextDueDate: string | null;
    expiry: string | null;
    billingStatus: string;
    price: string;
    billingCycle: string;
    cycleDays: number;
    graceDays: number;
  };
  events: { action: string; reason: string; at: string }[];
  password?: string;
};

type PackageOption = { id: string; name: string; price: string };
type RouterOption = { id: string; name: string };
type DialogKind = "suspend" | "package" | "migrate" | "disconnect" | "terminate" | "password" | "edit";
type Tone = "active" | "due" | "paused" | "neutral";
type TrendPoint = { label: string; date: string; minutes: number; drops: number };

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${value} B`;
}


function rateLabel(bps: number) {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} Kbps`;
  return `${bps} bps`;
}

function elapsedLabel(sinceMs: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - sinceMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function stampMs(value: string | null | undefined) {
  if (!value) return null;
  const ms = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function labelFor(status: string): { label: string; tone: Tone } {
  const map: Record<string, { label: string; tone: Tone }> = {
    pending_activation: { label: "Not started yet", tone: "due" },
    active: { label: "Active", tone: "active" },
    suspended: { label: "Suspended", tone: "paused" },
    expired: { label: "Expired", tone: "due" },
    disconnected: { label: "Expired", tone: "due" },
    cancelled: { label: "Expired", tone: "due" },
  };
  return map[status] ?? { label: status, tone: "neutral" };
}

export function billingLabelFor(status: string): { label: string; tone: Tone } {
  const map: Record<string, { label: string; tone: Tone }> = {
    pending: { label: "Payment pending", tone: "due" },
    paid: { label: "Paid", tone: "active" },
    overdue: { label: "Overdue", tone: "due" },
    suspended: { label: "Billing suspended", tone: "paused" },
    cancelled: { label: "Billing cancelled", tone: "paused" },
  };
  return map[status] ?? { label: status, tone: "neutral" };
}

export function invoiceTone(status: string): Tone {
  if (status === "paid") return "active";
  if (status === "pending") return "due";
  if (status === "void") return "paused";
  return "neutral";
}

function ActionDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div>
            <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
          {children}
          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton type="button" onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton
              type="button"
              disabled={busy}
              className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={() => {
                setBusy(true);
                void Promise.resolve()
                  .then(() => onConfirm())
                  .finally(() => {
                    setBusy(false);
                    onClose();
                  });
              }}
            >
              {confirmLabel}
            </PrimaryButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({
  title,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      className="group border-t border-border first:border-t-0"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="flex items-center gap-3">
          {action}
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="px-5 pb-5 pt-1">{children}</div>
    </details>
  );
}

function TrendChart({
  data,
  formatY = (value) => String(value),
  emptyText,
  ariaLabel,
}: {
  data: { x: string; y: number }[];
  formatY?: (value: number) => string;
  emptyText: string;
  ariaLabel: string;
}) {
  if (data.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>;
  }
  const width = 640;
  const height = 128;
  const max = Math.max(1, ...data.map((point) => point.y));
  const slot = width / data.length;
  const bar = Math.min(28, slot * 0.42);
  const points = data.map((point, index) => {
    const barHeight = point.y > 0 ? Math.max(4, (point.y / max) * (height - 20)) : 0;
    const cx = index * slot + slot / 2;
    return { ...point, cx, cy: height - barHeight, barHeight };
  });
  const line = points.map((point) => `${point.cx},${point.cy}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height + 22}`} className="mt-3 h-36 w-full" role="img" aria-label={ariaLabel}>
      {points.length > 1 ? <polyline fill="none" stroke="rgb(var(--primary-rgb))" strokeWidth="2" points={line} /> : null}
      {points.map((point, index) => (
        <g key={`${point.x}-${index}`}>
          <title>{`${point.x}: ${formatY(point.y)}`}</title>
          <rect x={point.cx - bar / 2} y={point.cy} width={bar} height={point.barHeight} rx="3" fill="rgb(var(--primary-rgb) / 0.18)" />
          <circle cx={point.cx} cy={point.cy} r="3" fill="rgb(var(--primary-rgb))" />
          {data.length <= 14 || index % 5 === 0 ? (
            <text x={point.cx} y={height + 16} textAnchor="middle" fontSize="11" fill="rgb(var(--muted-foreground-rgb))">
              {point.x}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

function Stat({
  label,
  value,
  hint,
  valueClass,
  hintClass,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  valueClass?: string;
  hintClass?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-primary-foreground/60">{label}</p>
      <div className={`mt-1 flex min-w-0 items-center gap-1.5 text-sm font-semibold tracking-tight ${valueClass ?? ""}`}>{value}</div>
      {hint != null && hint !== "" ? (
        <div className={`mt-0.5 truncate text-[11px] ${hintClass ?? "text-primary-foreground/60"}`}>{hint}</div>
      ) : null}
    </div>
  );
}

export function PppoeCustomerPage() {
  const { subscriberId = "" } = useParams();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [packages, setPackages] = useState<PackageOption[]>([]);
  const [routers, setRouters] = useState<RouterOption[]>([]);
  const [packageId, setPackageId] = useState("");
  const [routerId, setRouterId] = useState("");
  const [profileOpen, setProfileOpen] = useState(search.get("edit") === "1");
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(search.get("edit") === "1" ? "edit" : null);
  const [reason, setReason] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [healthTrend, setHealthTrend] = useState<TrendPoint[] | null>(null);
  const [usageTrend, setUsageTrend] = useState<TrendPoint[] | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const surfSinceRef = useRef<number | null>(null);
  const navigate = useNavigate();

  usePageMeta("PPPoE customer — ISP CENTRIC", "Connection, usage, and billing for one PPPoE client.");

  function load() {
    apiRequest<{ subscriber: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}`)
      .then((body) => {
        setSubscriber(body.subscriber);
        setPackageId(body.subscriber.packageId);
        setRouterId(body.subscriber.routerId);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }

  useEffect(() => {
    load();
    surfSinceRef.current = null;
    const refresh = () => {
      apiRequest<{ connection: Subscriber["connection"]; live: Subscriber["live"] | null; status: string; billingStatus: string; rates?: { rxBps: number; txBps: number } | null; devices?: Subscriber["devices"] }>(
        `/api/pppoe/subscribers/${subscriberId}/status`,
      )
        .then((body) => {
          const now = Date.now();
          if (body.connection === "online") {
            if (surfSinceRef.current === null) surfSinceRef.current = now;
          } else {
            surfSinceRef.current = null;
          }
          setSubscriber((current) => current ? { ...current, connection: body.connection, live: { ...current.live, ...body.live, connection: body.connection, rates: body.rates ?? null }, status: body.status, billingStatus: body.billingStatus, devices: body.devices ?? current.devices } : current);
        })
        .catch(() => undefined);
    };
    refresh();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(refreshIfVisible, 8000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [subscriberId]);

  useEffect(() => {
    apiRequest<{ routers: RouterOption[] }>("/api/routers").then((body) => setRouters(body.routers)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!subscriber?.routerId) return;
    apiRequest<{ packages: PackageOption[] }>(`/api/routers/${subscriber.routerId}/packages`)
      .then((body) => setPackages(body.packages))
      .catch(() => undefined);
  }, [subscriber?.routerId]);

  useEffect(() => {
    if (!subscriber?.routerId) return;
    let stopped = false;
    apiRequest<{ trend: TrendPoint[] }>(`/api/mikrotiks/${subscriber.routerId}/health?range=hours`)
      .then((body) => {
        if (!stopped) setHealthTrend(body.trend);
      })
      .catch(() => {
        if (!stopped) setHealthTrend([]);
      });
    return () => {
      stopped = true;
    };
  }, [subscriber?.routerId]);

  useEffect(() => {
    let stopped = false;
    apiRequest<{ trend?: TrendPoint[] }>(`/api/pppoe/subscribers/${subscriberId}/usage?range=hours`)
      .then((body) => {
        if (!stopped) setUsageTrend(Array.isArray(body.trend) ? body.trend : []);
      })
      .catch(() => {
        if (!stopped) setUsageTrend([]);
      });
    return () => {
      stopped = true;
    };
  }, [subscriberId]);

  useEffect(() => {
    if (!menuOpen) return;
    const place = () => {
      const rect = menuButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 224;
      const estimatedHeight = Math.min(360, menuListRef.current?.offsetHeight ?? 360);
      const belowFits = rect.bottom + 6 + estimatedHeight <= window.innerHeight;
      setMenuPos({
        top: belowFits ? rect.bottom + 6 : Math.max(8, rect.top - 6 - estimatedHeight),
        left: Math.max(8, rect.right - width),
      });
    };
    place();
    // Re-measure after the menu mounts so the flip check uses its real height.
    const frame = requestAnimationFrame(place);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuButtonRef.current?.contains(target) || menuListRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menuOpen]);

  function closeDialog() {
    setDialog(null);
    setReason("");
  }

  async function post(action: string, body: Record<string, unknown>) {
    setMessage("");
    try {
      const response = await apiRequest<{ subscriber?: Subscriber; password?: string }>(`/api/pppoe/subscribers/${subscriberId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (response.password) setPassword(response.password);
      if (response.subscriber?.password) setPassword(response.subscriber.password);
      if (response.subscriber) setSubscriber(response.subscriber);
      else load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await post("edit", {
      firstName: data.get("firstName"),
      lastName: data.get("lastName"),
      phone: data.get("phone"),
      email: data.get("email"),
      buildingName: data.get("buildingName"),
      houseNumber: data.get("houseNumber"),
      serial: data.get("serial"),
    });
    closeDialog();
  }

  async function exportSessions() {
    const body = await apiRequest<{ csv?: string; filename?: string }>(`/api/pppoe/subscribers/${subscriberId}/sessions?export=csv&limit=500`);
    if (!body.csv) return;
    const blob = new Blob([body.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = body.filename || "sessions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!subscriber) {
    return <div className="page-shell py-8 text-sm text-muted-foreground">{message || "Loading PPPoE client..."}</div>;
  }

  const totalOnline = (usageTrend ?? []).reduce((sum, point) => sum + point.minutes, 0);
  const totalDown = (healthTrend ?? []).reduce((sum, point) => sum + point.minutes, 0);
  const devices = subscriber.devices ?? [];
  const devicesOnline = devices.filter((device) => device.online).length;
  const home = (path: string) => (user ? clientPage(user, path) : path);
  const status = labelFor(subscriber.status);
  const billing = billingLabelFor(subscriber.billingStatus);
  const suspended = subscriber.status === "suspended";
  const connectionDot = subscriber.connection === "online" ? (suspended ? "bg-warning" : "bg-success") : subscriber.connection === "offline" ? "bg-destructive" : "bg-warning";
  const pendingApproval = subscriber.status === "pending_activation";
  const ended = subscriber.status === "disconnected" || subscriber.status === "cancelled";
  const sessionOpen = subscriber.connection === "online";
  const initials = `${subscriber.firstName.trim().charAt(0)}${subscriber.lastName.trim().charAt(0)}`.toUpperCase() || "?";
  const outstandingDue = Number(subscriber.billing.outstanding) > 0;
  const rates = subscriber.live.rates;
  const liveSpeed = rates ? (
    <>
      <span className="text-success">↓</span> {rateLabel(rates.txBps)}{" "}
      <span className="text-primary">↑</span> {rateLabel(rates.rxBps)}
    </>
  ) : subscriber.connection === "online" ? "—" : "Offline";
  const lastSeenMs = stampMs(subscriber.live.lastSeen);
  const seenFor = lastSeenMs ? elapsedLabel(lastSeenMs) : null;
  let statusLabel: string;
  let statusHint: string;
  let statusTone = "";
  if (subscriber.connection === "online") {
    if (suspended) {
      statusLabel = "Paused";
      statusHint = `Restricted session for ${subscriber.live.uptime || elapsedLabel(surfSinceRef.current ?? Date.now())}`;
      statusTone = "text-warning";
    } else {
      statusLabel = "Online";
      statusHint = `Online for ${subscriber.live.uptime || elapsedLabel(surfSinceRef.current ?? Date.now())}`;
      statusTone = "text-success";
    }
  } else if (ended) {
    statusLabel = "Expired";
    statusHint = seenFor ? `Offline for ${seenFor}` : "Access ended";
    statusTone = "text-warning";
  } else if (suspended) {
    statusLabel = "Paused";
    statusHint = seenFor ? `Offline for ${seenFor}` : "Access paused";
    statusTone = "text-warning";
  } else {
    statusLabel = "Not surfing";
    statusHint = seenFor ? `Not surfing for ${seenFor}` : "Never connected";
    statusTone = "text-warning";
  }

  // The browser fires a "toggle" event on <details> both for user clicks and
  // when React sets/removes the open attribute. Guard the close branch so a
  // programmatic close of one section can't wipe out the section that was
  // just opened.
  const toggleSection = (id: string) => (next: boolean) =>
    setOpenSection((current) => (next ? id : current === id ? null : current));

  const menuItems: { label: string; danger?: boolean; onClick: () => void }[] = [
    { label: "Transactions", onClick: () => navigate(home(`/pppoe/${subscriberId}/transactions`)) },
    ...(ended
      ? []
      : [
          { label: "Change package", onClick: () => setDialog("package") },
          { label: "Move to another router", onClick: () => setDialog("migrate") },
        ]),
    ...(sessionOpen ? [{ label: "Disconnect current session", onClick: () => setDialog("disconnect") }] : []),
    { label: "Reset password", onClick: () => setDialog("password") },
    {
      label: "Show password",
      onClick: () => {
        setDialog("password");
        void post("reveal", {});
      },
    },
    { label: "Edit customer details", onClick: () => setDialog("edit") },
    ...(ended ? [] : [{ label: "divider", onClick: () => undefined }, { label: "End service", danger: true, onClick: () => setDialog("terminate") }]),
  ];

  return (
    <div className="page-shell py-8">
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/85 to-primary/60 text-primary-foreground shadow-card">
        <div className="px-5 pb-6 pt-5 sm:px-7 sm:pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              to={home("/clients")}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-foreground/75 transition hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              PPPoE clients
            </Link>
            <div className="flex flex-wrap gap-2">
              <Link
                to={`${home(`/pppoe/${subscriberId}/transactions`)}?pay=1`}
                className="inline-flex min-h-10 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-primary shadow-sm transition hover:bg-white/90"
              >
                Record payment
              </Link>
              {pendingApproval ? (
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center justify-center rounded-xl bg-white/15 px-4 text-sm font-semibold transition hover:bg-white/25"
                  onClick={() => void post("activate", {})}
                >
                  Approve
                </button>
              ) : ended || subscriber.status === "expired" ? null : (
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center justify-center rounded-xl bg-white/15 px-4 text-sm font-semibold transition hover:bg-white/25"
                  onClick={() => setDialog("suspend")}
                >
                  {suspended ? "Continue" : "Suspend"}
                </button>
              )}
              <div>
                <button
                  type="button"
                  ref={menuButtonRef}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-white/15 px-4 text-sm font-semibold transition hover:bg-white/25"
                >
                  More
                  <ChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
                </button>
                {menuOpen && menuPos
                  ? createPortal(
                      <div
                        role="menu"
                        ref={menuListRef}
                        style={{ top: menuPos.top, left: menuPos.left }}
                        className="fixed z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 text-foreground shadow-lg"
                      >
                        {menuItems.map((item, index) =>
                          item.label === "divider" ? (
                            <div key={`divider-${index}`} className="my-1 border-t border-border" />
                          ) : (
                            <button
                              key={item.label}
                              type="button"
                              role="menuitem"
                              className={`block w-full px-4 py-2 text-left text-sm hover:bg-surface-muted ${item.danger ? "text-destructive" : "text-foreground"}`}
                              onClick={() => {
                                setMenuOpen(false);
                                item.onClick();
                              }}
                            >
                              {item.label}
                            </button>
                          ),
                        )}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-10 gap-y-5">
            <button
              type="button"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((open) => !open)}
              className="flex min-w-0 items-center gap-4 rounded-xl text-left"
            >
              <div
                className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white text-lg font-semibold text-primary shadow-sm"
                aria-hidden="true"
              >
                {initials}
                <span className={`absolute bottom-0 right-0 h-4 w-4 rounded-full border-2 border-white ${connectionDot}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-2xl font-semibold tracking-tight">
                    {subscriber.firstName} {subscriber.lastName}
                  </h1>
                  <span className="shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold">{status.label}</span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-primary-foreground/70 transition-transform ${profileOpen ? "rotate-180" : ""}`}
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-0.5 truncate text-sm text-primary-foreground/75">
                  {subscriber.phone} · {subscriber.routerName} · {subscriber.packageName}
                </p>
              </div>
            </button>

            <div className="grid min-w-[18rem] flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Stat label="Status" value={statusLabel} valueClass={statusTone} hint={statusHint} hintClass={statusTone} />
              <Stat
                label="Live speed"
                value={liveSpeed}
                hint={`Plan ${subscriber.downloadMbps ?? "—"}↓ ${subscriber.uploadMbps ?? "—"}↑ Mbps`}
              />
              <Stat
                label="Outstanding"
                value={outstandingDue ? `KSh ${subscriber.billing.outstanding}` : "KSh 0"}
                valueClass={outstandingDue ? "text-destructive" : "text-success"}
                hint={`Due ${subscriber.billing.nextDueDate ?? "—"}`}
              />
              <Stat label="Access expires" value={subscriber.billing.expiry ?? "—"} hint={billing.label} />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/15 pt-4 sm:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Username"
              value={
                <>
                  <code className="truncate">{subscriber.username}</code>
                  <button
                    type="button"
                    aria-label="Copy username"
                    title="Copy username"
                    className="shrink-0 text-primary-foreground/60 transition hover:text-white"
                    onClick={() => void navigator.clipboard.writeText(subscriber.username)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            />
            <Stat
              label="Password"
              value={
                <>
                  <code className="truncate">{password || "••••••••••"}</code>
                  {password ? (
                    <>
                      <button
                        type="button"
                        aria-label="Copy password"
                        title="Copy password"
                        className="shrink-0 text-primary-foreground/60 transition hover:text-white"
                        onClick={() => void navigator.clipboard.writeText(password)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Hide password"
                        title="Hide password"
                        className="shrink-0 text-primary-foreground/60 transition hover:text-white"
                        onClick={() => setPassword("")}
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label="Show password"
                      title="Show password"
                      className="shrink-0 text-primary-foreground/60 transition hover:text-white"
                      onClick={() => {
                        setDialog("password");
                        void post("reveal", {});
                      }}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              }
              hint={
                <button
                  type="button"
                  className="font-medium text-primary-foreground/70 underline-offset-2 transition hover:text-white hover:underline"
                  onClick={() => setDialog("password")}
                >
                  Reset
                </button>
              }
            />
            <Stat label="IP" value={subscriber.live.ip || "Not connected"} />
            <Stat label="MAC" value={subscriber.live.mac || "—"} />
            <Stat label="Uptime" value={subscriber.live.uptime || "—"} />
            <Stat label="Last seen" value={subscriber.live.lastSeen ?? "Never"} />
          </div>

          {profileOpen ? (
            <div className="mt-5 rounded-2xl bg-white/10 p-4 backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-primary-foreground/70">Client details</h2>
                <button
                  type="button"
                  className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/25"
                  onClick={() => setDialog("edit")}
                >
                  Edit
                </button>
              </div>
              <dl className="mt-3 grid gap-x-8 sm:grid-cols-2">
                {[
                  { label: "Phone", value: subscriber.phone || "—" },
                  { label: "Email", value: subscriber.email || "—" },
                  { label: "Building", value: subscriber.buildingName || "—" },
                  { label: "House", value: subscriber.houseNumber || "—" },
                  { label: "Device serial", value: subscriber.serial || "—" },
                  { label: "IP assignment", value: subscriber.staticIp || "From pool" },
                  { label: "Router", value: subscriber.routerName || "—" },
                  { label: "Package", value: subscriber.packageName || "—" },
                ].map((item) => (
                  <div key={item.label} className="flex items-baseline justify-between gap-3 border-b border-white/10 py-2">
                    <dt className="text-xs text-primary-foreground/60">{item.label}</dt>
                    <dd className="min-w-0 break-words text-right text-sm font-medium">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 px-5 pt-5 sm:px-6">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
                <Activity className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold">Activity</h2>
              <p className="ml-auto text-xs text-muted-foreground">
                30 days {bytes(subscriber.usage.monthBytesIn + subscriber.usage.monthBytesOut)} ({bytes(subscriber.usage.monthBytesIn)}↓ {bytes(subscriber.usage.monthBytesOut)}↑)
              </p>
            </div>
            <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-border">
              <div className="p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-medium text-muted-foreground">Online activity</p>
                  <p className="text-xs tabular-nums text-muted-foreground">Last 3 hours · {totalOnline} min online</p>
                </div>
                {usageTrend === null ? (
                  <p className="mt-3 text-sm text-muted-foreground">Reading activity…</p>
                ) : (
                  <TrendChart
                    ariaLabel="Online activity"
                    emptyText="No activity in the last 3 hours."
                    formatY={(value) => `${value} min`}
                    data={usageTrend.map((point) => ({ x: point.label, y: point.minutes }))}
                  />
                )}
              </div>
              <div className="border-t border-border p-5 sm:border-t-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-medium text-muted-foreground">Router health · {subscriber.routerName}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">Last 3 hours · {totalDown} min down</p>
                </div>
                {healthTrend === null ? (
                  <p className="mt-3 text-sm text-muted-foreground">Reading router health…</p>
                ) : (
                  <TrendChart
                    ariaLabel="Router downtime"
                    emptyText="No downtime recorded."
                    formatY={(value) => `${value} min`}
                    data={healthTrend.map((point) => ({ x: point.label, y: point.minutes }))}
                  />
                )}
              </div>
            </div>

            <div className="border-t border-border p-5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium text-muted-foreground">Devices</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {devicesOnline > 0 ? `${devicesOnline} connected` : "None connected"} · {devices.length} seen
                </p>
              </div>
              {devices.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No devices have connected yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-left text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2">Device</th>
                        <th className="py-2">Status</th>
                        <th className="py-2">Connected for</th>
                        <th className="py-2">Last seen</th>
                        <th className="py-2">Data</th>
                        <th className="py-2">Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((device) => (
                        <tr key={device.mac} className="border-t border-border">
                          <td className="py-2"><code className="text-xs">{device.mac}</code></td>
                          <td className="py-2">
                            {device.online ? (
                              <span className="font-medium text-success">Online{device.ip ? ` · ${device.ip}` : ""}</span>
                            ) : (
                              <span className="text-muted-foreground">Offline</span>
                            )}
                          </td>
                          <td className="py-2 tabular-nums">{device.online ? device.onlineFor : duration(device.seconds)}</td>
                          <td className="py-2">{device.lastSeen ?? "Never"}</td>
                          <td className="py-2">{bytes(device.bytesIn + device.bytesOut)}</td>
                          <td className="py-2">{device.sessions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <Section
              title="Sessions &amp; activity"
              open={openSection === "history"}
              onToggle={toggleSection("history")}
              action={
                <SecondaryButton
                  type="button"
                  className="min-h-8 px-3"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void exportSessions();
                  }}
                >
                  Export CSV
                </SecondaryButton>
              }
            >
              <div className="grid gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold">Sessions</h3>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-left text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr>
                          <th className="py-2">Started</th>
                          <th className="py-2">Ended</th>
                          <th className="py-2">Duration</th>
                          <th className="py-2">Downloaded</th>
                          <th className="py-2">Uploaded</th>
                          <th className="py-2">Ended because</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subscriber.sessions.length === 0 ? <tr><td colSpan={6} className="py-3 text-muted-foreground">No sessions yet.</td></tr> : null}
                        {subscriber.sessions.map((session) => (
                          <tr key={`${session.login}-${session.ip}`} className="border-t border-border">
                            <td className="py-2">{session.login ?? "—"}</td>
                            <td className="py-2">{session.logout ?? <span className="text-success">Still connected</span>}</td>
                            <td className="py-2">{duration(session.duration)}</td>
                            <td className="py-2">{bytes(session.bytesIn)}</td>
                            <td className="py-2">{bytes(session.bytesOut)}</td>
                            <td className="py-2">{session.cause || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Activity log</h3>
                  {subscriber.events.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>
                  ) : (
                    <ul className="mt-3 grid gap-2 text-sm">
                      {subscriber.events.map((event) => (
                        <li key={`${event.at}-${event.action}`} className="flex flex-wrap items-baseline gap-2 border-b border-border py-2">
                          <span className="text-muted-foreground tabular-nums">{event.at}</span>
                          <span className="font-medium">{event.action}</span>
                          {event.reason ? <span className="text-muted-foreground">{event.reason}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Section>
          </div>
      </section>

      {message ? <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">{message}</p> : null}

      <ActionDialog
        open={dialog === "suspend"}
        onClose={closeDialog}
        title={suspended ? "Continue access" : "Suspend access"}
        description={suspended ? "Access is restored and the current billing status is kept." : "The customer will lose internet immediately."}
        confirmLabel={suspended ? "Continue" : "Suspend"}
        onConfirm={() => post(suspended ? "reactivate" : "suspend", { reason, override: true })}
      >
        <FormField id="suspend-reason" label={suspended ? "Reason" : "Reason (optional)"}>
          <input id="suspend-reason" className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </ActionDialog>

      <ActionDialog
        open={dialog === "package"}
        onClose={closeDialog}
        title="Change package"
        description="The new speed is sent to the router right away and the price difference is prorated."
        confirmLabel="Change package"
        onConfirm={() => post("upgrade", { packageId, prorate: true })}
      >
        <FormField id="package-select" label="New package">
          <select id="package-select" className="field" value={packageId} onChange={(event) => setPackageId(event.target.value)}>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.name} · KSh {item.price}</option>)}
          </select>
        </FormField>
      </ActionDialog>

      <ActionDialog
        open={dialog === "migrate"}
        onClose={closeDialog}
        title="Move to another router"
        description="The customer reconnects on the new router with the same username and password."
        confirmLabel="Move"
        onConfirm={() => post("migrate", { routerId, packageId })}
      >
        <FormField id="migrate-router" label="Router">
          <select id="migrate-router" className="field" value={routerId} onChange={(event) => setRouterId(event.target.value)}>
            {routers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </FormField>
        <FormField id="migrate-package" label="Package on that router">
          <select id="migrate-package" className="field" value={packageId} onChange={(event) => setPackageId(event.target.value)}>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.name} · KSh {item.price}</option>)}
          </select>
        </FormField>
      </ActionDialog>

      <ActionDialog
        open={dialog === "disconnect"}
        onClose={closeDialog}
        title="Disconnect current session"
        description="The customer is dropped now and can reconnect immediately. Nothing else changes."
        confirmLabel="Disconnect"
        onConfirm={() => post("disconnect", { mode: "session" })}
      />

      <ActionDialog
        open={dialog === "terminate"}
        onClose={closeDialog}
        title="End this service"
        description="This revokes the login permanently. Use Suspend if the customer may come back."
        confirmLabel="End service"
        destructive
        onConfirm={() => post("disconnect", { mode: "terminate", reason })}
      >
        <FormField id="terminate-reason" label="Why is the service ending?">
          <input id="terminate-reason" className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </ActionDialog>

      <Dialog.Root open={dialog === "password"} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">PPPoE password</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                Show the current password or reset it. After a reset the customer needs the new password to connect.
              </Dialog.Description>
            </div>
            <div className="rounded-xl border border-border bg-surface-muted/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Password for {subscriber.username}</p>
                <span className="flex items-center gap-1">
                  {password ? (
                    <>
                      <button
                        type="button"
                        aria-label="Copy password"
                        title="Copy password"
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
                        onClick={() => void navigator.clipboard.writeText(password)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Hide password"
                        title="Hide password"
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
                        onClick={() => setPassword("")}
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label="Show password"
                      title="Show password"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
                      onClick={() => void post("reveal", {})}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
              <code className="mt-1 block truncate text-sm font-semibold">{password || "••••••••••"}</code>
            </div>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton type="button" onClick={closeDialog}>Close</SecondaryButton>
              <PrimaryButton type="button" onClick={() => void post("password", {})}>Reset password</PrimaryButton>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={dialog === "edit"} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">Edit customer details</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                Update the customer's contact and installation details.
              </Dialog.Description>
            </div>
            <form className="grid gap-4" onSubmit={(event) => void saveEdit(event)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="edit-firstName" label="First name"><input id="edit-firstName" className="field" name="firstName" defaultValue={subscriber.firstName} /></FormField>
                <FormField id="edit-lastName" label="Last name"><input id="edit-lastName" className="field" name="lastName" defaultValue={subscriber.lastName} /></FormField>
                <FormField id="edit-phone" label="Phone"><input id="edit-phone" className="field" name="phone" defaultValue={subscriber.phone} /></FormField>
                <FormField id="edit-email" label="Email"><input id="edit-email" className="field" name="email" defaultValue={subscriber.email} /></FormField>
                <FormField id="edit-buildingName" label="Building"><input id="edit-buildingName" className="field" name="buildingName" defaultValue={subscriber.buildingName} /></FormField>
                <FormField id="edit-houseNumber" label="House number"><input id="edit-houseNumber" className="field" name="houseNumber" defaultValue={subscriber.houseNumber} /></FormField>
                <FormField id="edit-serial" label="Device serial"><input id="edit-serial" className="field" name="serial" defaultValue={subscriber.serial} /></FormField>
              </div>
              {message ? <p className="text-sm text-destructive">{message}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <SecondaryButton type="button" onClick={closeDialog}>Cancel</SecondaryButton>
                <PrimaryButton type="submit">Save</PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
