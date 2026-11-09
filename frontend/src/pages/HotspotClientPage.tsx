import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  History,
  LogIn,
  LogOut,
  Power,
  RefreshCw,
  Ticket,
  TimerOff,
  Trash2,
  UserRound,
  Wallet,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type Voucher = {
  id: string;
  code: string;
  username: string;
  status: string;
  seconds: number;
  redeemedIp: string;
  redeemedMac: string;
  issuedAt: string | null;
  usedAt: string | null;
};

type GuestSession = {
  username: string;
  label: string;
  start: string | null;
  stop: string | null;
  seconds: number;
  bytesIn: number;
  bytesOut: number;
  ip: string;
  mac: string;
  cause: string;
  live: boolean;
};

type TimelineEvent = { at: string | null; event: string; detail: string };

type ConnectionEvent = { at: string | null; kind: string; event: string; device: string; detail: string };

const connectionIcons: Record<string, { icon: typeof Wifi; tone: string }> = {
  paid: { icon: CircleDollarSign, tone: "bg-emerald-500/10 text-emerald-600" },
  connected: { icon: LogIn, tone: "bg-emerald-500/10 text-emerald-600" },
  disconnected: { icon: LogOut, tone: "bg-amber-500/10 text-amber-600" },
  router_offline: { icon: WifiOff, tone: "bg-red-500/10 text-red-600" },
  router_online: { icon: Wifi, tone: "bg-sky-500/10 text-sky-600" },
  reconnected: { icon: RefreshCw, tone: "bg-emerald-500/10 text-emerald-600" },
  expired: { icon: TimerOff, tone: "bg-muted text-muted-foreground" },
};

type LiveSession = {
  username: string;
  label: string;
  ip: string;
  mac: string;
  uptime: string;
  idleTime: string;
  sessionTimeLeft: string;
  bytesIn: number;
  bytesOut: number;
};

type HostEntry = {
  label: string;
  ip: string;
  mac: string;
  uptime: string;
  idleTime: string;
  bytesIn: number;
  bytesOut: number;
};

type GuestClient = {
  id: string;
  phone: string;
  mac: string;
  ip: string;
  amount: string;
  status: string;
  mpesaCode: string;
  paidAt: string | null;
  createdAt: string | null;
  packageName: string;
  routerName: string;
  devices: number;
  periods: number;
  username: string;
  authorized: boolean;
  endedAt: string | null;
  deleted: boolean;
  connection: "online" | "connected" | "offline";
};

type GuestTransaction = {
  id: string;
  phone: string;
  amount: string;
  status: string;
  mpesaCode: string;
  checkoutId: string;
  mac: string;
  ip: string;
  packageName: string;
  routerName: string;
  devices: number;
  periods: number;
  vouchers: number;
  vouchersUsed: number;
  authorized: boolean;
  paidAt: string | null;
  createdAt: string | null;
  endedAt: string | null;
  deleted: boolean;
  current: boolean;
};

type GuestDevice = {
  id: string;
  code: string;
  status: string;
  seconds: number;
  secondsLeft: number | null;
  mac: string;
  ip: string;
  payer: boolean;
  claimed?: boolean;
  online: boolean;
  connected: boolean;
  sessionTimeLeft: string;
  issuedAt: string | null;
  usedAt: string | null;
};

type GuestDetail = {
  client: GuestClient;
  devices: GuestDevice[];
  vouchers: Voucher[];
  transactions: GuestTransaction[];
  usage: {
    bytesIn: number;
    bytesOut: number;
    sessions: number;
    firstSeen: string | null;
    lastSeen: string | null;
    days?: { day: string; bytesIn: number; bytesOut: number }[];
  };
  sessions: GuestSession[];
  timeline: TimelineEvent[];
  connectionLog?: ConnectionEvent[];
  live: LiveSession[];
  hosts?: HostEntry[];
  routerReachable: boolean;
};

