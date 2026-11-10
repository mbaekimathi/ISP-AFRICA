import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpDown,
  BadgeCheck,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  History,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Pencil,
  Play,
  Power,
  ReceiptText,
  Trash2,
  Unplug,
  Wallet,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

export type RemoteAccessSession = {
  url: string;
  target: string;
  expiresAt: number;
  tunnelIp: string;
  listenPort: number | null;
  mode?: string;
};

export type RemoteAccessStatus = {
  state: string;
  label: string;
  ready: boolean;
  tunnelStatus: string;
  tunnelIp: string;
  cpeIp: string;
  connection: string;
  routerName: string;
  session: RemoteAccessSession | null;
};

export type Subscriber = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  username: string;
  routerId: string;
  routerName: string;
  routerTunnelStatus?: string;
  packageId: string;
  packageName: string;
  serial: string;
  status: string;
  startDate: string | null;
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
  devices: { mac: string; ip: string; name?: string; kind?: "router" | "gadget"; via?: string; sessions: number; seconds: number; bytesIn: number; bytesOut: number; online: boolean; onlineFor: string; lastSeen: string | null }[];
  remoteAccess?: RemoteAccessStatus;
  accessInterface?: string;
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
type DialogKind = "suspend" | "package" | "migrate" | "disconnect" | "terminate" | "password" | "edit" | "delete";
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

