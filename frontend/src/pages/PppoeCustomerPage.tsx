import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpDown,
  BadgeCheck,
  CalendarClock,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Loader2,
  MapPin,
  Pause,
  Pencil,
  Phone,
  Play,
  Power,
  ReceiptText,
  Router,
  Smartphone,
  Trash2,
  Unplug,
  UserRound,
  Wallet,
} from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
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
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div>
            <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
          {children}
          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton type="button" onClick={onClose} disabled={busy}>Cancel</SecondaryButton>
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

const cardActionClass =
  "rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/20";

const iconButtonClass =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-muted hover:text-foreground";

function StatCard({
  icon,
  iconClass,
  label,
  value,
  hint,
  valueClass,
  hintClass,
}: {
  icon: ReactNode;
  iconClass?: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  valueClass?: string;
  hintClass?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconClass ?? "bg-primary/10 text-primary"}`}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <div className={`mt-2 flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight ${valueClass ?? ""}`}>{value}</div>
      {hint != null && hint !== "" ? (
        <p className={`mt-0.5 truncate text-xs ${hintClass ?? "text-muted-foreground"}`}>{hint}</p>
      ) : null}
    </div>
  );
}

function CardHeader({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        {icon}
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-medium">{children}</dd>
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
  const [openSection, setOpenSection] = useState<string | null>(null);
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
    setReason("");
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
      if (response.subscriber) setSubscriber(response.subscriber);
      else load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusyAction(false);
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

  async function removeCustomer() {
    setMessage("");
    try {
      await apiRequest(`/api/pppoe/subscribers/${subscriberId}/delete`, { method: "POST", body: JSON.stringify({}) });
      navigate(home("/clients"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That customer could not be deleted.");
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
  const gadgets = devices.filter((device) => device.kind !== "router");
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
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const expiryDay = (subscriber.expiry || "").slice(0, 10);
  // status='expired' only lands once reconcile() runs on a list view; the
  // expiry date itself is checked here so the detail page can't lag behind.
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

  const menuItems: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] = [
    { label: "Transactions", icon: <ReceiptText className="h-4 w-4" />, onClick: () => navigate(home(`/pppoe/${subscriberId}/transactions`)) },
    ...(ended
      ? []
      : [
          { label: "Change package", icon: <ArrowUpDown className="h-4 w-4" />, onClick: () => setDialog("package") },
          { label: "Move to another router", icon: <ArrowRightLeft className="h-4 w-4" />, onClick: () => setDialog("migrate") },
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
      <div className="page-header">
        <Link
          to={home("/clients")}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          PPPoE clients
        </Link>
        <div className="page-header-actions">
          <PrimaryButton to={`${home(`/pppoe/${subscriberId}/transactions`)}?pay=1`} className="min-h-10">
            <Wallet className="h-4 w-4" aria-hidden="true" />
            Record payment
          </PrimaryButton>
          {pendingApproval ? (
            <SecondaryButton className="min-h-10" onClick={() => void post("activate", {})}>
              <BadgeCheck className="h-4 w-4" aria-hidden="true" />
              Approve
            </SecondaryButton>
          ) : ended || subscriber.status === "expired" ? null : (
            <SecondaryButton className="min-h-10" onClick={() => setDialog("suspend")}>
              {suspended ? (
                <Play className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Pause className="h-4 w-4" aria-hidden="true" />
              )}
              {suspended ? "Continue" : "Suspend"}
            </SecondaryButton>
          )}
          <div>
            <SecondaryButton
              ref={menuButtonRef}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="min-h-10"
              onClick={() => setMenuOpen((open) => !open)}
            >
              More
              <ChevronDown className={`h-4 w-4 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
            </SecondaryButton>
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

      <section className="card mt-5 overflow-hidden">
        <div className="h-1 bg-gradient-brand" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-5 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <div
              className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-brand text-lg font-semibold text-primary-foreground shadow-sm"
              aria-hidden="true"
            >
              {initials}
              <span className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-surface ${connectionDot}`} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                  {subscriber.firstName} {subscriber.lastName}
                </h1>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <StatusBadge tone={billing.tone}>{billing.label}</StatusBadge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                  {subscriber.phone || "—"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Router className="h-3.5 w-3.5" aria-hidden="true" />
                  {subscriber.routerName}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                  {subscriber.packageName}
                </span>
                {subscriber.buildingName || subscriber.houseNumber ? (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    {[subscriber.buildingName, subscriber.houseNumber].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-muted/50 px-3 py-2">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <code className="min-w-0 truncate text-sm font-medium">{subscriber.username}</code>
              <button
                type="button"
                aria-label="Copy username"
                title="Copy username"
                className="shrink-0 text-muted-foreground transition hover:text-foreground"
                onClick={() => void navigator.clipboard.writeText(subscriber.username)}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Connection"
          value={statusLabel}
          valueClass={statusTone}
          hint={statusHint}
          hintClass={statusTone}
        />
        <StatCard
          icon={<Gauge className="h-4 w-4" />}
          label="Live speed"
          value={liveSpeed}
          hint={`Plan ${subscriber.downloadMbps ?? "—"}↓ ${subscriber.uploadMbps ?? "—"}↑ Mbps`}
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          iconClass={outstandingDue ? "bg-destructive-soft/70 text-destructive" : "bg-success-soft/70 text-success"}
          label="Outstanding"
          value={outstandingDue ? `KSh ${subscriber.billing.outstanding}` : "KSh 0"}
          valueClass={outstandingDue ? "text-destructive" : "text-success"}
          hint={`Due ${subscriber.billing.nextDueDate ?? "—"}`}
        />
        <StatCard
          icon={<CalendarClock className="h-4 w-4" />}
          label="Access expires"
          value={subscriber.billing.expiry ?? "—"}
          hint={billing.label}
        />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-4">
          <section className="card overflow-hidden">
            <CardHeader icon={<Activity className="h-4 w-4" />} title="Activity">
              <p className="text-xs tabular-nums text-muted-foreground">
                30 days {bytes(subscriber.usage.monthBytesIn + subscriber.usage.monthBytesOut)} ({bytes(subscriber.usage.monthBytesIn)}↓ {bytes(subscriber.usage.monthBytesOut)}↑)
              </p>
            </CardHeader>
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
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon={<Smartphone className="h-4 w-4" />} title="Devices">
              <p className="text-xs tabular-nums text-muted-foreground">
                {devicesOnline > 0 ? `${devicesOnline} online` : "None online"} · {gadgets.length} gadget{gadgets.length === 1 ? "" : "s"} · {devices.length} seen
              </p>
            </CardHeader>
            <div className="px-5 pb-5 pt-4">
              {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No devices have connected yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table min-w-[44rem]">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="py-2">Device</th>
                        <th className="py-2">Status</th>
                        <th className="py-2">Connected for</th>
                        <th className="py-2">Downloaded</th>
                        <th className="py-2">Uploaded</th>
                        <th className="py-2">Last seen</th>
                        <th className="py-2">Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((device) => (
                        <tr key={device.mac} className="border-t border-border">
                          <td className="py-2">
                            <span className="flex items-center gap-2 font-medium">
                              {device.name || (device.kind === "router" ? "Customer router" : "Unknown device")}
                              {device.kind === "router" ? (
                                <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">Router</span>
                              ) : null}
                            </span>
                            <code className="text-xs text-muted-foreground">
                              {device.mac}
                              {viaLabel(device.via) ? ` · ${viaLabel(device.via)}` : ""}
                            </code>
                          </td>
                          <td className="py-2">
                            {device.online ? (
                              <span className="font-medium text-success">Online{device.ip ? ` · ${device.ip}` : ""}</span>
                            ) : (
                              <span className="text-muted-foreground">Offline</span>
                            )}
                          </td>
                          <td className="py-2 tabular-nums">{device.online ? device.onlineFor || "—" : duration(device.seconds)}</td>
                          <td className="py-2 tabular-nums">{bytes(device.bytesIn)}</td>
                          <td className="py-2 tabular-nums">{bytes(device.bytesOut)}</td>
                          <td className="py-2">{device.lastSeen ?? "Never"}</td>
                          <td className="py-2">{device.sessions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!subscriber.accessInterface ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Only devices that sign in on this account are listed. Save a VLAN / access interface when registering the
                  customer to also see the gadgets behind their router.
                </p>
              ) : null}
            </div>
          </section>

          <section className="card overflow-hidden">
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
                    <table className="data-table min-w-[32rem]">
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
          </section>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <section className="card overflow-hidden">
            <CardHeader icon={<KeyRound className="h-4 w-4" />} title="Access &amp; connection">
              <button type="button" className={cardActionClass} onClick={() => setDialog("password")}>
                Manage password
              </button>
            </CardHeader>
            <dl className="px-5 py-3">
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
            </dl>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon={<ReceiptText className="h-4 w-4" />} title="Subscription">
              {ended ? null : (
                <button type="button" className={cardActionClass} onClick={() => setDialog("package")}>
                  Change package
                </button>
              )}
            </CardHeader>
            <dl className="px-5 py-3">
              <InfoRow label="Package">{subscriber.packageName || "—"}</InfoRow>
              <InfoRow label="Price">
                {subscriber.billing.price ? `KSh ${subscriber.billing.price} / ${subscriber.billing.billingCycle || "cycle"}` : "—"}
              </InfoRow>
              <InfoRow label="Billing">
                <StatusBadge tone={billing.tone}>{billing.label}</StatusBadge>
              </InfoRow>
              <InfoRow label="Next due">{subscriber.billing.nextDueDate ?? "—"}</InfoRow>
              <InfoRow label="Access expires">{subscriber.billing.expiry ?? "—"}</InfoRow>
              <InfoRow label="Grace period">
                {subscriber.billing.graceDays ? `${subscriber.billing.graceDays} day${subscriber.billing.graceDays === 1 ? "" : "s"}` : "—"}
              </InfoRow>
            </dl>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon={<UserRound className="h-4 w-4" />} title="Client details">
              <button type="button" className={cardActionClass} onClick={() => setDialog("edit")}>
                Edit
              </button>
            </CardHeader>
            <dl className="px-5 py-3">
              <InfoRow label="Phone">{subscriber.phone || "—"}</InfoRow>
              <InfoRow label="Email">{subscriber.email || "—"}</InfoRow>
              <InfoRow label="Building">{subscriber.buildingName || "—"}</InfoRow>
              <InfoRow label="House">{subscriber.houseNumber || "—"}</InfoRow>
              <InfoRow label="Device serial">{subscriber.serial || "—"}</InfoRow>
              <InfoRow label="IP assignment">{subscriber.staticIp || "From pool"}</InfoRow>
              <InfoRow label="Router">{subscriber.routerName || "—"}</InfoRow>
            </dl>
          </section>
        </div>
      </div>

      {message ? <p className="mt-4 notice" role="alert">{message}</p> : null}

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

      <ActionDialog
        open={dialog === "delete"}
        onClose={closeDialog}
        title="Delete this customer"
        description="Access is revoked, live sessions are dropped, and the customer leaves the clients list. Payment and usage history is kept."
        confirmLabel="Delete customer"
        destructive
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
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton type="button" onClick={closeDialog}>Close</SecondaryButton>
              <PrimaryButton type="button" disabled={busyAction} onClick={() => void post("password", {})}>
                {busyAction ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Working…
                  </span>
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