const statusTone: Record<string, "active" | "due" | "critical" | "paused" | "neutral"> = {
  paid: "active",
  pending: "due",
  failed: "critical",
  issued: "neutral",
  used: "active",
  void: "paused",
};

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function duration(seconds: number) {
  if (seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function deviceState(device: GuestDevice): { label: string; tone: "active" | "due" | "critical" | "paused" | "neutral" } {
  if (device.online) return { label: "Online", tone: "active" };
  if (device.claimed) return { label: "New owner", tone: "neutral" };
  if (device.status === "issued") return { label: "Not redeemed", tone: "neutral" };
  if (device.status === "void") return { label: "Void", tone: "paused" };
  if (device.status === "pending") return { label: "Pending", tone: "due" };
  if (device.status === "failed") return { label: "Failed", tone: "critical" };
  if (device.connected) return { label: "On network", tone: "due" };
  if (device.secondsLeft != null && device.secondsLeft > 0) return { label: "Time left", tone: "due" };
  return { label: "Used up", tone: "neutral" };
}

function money(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

function ActionDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div>
            <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
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

function stampMs(at: string | null) {
  if (!at) return null;
  const ms = Date.parse(at.replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

function gapLabel(from: string | null, to: string | null) {
  const a = stampMs(from);
  const b = stampMs(to);
  if (a === null || b === null || b < a) return "";
  const minutes = Math.round((b - a) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function GenerationTree({
  paid,
  events,
  vouchers,
  live,
}: {
  paid: { amount: string; packageName: string; paidAt: string | null; receipt: string; phone: string };
  events: ConnectionEvent[];
  vouchers: Voucher[];
  live: boolean;
}) {
  const multiDevice = vouchers.length > 1;
  const steps = [...events]
    .filter((entry) => entry.kind !== "paid")
    .sort((a, b) => (stampMs(b.at) ?? 0) - (stampMs(a.at) ?? 0));
  const rows: ConnectionEvent[] = [
    ...steps,
    {
      at: paid.paidAt,
      kind: "paid",
      event: `Paid ${money(paid.amount)}`,
      device: "",
      detail: [paid.packageName, paid.receipt].filter(Boolean).join(" · "),
    },
  ];
  const running = live && steps[0]?.kind !== "expired";

  return (
    <ol className="relative">
      {running ? (
        <li className="relative flex gap-3 pb-4">
          <span className="relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="absolute h-3 w-3 animate-ping rounded-full bg-emerald-500/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="pt-0.5 text-sm font-medium text-emerald-600">Package still running</span>
          <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border" aria-hidden="true" />
        </li>
      ) : null}
      {rows.map((entry, index) => {
        const look = connectionIcons[entry.kind] ?? { icon: History, tone: "bg-muted text-muted-foreground" };
        const Icon = look.icon;
        const older = rows[index + 1];
        const gap = older ? gapLabel(older.at, entry.at) : "";
        const last = index === rows.length - 1;
        return (
          <li key={`${entry.kind}-${entry.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
            {!last ? <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border" aria-hidden="true" /> : null}
            <span
              className={cn("relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", look.tone)}
              aria-hidden="true"
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium">
                  {entry.event}
                  {multiDevice && entry.device ? (
                    <span className="ml-1.5 font-normal text-muted-foreground">· {entry.device}</span>
                  ) : null}
                </p>
                <time className="text-xs tabular-nums text-muted-foreground">{entry.at ?? "—"}</time>
              </div>
              {entry.detail ? <p className="text-xs leading-5 text-muted-foreground">{entry.detail}</p> : null}
              {gap ? <p className="text-[11px] text-subtle">{gap} after the previous step</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function HotspotClientPage() {
  const { purchaseId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  usePageMeta("Hotspot client — ISP CENTRIC", "Connection, usage, and vouchers for one hotspot guest.");
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<"recharge" | "end" | "delete" | null>(null);
  const [voucherCount, setVoucherCount] = useState(1);
  const [rechargePeriods, setRechargePeriods] = useState(1);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);

  const home = (path: string) => (user ? clientPage(user, path) : path);

  function load() {
    apiRequest<GuestDetail>(`/api/hotspot/clients/${purchaseId}`)
      .then((body) => {
        setDetail(body);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }

  useEffect(() => {
    load();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(refreshIfVisible, 8000);
    return () => window.clearInterval(timer);
  }, [purchaseId]);

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

  async function post(action: string, body: Record<string, unknown> = {}) {
    setBusy(action);
    setMessage("");
    try {
      await apiRequest(`/api/hotspot/clients/${purchaseId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      load();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
      return false;
    } finally {
      setBusy("");
    }
  }

  function copyVouchers() {
    const codes = detail?.vouchers.map((voucher) => voucher.code).join("  ") ?? "";
    if (!codes) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(codes).then(done, done);
    } else {
      done();
    }
  }

  function copyCode(code: string) {
    if (!code) return;
    const done = () => {
      setCopiedCode(code);
      window.setTimeout(() => setCopiedCode(""), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, done);
    } else {
      done();
    }
  }

  if (!detail) {
    if (message) {
      return <div className="page-shell py-8 text-sm text-muted-foreground">{message}</div>;
    }
    return <LiveLoad label="Loading hotspot client" />;
  }

  const client = detail.client;
  const online = client.connection === "online";
  const connected = client.connection === "connected";
  const ended = client.deleted || client.endedAt != null;
  const connectionDot = online ? "bg-success" : connected ? "bg-warning" : client.status === "failed" || ended ? "bg-destructive" : "bg-warning";
  const firstLive = detail.live[0] ?? null;
  const timeLeft = firstLive?.sessionTimeLeft || "—";
  const statusLabel = client.deleted ? "Deleted" : ended ? "Ended" : online ? "Online" : connected ? "Connected" : "Offline";
  const statusHint = online
    ? `Surfing for ${firstLive?.uptime || "a moment"}`
    : connected
      ? "On the router — waiting for payment or a voucher"
      : ended
        ? `Access ended ${client.endedAt ?? ""}`.trim()
        : detail.usage.lastSeen
          ? `Last seen ${detail.usage.lastSeen}`
          : "Never connected";
  const statusColor = client.deleted || ended ? "text-destructive" : online ? "text-success" : "text-warning";
  const journeyCount = (detail.connectionLog ?? []).length;

  const menuItems: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] = [
    { label: copied ? "Copied" : "Copy voucher codes", icon: <Copy className="h-4 w-4" />, onClick: copyVouchers },
    ...(ended
      ? []
      : [
          { label: "End access", icon: <Power className="h-4 w-4" />, onClick: () => setDialog("end") },
          { label: "divider", onClick: () => undefined },
          { label: "Delete guest", icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => setDialog("delete") },
        ]),
  ];

  return (
    <div className="page-shell py-6 sm:py-8">
      <Link
        to={home("/clients/hotspot")}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Hotspot clients
      </Link>

      <section className="mt-4 overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-primary/65 text-primary-foreground shadow-card sm:rounded-3xl">
        <div className="flex flex-col gap-4 px-4 py-5 sm:px-7 sm:py-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3.5 sm:gap-4">
            <div
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15 text-primary-foreground ring-1 ring-primary-foreground/20 sm:h-14 sm:w-14"
              aria-hidden="true"
            >
              <Wifi className="h-6 w-6" />
              <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-primary ${connectionDot}`} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{client.phone || "Hotspot guest"}</h1>
                <StatusBadge tone={client.deleted || ended ? "paused" : online ? "active" : connected ? "due" : "neutral"}>
                  {statusLabel}
                </StatusBadge>
              </div>
              <p className="mt-1.5 truncate text-sm text-primary-foreground/80">
                {client.packageName || "No package"}
                <span className="mx-1.5 opacity-50">·</span>
                {client.routerName || "This router"}
                {detail.vouchers[0]?.code ? (
                  <>
                    <span className="mx-1.5 opacity-50">·</span>
                    <code className="font-medium text-primary-foreground">{detail.vouchers[0].code}</code>
                    {detail.vouchers.length > 1 ? ` +${detail.vouchers.length - 1}` : ""}
                  </>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {!ended ? (
              <button
                type="button"
                onClick={() => setDialog("recharge")}
                className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-white/90 sm:flex-none"
              >
                <Zap className="h-4 w-4" aria-hidden="true" />
                Recharge
              </button>
            ) : null}
            <div>
              <SecondaryButton
                ref={menuButtonRef}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="min-h-10 border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/15"
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
      </section>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Connection"
          value={statusLabel}
          hint={statusHint}
          tone={statusColor}
          icon={online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Time left"
          value={online ? timeLeft : "—"}
          hint={online ? "On the live session" : "No open session"}
          icon={<TimerOff className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Data used"
          value={bytes(detail.usage.bytesIn + detail.usage.bytesOut)}
          hint={`${detail.usage.sessions} session${detail.usage.sessions === 1 ? "" : "s"}`}
          icon={<History className="h-3.5 w-3.5" />}
        />
        <StatTile
          label="Paid"
          value={money(client.amount)}
          hint={client.mpesaCode || client.status}
          icon={<Wallet className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.85fr)]">
        <div className="grid min-w-0 gap-4 content-start">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold">Devices</h2>
                <p className="text-xs text-muted-foreground">
                  {detail.devices.length} device{detail.devices.length === 1 ? "" : "s"} on this purchase
                </p>
              </div>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                {detail.devices.filter((device) => device.online).length} online
              </span>
            </header>
            <div className="px-4 py-2 sm:px-5">
              {!detail.routerReachable ? (
                <p className="notice mb-3 text-sm">
                  {client.routerName || "The router"} did not answer, so live status may be out of date.
                </p>
              ) : null}
              {detail.devices.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Devices appear here once the payment is confirmed.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.devices.map((device, index) => {
                    const state = deviceState(device);
                    const left = device.sessionTimeLeft
                      ? device.sessionTimeLeft
                      : device.secondsLeft != null && device.secondsLeft > 0
                        ? duration(device.secondsLeft)
                        : device.status === "issued"
                          ? `Up to ${duration(device.seconds)}`
                          : "—";
                    return (
                      <li key={device.id || device.mac || index} className="flex items-center gap-3 py-3">
                        <span
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                            device.online ? "bg-emerald-500/10 text-emerald-600" : "bg-primary/10 text-primary",
                          )}
                          aria-hidden="true"
                        >
                          {device.payer ? <UserRound className="h-4 w-4" /> : <Ticket className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{device.payer ? "Paying device" : `Device ${index + 1}`}</span>
                            <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {device.mac || "No device yet"}
                            {device.ip ? ` · ${device.ip}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {device.code ? (
                            <button
                              type="button"
                              aria-label={`Copy voucher ${device.code}`}
                              className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-primary"
                              onClick={() => copyCode(device.code)}
                            >
                              {device.code}
                              {copiedCode === device.code ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                            </button>
                          ) : null}
                          <p className="text-xs tabular-nums text-muted-foreground">{left}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {(detail.hosts?.length ?? 0) ? (
                <div className="border-t border-border py-3">
                  <p className="text-xs font-semibold text-warning">On the Wi-Fi, not surfing</p>
                  <ul className="mt-2 grid gap-1.5">
                    {(detail.hosts ?? []).map((host) => (
                      <li key={host.mac} className="flex flex-wrap justify-between gap-x-3 text-xs">
                        <span className="font-medium">{host.label || host.mac}</span>
                        <span className="text-muted-foreground">
                          {host.ip || "—"} · on for {host.uptime || "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>

          <section className="card overflow-hidden">
            <header className="border-b border-border px-4 py-3 sm:px-5">
              <h2 className="text-sm font-semibold">Usage</h2>
              <p className="text-xs tabular-nums text-muted-foreground">
                {bytes(detail.usage.bytesIn)} down · {bytes(detail.usage.bytesOut)} up · last 14 days
              </p>
            </header>
            <div className="grid gap-4 p-4 sm:p-5">
              <TrendChart
                data={(detail.usage.days ?? []).map((day) => ({ x: day.day.slice(5), y: day.bytesIn + day.bytesOut }))}
                formatY={bytes}
                emptyText="No usage recorded yet."
                ariaLabel="Hotspot guest usage for the last 14 days"
              />
              {detail.sessions.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {detail.sessions.map((session, index) => (
                    <li key={index} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{session.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {session.start ?? "—"} → {session.live ? "now" : session.stop ?? "—"}
                        </span>
                      </span>
                      <span className="text-right text-xs tabular-nums text-muted-foreground">
                        {session.live ? <StatusBadge tone="active">Live</StatusBadge> : duration(session.seconds)}
                        <span className="block">{bytes(session.bytesIn + session.bytesOut)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          {detail.transactions.length ? (
            <section className="card overflow-hidden">
              <header className="border-b border-border px-4 py-3 sm:px-5">
                <h2 className="text-sm font-semibold">Payments</h2>
                <p className="text-xs text-muted-foreground">
                  {detail.transactions.length} payment{detail.transactions.length === 1 ? "" : "s"} for this guest
                </p>
              </header>
              <ul className="divide-y divide-border px-4 sm:px-5">
                {detail.transactions.map((tx) => (
                  <li key={tx.id} className="flex items-center gap-3 py-3">
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                        tx.status === "paid"
                          ? "bg-emerald-500/10 text-emerald-600"
                          : tx.status === "failed"
                            ? "bg-red-500/10 text-red-600"
                            : "bg-amber-500/10 text-amber-600",
                      )}
                      aria-hidden="true"
                    >
                      <Wallet className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">{money(tx.amount)}</span>
                        <span className="text-sm text-muted-foreground">{tx.packageName}</span>
                        <StatusBadge tone={statusTone[tx.status] ?? "neutral"}>{tx.status}</StatusBadge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {tx.paidAt ?? tx.createdAt ?? "—"}
                        {tx.mpesaCode ? ` · ${tx.mpesaCode}` : ""}
                        {` · ${tx.devices} device${tx.devices === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    {tx.current ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Viewing</span>
                    ) : (
                      <Link to={home(`/hotspot/${tx.id}`)} className="shrink-0 text-xs font-semibold text-primary hover:underline">
                        Open
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <section className="card flex min-h-[22rem] min-w-0 flex-col overflow-hidden xl:max-h-[44rem]">
          <header className="border-b border-border px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold">History</h2>
            <p className="text-xs text-muted-foreground">{journeyCount} events</p>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
            <GenerationTree
              paid={{
                amount: client.amount,
                packageName: client.packageName,
                paidAt: client.paidAt,
                receipt: client.mpesaCode,
                phone: client.phone,
              }}
              events={detail.connectionLog ?? []}
              vouchers={detail.vouchers}
              live={!ended && !client.deleted}
            />
          </div>
        </section>
      </div>

      {message ? <p className="mt-4 notice" role="alert">{message}</p> : null}

      <Dialog.Root open={dialog === "recharge"} onOpenChange={(next) => { if (!next) setDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">Recharge this guest</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                Issue fresh vouchers on this purchase — the guest's device is put back online with the first one when the
                router answers.
              </Dialog.Description>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="recharge-vouchers" label="Vouchers" hint="One voucher connects one device.">
                <input
                  id="recharge-vouchers"
                  type="number"
                  className="field"
                  min={1}
                  max={50}
                  inputMode="numeric"
                  value={voucherCount}
                  onChange={(event) => setVoucherCount(Math.min(50, Math.max(1, Number(event.target.value) || 1)))}
                />
              </FormField>
              <FormField id="recharge-periods" label="Periods each" hint={`1 period = ${client.packageName}'s validity.`}>
                <input
                  id="recharge-periods"
                  type="number"
                  className="field"
                  min={1}
                  max={60}
                  inputMode="numeric"
                  value={rechargePeriods}
                  onChange={(event) => setRechargePeriods(Math.min(60, Math.max(1, Number(event.target.value) || 1)))}
                />
              </FormField>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton type="button" onClick={() => setDialog(null)}>Cancel</SecondaryButton>
              <PrimaryButton
                type="button"
                disabled={busy === "recharge"}
                onClick={() => {
                  void post("recharge", { vouchers: voucherCount, periods: rechargePeriods }).then((ok) => {
                    if (ok) setDialog(null);
                  });
                }}
              >
                {busy === "recharge" ? "Adding…" : "Add access time"}
              </PrimaryButton>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ActionDialog
        open={dialog === "end"}
        onClose={() => setDialog(null)}
        title="End this guest's access?"
        description="Live sessions are dropped, the router accounts are removed, and every voucher is voided. The payment record stays in Billings."
        confirmLabel="End access"
        destructive
        onConfirm={() => {
          void post("end-access");
        }}
      />
      <ActionDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        title="Delete this guest account?"
        description="Access is revoked and the guest leaves the clients list. The payment record stays in Billings."
        confirmLabel="Delete guest"
        destructive
        onConfirm={async () => {
          const ok = await post("delete");
          if (ok) navigate(home("/clients/hotspot"));
        }}
      />
    </div>
  );
}