function viaLabel(via: string | undefined) {
  const map: Record<string, string> = { pppoe: "PPPoE", dhcp: "DHCP", hotspot: "Hotspot", voucher: "Voucher", lan: "LAN" };
  return map[via ?? ""] ?? "";
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
  confirmDisabled,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  confirmDisabled?: boolean;
  error?: string;
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div>
            <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
          {children}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton type="button" onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
            <PrimaryButton
              type="button"
              disabled={busy || confirmDisabled}
              className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={() => {
                setBusy(true);
                void Promise.resolve()
                  .then(() => onConfirm())
                  .then(() => onClose())
                  .catch(() => undefined)
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Working…
                </span>
              ) : (
                confirmLabel
              )}
            </PrimaryButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

const cardActionClass =
  "rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20";

const iconButtonClass =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-muted hover:text-foreground";

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3 shadow-xs sm:rounded-2xl sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">
          {label}
        </p>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className={cn("mt-2 truncate text-base font-semibold tracking-tight sm:text-lg", tone)}>{value}</div>
      {hint != null && hint !== "" ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground sm:text-xs">{hint}</p> : null}
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
  const [newPassword, setNewPassword] = useState("");
  const [packages, setPackages] = useState<PackageOption[]>([]);
  const [routers, setRouters] = useState<RouterOption[]>([]);
  const [packageId, setPackageId] = useState("");
  const [routerId, setRouterId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(search.get("edit") === "1" ? "edit" : null);
  const [busyAction, setBusyAction] = useState(false);
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
      const width = 240;
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
    setNewPassword("");
    setReason("");
    if (subscriber) {
      setRouterId(subscriber.routerId);
      setPackageId(subscriber.packageId);
    }
  }

  async function post(action: string, body: Record<string, unknown>) {
    setMessage("");
    setBusyAction(true);
    try {
      const response = await apiRequest<{ subscriber?: Subscriber; password?: string }>(`/api/pppoe/subscribers/${subscriberId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (response.password) setPassword(response.password);
      if (response.subscriber?.password) setPassword(response.subscriber.password);
      if (response.subscriber) {
        setSubscriber(response.subscriber);
        setPackageId(response.subscriber.packageId);
        setRouterId(response.subscriber.routerId);
      } else load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
      throw error;
    } finally {
      setBusyAction(false);
    }
  }

  function openMigrate() {
    const targets = routers.filter((item) => item.id !== subscriber?.routerId);
    setRouterId(targets[0]?.id || "");
    setPackageId(subscriber?.packageId || "");
    setMessage("");
    setDialog("migrate");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await post("edit", {
        firstName: data.get("firstName"),
        lastName: data.get("lastName"),
        phone: data.get("phone"),
        email: data.get("email"),
        buildingName: data.get("buildingName"),
        houseNumber: data.get("houseNumber"),
        serial: data.get("serial"),
        username: data.get("username"),
        password: data.get("password"),
      });
      closeDialog();
    } catch {
      // Message already set by post().
    }
  }

  function copyPhoneInto(form: HTMLFormElement | null, field: "username" | "password") {
    if (!form) return;
    const phone = (form.elements.namedItem("phone") as HTMLInputElement | null)?.value ?? "";
    const target = form.elements.namedItem(field) as HTMLInputElement | null;
    if (target) target.value = phone.replace(/\D/g, "");
  }

  async function removeCustomer() {
    setMessage("");
    try {
      await apiRequest(`/api/pppoe/subscribers/${subscriberId}/delete`, { method: "POST", body: JSON.stringify({}) });
      navigate(home("/clients"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That customer could not be deleted.");
      throw error;
    }
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
    if (message) {
      return <div className="page-shell py-8 text-sm text-muted-foreground">{message}</div>;
    }
    return <LiveLoad label="Loading PPPoE client" />;
  }

  const totalOnline = (usageTrend ?? []).reduce((sum, point) => sum + point.minutes, 0);
  const totalDown = (healthTrend ?? []).reduce((sum, point) => sum + point.minutes, 0);
  const devices = [...(subscriber.devices ?? [])].sort((a, b) => Number(b.online) - Number(a.online));
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
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const expiryDay = (subscriber.expiry || "").slice(0, 10);
  // API status polls return effective status (expiry included) without waiting
  // for the background enforce sweep; keep the local date check as a fallback.
  const expiredService = ended || subscriber.status === "expired" || (expiryDay !== "" && expiryDay < todayKey);
  let statusLabel: string;
  let statusHint: string;
  let statusTone = "";
  if (subscriber.connection === "online") {
    if (expiredService) {
      statusLabel = "Expired";
      statusHint = `Session online for ${subscriber.live.uptime || elapsedLabel(surfSinceRef.current ?? Date.now())}`;
      statusTone = "text-warning";
    } else if (suspended) {
      statusLabel = "Paused";
      statusHint = `Restricted session for ${subscriber.live.uptime || elapsedLabel(surfSinceRef.current ?? Date.now())}`;
      statusTone = "text-warning";
    } else {
      statusLabel = "Online";
      statusHint = `Online for ${subscriber.live.uptime || elapsedLabel(surfSinceRef.current ?? Date.now())}`;
      statusTone = "text-success";
    }
  } else if (expiredService) {
    statusLabel = "Expired";
    statusHint = seenFor ? `Offline for ${seenFor}` : "Access ended";
    statusTone = "text-warning";
  } else if (suspended) {
    statusLabel = "Paused";
    statusHint = seenFor ? `Offline for ${seenFor}` : "Access paused";
    statusTone = "text-warning";
  } else if (subscriber.connection === "offline") {
    statusLabel = "Disconnected";
    statusHint = seenFor ? `Disconnected for ${seenFor}` : "Went offline";
    statusTone = "text-warning";
  } else {
    statusLabel = "Not surfing";
    statusHint = seenFor ? `Not surfing for ${seenFor}` : "Never connected";
    statusTone = "text-warning";
  }

  const history: { at: string | null; title: string; detail: string; icon: LucideIcon; tone: string }[] = [
    ...subscriber.events.map((event) => ({
      at: event.at,
      title: event.action,
      detail: event.reason,
      icon: History,
      tone: "bg-primary/10 text-primary",
    })),
    ...subscriber.sessions.flatMap((session) => [
      {
        at: session.login,
        title: "Connected",
        detail: [session.ip, session.logout ? "" : "Still connected"].filter(Boolean).join(" · "),
        icon: LogIn,
        tone: "bg-success-soft/70 text-success",
      },
      ...(session.logout
        ? [
            {
              at: session.logout,
              title: "Disconnected",
              detail: [
                duration(session.duration),
                `${bytes(session.bytesIn)}↓ ${bytes(session.bytesOut)}↑`,
                session.cause,
              ]
                .filter(Boolean)
                .join(" · "),
              icon: LogOut,
              tone: "bg-warning/10 text-warning",
            },
          ]
        : []),
    ]),
  ].sort((a, b) => (stampMs(b.at) ?? 0) - (stampMs(a.at) ?? 0));
  const openFromDetails = (kind: DialogKind) => {
    setDetailsOpen(false);
    setDialog(kind);
  };

  const menuItems: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] = [
    { label: "Details", icon: <Eye className="h-4 w-4" />, onClick: () => setDetailsOpen(true) },
    { label: "Transactions", icon: <ReceiptText className="h-4 w-4" />, onClick: () => navigate(home(`/pppoe/${subscriberId}/transactions`)) },
    ...(pendingApproval
      ? [{ label: "Approve", icon: <BadgeCheck className="h-4 w-4" />, onClick: () => void post("activate", {}) }]
      : ended || subscriber.status === "expired"
        ? []
        : [
            {
              label: suspended ? "Continue" : "Suspend",
              icon: suspended ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />,
              onClick: () => setDialog("suspend"),
            },
          ]),
    ...(ended
      ? []
      : [
          { label: "Change package", icon: <ArrowUpDown className="h-4 w-4" />, onClick: () => setDialog("package") },
          { label: "Transfer to another MikroTik", icon: <ArrowRightLeft className="h-4 w-4" />, onClick: openMigrate },
        ]),
    ...(sessionOpen ? [{ label: "Disconnect current session", icon: <Unplug className="h-4 w-4" />, onClick: () => setDialog("disconnect") }] : []),
    { label: "Reset password", icon: <KeyRound className="h-4 w-4" />, onClick: () => setDialog("password") },
    {
      label: "Show password",
      icon: <Eye className="h-4 w-4" />,
      onClick: () => {
        setDialog("password");
        void post("reveal", {});
      },
    },
    { label: "Edit customer details", icon: <Pencil className="h-4 w-4" />, onClick: () => setDialog("edit") },
    ...(ended ? [] : [{ label: "divider", onClick: () => undefined }, { label: "End service", icon: <Power className="h-4 w-4" />, danger: true, onClick: () => setDialog("terminate") }]),
    { label: "divider", onClick: () => undefined },
    { label: "Delete customer", icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => setDialog("delete") },
  ];

  return (
    <div className="page-shell py-6 sm:py-8">
      <Link
        to={home("/clients")}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        PPPoE clients
      </Link>

      <section className="mt-4 overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-primary/65 text-primary-foreground shadow-card sm:rounded-3xl">
        <div className="flex flex-col gap-4 px-4 py-5 sm:px-7 sm:py-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3.5 sm:gap-4">
            <div
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15 text-base font-semibold text-primary-foreground ring-1 ring-primary-foreground/20 sm:h-14 sm:w-14 sm:text-lg"
              aria-hidden="true"
            >
              {initials}
              <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-primary ${connectionDot}`} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                  {subscriber.firstName} {subscriber.lastName}
                </h1>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                {subscriber.remoteAccess ? (
                  <StatusBadge
                    tone={
                      subscriber.remoteAccess.state === "ready" || subscriber.remoteAccess.state === "session-open"
                        ? "online"
                        : subscriber.remoteAccess.state === "tunnel-down" || subscriber.remoteAccess.state === "no-tunnel"
                          ? "offline"
                          : "due"
                    }
                  >
                    {subscriber.remoteAccess.label}
                  </StatusBadge>
                ) : null}
              </div>
              <p className="mt-1.5 truncate text-sm text-primary-foreground/80">
                {subscriber.phone || "—"}
                <span className="mx-1.5 opacity-50">·</span>
                <code className="font-medium text-primary-foreground">{subscriber.username}</code>
                <span className="mx-1.5 opacity-50">·</span>
                {subscriber.packageName || "No package"}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <Link
              to={`${home(`/pppoe/${subscriberId}/transactions`)}?pay=1`}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-white/90 sm:flex-none"
            >
              <Wallet className="h-4 w-4" aria-hidden="true" />
              Recharge
            </Link>
            <div>
              <button
                type="button"
                ref={menuButtonRef}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-white/90 sm:flex-none"
                onClick={() => setMenuOpen((open) => !open)}
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
                      className="fixed z-50 w-60 overflow-hidden rounded-xl border border-border bg-surface py-1 text-foreground shadow-lg"
                    >
                      {menuItems.map((item, index) =>
                        item.label === "divider" ? (
                          <div key={`divider-${index}`} className="my-1 border-t border-border" />
                        ) : (
                          <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm hover:bg-surface-muted ${item.danger ? "text-destructive" : "text-foreground"}`}
                            onClick={() => {
                              setMenuOpen(false);
                              item.onClick();
                            }}
                          >
                            <span className={item.danger ? undefined : "text-muted-foreground"} aria-hidden="true">
                              {item.icon}
                            </span>
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
      </section>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Connection"
          value={statusLabel}
          hint={statusHint}
          tone={statusTone}
          icon={subscriber.connection === "online" ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Live speed"
          value={liveSpeed}
          hint={subscriber.routerName || "—"}
          icon={<Gauge className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Outstanding"
          value={outstandingDue ? `KSh ${subscriber.billing.outstanding}` : "KSh 0"}
          hint={billing.label}
          tone={outstandingDue ? "text-destructive" : "text-success"}
          icon={<Wallet className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Expires"
          value={subscriber.billing.expiry ?? "—"}
          hint={subscriber.billing.nextDueDate ? `Due ${subscriber.billing.nextDueDate}` : "No due date"}
          icon={<ReceiptText className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
        <div className="grid min-w-0 gap-4 content-start">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold">Devices</h2>
                <p className="text-xs text-muted-foreground">
                  {devices.length} device{devices.length === 1 ? "" : "s"} on this account
                </p>
              </div>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {devices.filter((device) => device.online).length} online
              </span>
            </header>
            <div className="px-4 py-2 sm:px-5">
              {devices.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No devices have connected yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {devices.map((device) => (
                    <li key={device.mac} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <span className={cn("h-2 w-2 shrink-0 rounded-full", device.online ? "bg-success" : "bg-border")} aria-hidden="true" />
                          {device.name || (device.kind === "router" ? "Customer router" : "Unknown device")}
                          {device.kind === "router" ? (
                            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">Router</span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          <code>{device.mac}</code>
                          {viaLabel(device.via) ? ` · ${viaLabel(device.via)}` : ""}
                          {device.online && device.ip ? ` · ${device.ip}` : ""}
                        </p>
                      </div>
                      <div className="text-left text-xs tabular-nums text-muted-foreground sm:text-right">
                        <p className={device.online ? "font-medium text-success" : ""}>
                          {device.online ? `Online ${device.onlineFor || ""}`.trim() : `Last seen ${device.lastSeen ?? "never"}`}
                        </p>
                        <p>
                          {bytes(device.bytesIn)}↓ {bytes(device.bytesOut)}↑ · {device.sessions} session{device.sessions === 1 ? "" : "s"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {!subscriber.accessInterface ? (
                <p className="border-t border-border py-3 text-xs text-muted-foreground">
                  Online sessions list gadgets on this client&apos;s access port (not the whole bridge). Save a VLAN / access
                  interface on the customer to keep listing them when they are offline.
                </p>
              ) : null}
            </div>
          </section>

          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold">Usage</h2>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Last 30 days · {bytes(subscriber.usage.monthBytesIn + subscriber.usage.monthBytesOut)} ({bytes(subscriber.usage.monthBytesIn)}↓{" "}
                  {bytes(subscriber.usage.monthBytesOut)}↑)
                </p>
              </div>
            </header>
            <div className="grid gap-5 p-4 sm:p-5">
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-sm font-medium">Online activity</p>
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
              <div className="border-t border-border pt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-sm font-medium">Router health · {subscriber.routerName}</p>
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
          </section>
        </div>

        <section className="card flex min-h-[22rem] min-w-0 flex-col overflow-hidden xl:max-h-[44rem]">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold">History</h2>
              <p className="text-xs text-muted-foreground">{history.length} events</p>
            </div>
            <button type="button" className={cardActionClass} onClick={() => void exportSessions()}>
              Export CSV
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
            {history.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <ol>
                {history.map((entry, index) => {
                  const Icon = entry.icon;
                  return (
                    <li key={`${entry.at}-${entry.title}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
                      {index < history.length - 1 ? (
                        <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border" aria-hidden="true" />
                      ) : null}
                      <span
                        className={cn("relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", entry.tone)}
                        aria-hidden="true"
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <p className="text-sm font-medium">{entry.title}</p>
                          <time className="text-xs tabular-nums text-muted-foreground">{entry.at ?? "—"}</time>
                        </div>
                        {entry.detail ? <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>

      {message ? <p className="mt-4 notice" role="alert">{message}</p> : null}

      <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content dialog-sheet">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <Dialog.Title className="truncate text-base font-semibold text-foreground">
                  {subscriber.firstName} {subscriber.lastName}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">Login, subscription and client details</Dialog.Description>
              </div>
              <Dialog.Close className={cn(iconButtonClass, "h-8 w-8")} aria-label="Close">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <div className="divide-y divide-border overflow-y-auto">
            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Login</h2>
                <button type="button" className={cardActionClass} onClick={() => openFromDetails("password")}>
                  Manage password
                </button>
              </div>
              <dl className="mt-2">
                <InfoRow label="Username">
                  <span className="inline-flex items-center gap-1.5">
                    <code className="truncate">{subscriber.username}</code>
                    <button
                      type="button"
                      aria-label="Copy username"
                      title="Copy username"
                      className={iconButtonClass}
                      onClick={() => void navigator.clipboard.writeText(subscriber.username)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </InfoRow>
                <InfoRow label="Password">
                  <span className="inline-flex items-center gap-1.5">
                    <code className="truncate">{password || "••••••••••"}</code>
                    {password ? (
                      <>
                        <button
                          type="button"
                          aria-label="Copy password"
                          title="Copy password"
                          className={iconButtonClass}
                          onClick={() => void navigator.clipboard.writeText(password)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Hide password"
                          title="Hide password"
                          className={iconButtonClass}
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
                        className={iconButtonClass}
                        onClick={() => void post("reveal", {})}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </InfoRow>
                <InfoRow label="IP">{subscriber.live.ip || "Not connected"}</InfoRow>
                <InfoRow label="MAC">{subscriber.live.mac || "—"}</InfoRow>
                <InfoRow label="Uptime">{subscriber.live.uptime || "—"}</InfoRow>
                <InfoRow label="Last seen">{subscriber.live.lastSeen ?? "Never"}</InfoRow>
                <InfoRow label="Tunnel">
                  {subscriber.remoteAccess?.tunnelStatus === "up"
                    ? `Up · ${subscriber.remoteAccess.tunnelIp || "—"}`
                    : subscriber.remoteAccess?.tunnelStatus === "down"
                      ? "Down"
                      : subscriber.routerTunnelStatus === "up"
                        ? "Up"
                        : subscriber.routerTunnelStatus === "down"
                          ? "Down"
                          : "Unknown"}
                </InfoRow>
                <InfoRow label="Remote access">{subscriber.remoteAccess?.label || "—"}</InfoRow>
              </dl>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Subscription</h2>
                {ended ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={cardActionClass} onClick={() => { setDetailsOpen(false); openMigrate(); }}>
                      Transfer MikroTik
                    </button>
                    <button type="button" className={cardActionClass} onClick={() => openFromDetails("package")}>
                      Change package
                    </button>
                  </div>
                )}
              </div>
              <dl className="mt-2">
                <InfoRow label="MikroTik">{subscriber.routerName || "—"}</InfoRow>
                <InfoRow label="Package">{subscriber.packageName || "—"}</InfoRow>
                <InfoRow label="Price">
                  {subscriber.billing.price ? `KSh ${subscriber.billing.price} / ${subscriber.billing.billingCycle || "cycle"}` : "—"}
                </InfoRow>
                <InfoRow label="Next due">{subscriber.billing.nextDueDate ?? "—"}</InfoRow>
                <InfoRow label="Grace period">
                  {subscriber.billing.graceDays ? `${subscriber.billing.graceDays} day${subscriber.billing.graceDays === 1 ? "" : "s"}` : "—"}
                </InfoRow>
              </dl>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Client</h2>
                <button type="button" className={cardActionClass} onClick={() => openFromDetails("edit")}>
                  Edit
                </button>
              </div>
              <dl className="mt-2">
                <InfoRow label="Email">{subscriber.email || "—"}</InfoRow>
                <InfoRow label="Device serial">{subscriber.serial || "—"}</InfoRow>
                <InfoRow label="IP assignment">{subscriber.staticIp || "From pool"}</InfoRow>
              </dl>
            </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>


      <ActionDialog
        open={dialog === "suspend"}
        onClose={closeDialog}
        title={suspended ? "Continue access" : "Suspend access"}
        description={suspended ? "Access is restored and the current billing status is kept." : "The customer will lose internet immediately."}
        confirmLabel={suspended ? "Continue" : "Suspend"}
        error={dialog === "suspend" ? message : ""}
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
        error={dialog === "package" ? message : ""}
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
        title="Transfer to another MikroTik"
        description="Keeps the same package, username, and password. The customer reconnects on the new MikroTik."
        confirmLabel="Transfer"
        confirmDisabled={!routerId || routerId === subscriber.routerId}
        error={dialog === "migrate" ? message : ""}
        onConfirm={() => post("migrate", { routerId })}
      >
        <div className="grid gap-3">
          <p className="rounded-lg border border-border bg-surface-muted/60 px-3 py-2 text-sm text-muted-foreground">
            Now on <span className="font-medium text-foreground">{subscriber.routerName || "—"}</span>
            {subscriber.packageName ? (
              <>
                {" "}
                · package <span className="font-medium text-foreground">{subscriber.packageName}</span>
              </>
            ) : null}
          </p>
          <FormField id="migrate-router" label="Destination MikroTik">
            <select
              id="migrate-router"
              className="field"
              value={routerId}
              onChange={(event) => setRouterId(event.target.value)}
            >
              {routers.filter((item) => item.id !== subscriber.routerId).length === 0 ? (
                <option value="">No other MikroTik available</option>
              ) : (
                routers
                  .filter((item) => item.id !== subscriber.routerId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))
              )}
            </select>
          </FormField>
        </div>
      </ActionDialog>

      <ActionDialog
        open={dialog === "disconnect"}
        onClose={closeDialog}
        title="Disconnect current session"
        description="The customer is dropped now and can reconnect immediately. Nothing else changes."
        confirmLabel="Disconnect"
        error={dialog === "disconnect" ? message : ""}
        onConfirm={() => post("disconnect", { mode: "session" })}
      />

      <ActionDialog
        open={dialog === "terminate"}
        onClose={closeDialog}
        title="End this service"
        description="This revokes the login permanently. Use Suspend if the customer may come back."
        confirmLabel="End service"
        destructive
        error={dialog === "terminate" ? message : ""}
        onConfirm={() => post("disconnect", { mode: "terminate", reason })}
      >
        <FormField id="terminate-reason" label="Why is the service ending?">
          <input id="terminate-reason" className="field" value={reason} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </ActionDialog>

      <ActionDialog
        open={dialog === "delete"}
        onClose={closeDialog}
        title="Delete this customer"
        description="Access is revoked, live sessions are dropped, and the customer leaves the clients list. Payment and usage history is kept."
        confirmLabel="Delete customer"
        destructive
        error={dialog === "delete" ? message : ""}
        onConfirm={removeCustomer}
      />

      <Dialog.Root open={dialog === "password"} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
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
            <FormField id="own-password" label="Set your own password" hint="4 to 64 characters. Leave empty and press Reset for a random one.">
              <div className="flex flex-wrap gap-2">
                <input
                  id="own-password"
                  className="field"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <SecondaryButton type="button" onClick={() => setNewPassword(subscriber.phone.replace(/\D/g, ""))}>
                  Use phone number
                </SecondaryButton>
              </div>
            </FormField>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton type="button" onClick={closeDialog}>Close</SecondaryButton>
              <PrimaryButton
                type="button"
                disabled={busyAction}
                onClick={() => void post("password", newPassword ? { password: newPassword } : {}).then(() => setNewPassword(""))}
              >
                {busyAction ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Working…
                  </span>
                ) : newPassword ? (
                  "Save password"
                ) : (
                  "Reset password"
                )}
              </PrimaryButton>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={dialog === "edit"} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-lg">
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
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="edit-username" label="PPPoE username" hint="The router must dial with this name.">
                  <input id="edit-username" className="field" name="username" defaultValue={subscriber.username} />
                  <SecondaryButton type="button" className="mt-2" onClick={(event) => copyPhoneInto(event.currentTarget.form, "username")}>
                    Use phone number
                  </SecondaryButton>
                </FormField>
                <FormField id="edit-password" label="New PPPoE password" hint="Leave empty to keep the current one. 4 to 64 characters.">
                  <input id="edit-password" className="field" name="password" autoComplete="new-password" placeholder="Keep current password" />
                  <SecondaryButton type="button" className="mt-2" onClick={(event) => copyPhoneInto(event.currentTarget.form, "password")}>
                    Use phone number
                  </SecondaryButton>
                </FormField>
              </div>
              {message ? <p className="text-sm text-destructive">{message}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <SecondaryButton type="button" onClick={closeDialog} disabled={busyAction}>Cancel</SecondaryButton>
                <PrimaryButton type="submit" disabled={busyAction}>
                  {busyAction ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Working…
                    </span>
                  ) : (
                    "Save"
                  )}
                </PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
