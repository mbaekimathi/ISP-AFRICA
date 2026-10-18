import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  Copy,
  Gauge,
  Power,
  Router,
  Smartphone,
  Ticket,
  Trash2,
  UserRound,
  Wallet,
  Wifi,
  Zap,
} from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
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

type GuestDetail = {
  client: GuestClient;
  vouchers: Voucher[];
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

export function HotspotClientPage() {
  const { purchaseId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  usePageMeta("Hotspot client — ISP CENTRIC", "Connection, usage, and vouchers for one hotspot guest.");
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"recharge" | "end" | "delete" | null>(null);
  const [voucherCount, setVoucherCount] = useState(1);
  const [rechargePeriods, setRechargePeriods] = useState(1);
  const [copied, setCopied] = useState(false);
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
  const firstHost = detail.hosts?.[0] ?? null;
  const timeLeft = firstLive?.sessionTimeLeft || "—";
  const usedVouchers = detail.vouchers.filter((voucher) => voucher.status === "used").length;
  const toggleSection = (id: string) => (next: boolean) =>
    setOpenSection((current) => (next ? id : current === id ? null : current));
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

  const menuItems: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] = [
    { label: copied ? "Copied" : "Copy voucher codes", icon: <Copy className="h-4 w-4" />, onClick: copyVouchers },
    ...(ended ? [] : [{ label: "divider", onClick: () => undefined }, { label: "Delete guest", icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => setDialog("delete") }]),
  ];

  return (
    <div className="page-shell py-6 sm:py-8">
      <div className="page-header">
        <Link
          to={home("/clients/hotspot")}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Hotspot clients
        </Link>
        <div className="page-header-actions">
          {!ended ? (
            <>
              <PrimaryButton className="min-h-10" onClick={() => setDialog("recharge")}>
                <Zap className="h-4 w-4" aria-hidden="true" />
                Recharge
              </PrimaryButton>
              <SecondaryButton className="min-h-10" onClick={() => setDialog("end")}>
                <Power className="h-4 w-4" aria-hidden="true" />
                End access
              </SecondaryButton>
            </>
          ) : null}
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
              className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-brand text-primary-foreground shadow-sm"
              aria-hidden="true"
            >
              <Wifi className="h-6 w-6" />
              <span className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-surface ${connectionDot}`} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                  {client.phone || "Hotspot guest"}
                </h1>
                <StatusBadge tone={statusTone[client.status] ?? "neutral"}>{client.status}</StatusBadge>
                <StatusBadge tone={client.deleted || ended ? "paused" : online ? "active" : connected ? "due" : "neutral"}>
                  {statusLabel}
                </StatusBadge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                  {client.packageName}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Router className="h-3.5 w-3.5" aria-hidden="true" />
                  {client.routerName || "This router"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                  {usedVouchers}/{detail.vouchers.length} vouchers used
                </span>
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-muted/50 px-3 py-2">
              <Ticket className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <code className="min-w-0 truncate text-sm font-medium">{detail.vouchers[0]?.code || "—"}</code>
              {detail.vouchers.length ? (
                <button
                  type="button"
                  aria-label="Copy voucher codes"
                  title="Copy voucher codes"
                  className="shrink-0 text-muted-foreground transition hover:text-foreground"
                  onClick={copyVouchers}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Status"
          value={statusLabel}
          valueClass={statusColor}
          hint={statusHint}
          hintClass={statusColor}
        />
        <StatCard
          icon={<Smartphone className="h-4 w-4" />}
          label="Live devices"
          value={detail.routerReachable ? String(detail.live.length + (detail.hosts?.length ?? 0)) : "—"}
          hint={
            detail.routerReachable
              ? online
                ? "On the router now"
                : connected
                  ? "Connected — not surfing"
                  : "None on the router"
              : "Router unreachable"
          }
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="Paid"
          value={money(client.amount)}
          hint={client.mpesaCode ? `Receipt ${client.mpesaCode}` : client.status}
        />
        <StatCard
          icon={<CalendarClock className="h-4 w-4" />}
          label="Time left"
          value={online ? timeLeft : "—"}
          hint={online ? "On the live session" : "No open session"}
        />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-4">
          <section className="card overflow-hidden">
            <CardHeader icon={<Activity className="h-4 w-4" />} title="Live now">
              <StatusBadge
                tone={!detail.routerReachable ? "critical" : detail.live.length ? "active" : (detail.hosts?.length ?? 0) ? "due" : "paused"}
              >
                {!detail.routerReachable
                  ? "Router unreachable"
                  : detail.live.length
                    ? `${detail.live.length} online`
                    : (detail.hosts?.length ?? 0)
                      ? `${detail.hosts!.length} connected`
                      : "Idle"}
              </StatusBadge>
            </CardHeader>
            <div className="px-5 pb-5 pt-4">
              {!detail.routerReachable ? (
                <p className="text-sm leading-6 text-muted-foreground">
                  Live device data comes straight from the router. It did not answer — check that the management tunnel
                  and the saved API login still work for {client.routerName || "this router"}.
                </p>
              ) : detail.live.length === 0 && (detail.hosts?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">This guest has no device on the router right now.</p>
              ) : (
                <div className="grid gap-5">
                  {detail.live.length ? (
                    <div className="overflow-x-auto">
                      <table className="data-table min-w-[44rem]">
                        <thead className="border-b border-border text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-2 font-medium">Account</th>
                            <th className="px-2 py-2 font-medium">IP</th>
                            <th className="px-2 py-2 font-medium">MAC</th>
                            <th className="px-2 py-2 font-medium">Uptime</th>
                            <th className="px-2 py-2 font-medium">Idle</th>
                            <th className="px-2 py-2 font-medium">Time left</th>
                            <th className="px-2 py-2 font-medium">Down / Up</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.live.map((session) => (
                            <tr key={session.username || session.mac} className="border-b border-border last:border-0">
                              <td className="px-2 py-2 font-medium">{session.label || session.username || "—"}</td>
                              <td className="px-2 py-2">{session.ip || "—"}</td>
                              <td className="px-2 py-2 text-xs text-muted-foreground">{session.mac || "—"}</td>
                              <td className="px-2 py-2">{session.uptime || "—"}</td>
                              <td className="px-2 py-2">{session.idleTime || "—"}</td>
                              <td className="px-2 py-2">{session.sessionTimeLeft || "—"}</td>
                              <td className="px-2 py-2">{bytes(session.bytesIn)} / {bytes(session.bytesOut)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {(detail.hosts?.length ?? 0) ? (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-warning">
                        Connected — not surfing
                      </p>
                      <div className="overflow-x-auto">
                        <table className="data-table min-w-[40rem]">
                          <thead className="border-b border-border text-xs text-muted-foreground">
                            <tr>
                              <th className="px-2 py-2 font-medium">Device</th>
                              <th className="px-2 py-2 font-medium">IP</th>
                              <th className="px-2 py-2 font-medium">MAC</th>
                              <th className="px-2 py-2 font-medium">On network</th>
                              <th className="px-2 py-2 font-medium">Idle</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(detail.hosts ?? []).map((host) => (
                              <tr key={host.mac} className="border-b border-border last:border-0">
                                <td className="px-2 py-2 font-medium">{host.label || host.mac}</td>
                                <td className="px-2 py-2">{host.ip || "—"}</td>
                                <td className="px-2 py-2 text-xs text-muted-foreground">{host.mac || "—"}</td>
                                <td className="px-2 py-2">{host.uptime || "—"}</td>
                                <td className="px-2 py-2">{host.idleTime || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        These devices are on the router but have not paid or redeemed a voucher yet — they stay behind
                        the portal until they do. Use Recharge above to put a device online right away.
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon={<Gauge className="h-4 w-4" />} title="Usage">
              <p className="text-xs tabular-nums text-muted-foreground">
                {bytes(detail.usage.bytesIn)} down · {bytes(detail.usage.bytesOut)} up across {detail.usage.sessions} sessions
              </p>
            </CardHeader>
            <div className="px-5 pb-5 pt-1">
              <TrendChart
                data={(detail.usage.days ?? []).map((day) => ({ x: day.day.slice(5), y: day.bytesIn + day.bytesOut }))}
                formatY={bytes}
                emptyText="No usage has been accounted for this guest yet."
                ariaLabel="Hotspot guest usage for the last 14 days"
              />
            </div>
          </section>

          <section className="card overflow-hidden">
            <Section
              title="Vouchers"
              open={openSection === "vouchers"}
              onToggle={toggleSection("vouchers")}
              action={
                detail.vouchers.length ? (
                  <span className="text-xs text-muted-foreground">{usedVouchers}/{detail.vouchers.length} used</span>
                ) : undefined
              }
            >
            {detail.vouchers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No vouchers issued for this purchase.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[44rem]">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 font-medium">Code</th>
                      <th className="px-2 py-2 font-medium">Valid for</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 font-medium">Issued</th>
                      <th className="px-2 py-2 font-medium">Used</th>
                      <th className="px-2 py-2 font-medium">Device</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.vouchers.map((voucher) => (
                      <tr key={voucher.id} className="border-b border-border last:border-0">
                        <td className="px-2 py-2 font-mono text-xs font-semibold text-primary">{voucher.code}</td>
                        <td className="px-2 py-2">{duration(voucher.seconds)}</td>
                        <td className="px-2 py-2">
                          <StatusBadge tone={statusTone[voucher.status] ?? "neutral"}>{voucher.status}</StatusBadge>
                        </td>
                        <td className="px-2 py-2">{voucher.issuedAt ?? "—"}</td>
                        <td className="px-2 py-2">{voucher.usedAt ?? "—"}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{voucher.redeemedMac || voucher.redeemedIp || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Sessions" open={openSection === "sessions"} onToggle={toggleSection("sessions")}>
            {detail.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sessions have been accounted yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[48rem]">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 font-medium">Account</th>
                      <th className="px-2 py-2 font-medium">Started</th>
                      <th className="px-2 py-2 font-medium">Stopped</th>
                      <th className="px-2 py-2 font-medium">Length</th>
                      <th className="px-2 py-2 font-medium">Down / Up</th>
                      <th className="px-2 py-2 font-medium">Ended because</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.sessions.map((session, index) => (
                      <tr key={index} className="border-b border-border last:border-0">
                        <td className="px-2 py-2 font-medium">{session.label}</td>
                        <td className="px-2 py-2">{session.start ?? "—"}</td>
                        <td className="px-2 py-2">
                          {session.live ? <StatusBadge tone="active">Live now</StatusBadge> : session.stop ?? "—"}
                        </td>
                        <td className="px-2 py-2">{duration(session.seconds)}</td>
                        <td className="px-2 py-2">{bytes(session.bytesIn)} / {bytes(session.bytesOut)}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{session.cause || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

            <Section title="Timeline" open={openSection === "timeline"} onToggle={toggleSection("timeline")}>
              {detail.timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events recorded yet.</p>
              ) : (
                <ol className="grid gap-3">
                  {detail.timeline.map((event, index) => (
                    <li key={index} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-border/60 pb-3 last:border-0">
                      <span className="text-xs leading-5 text-muted-foreground">{event.at ?? "—"}</span>
                      <span>
                        <span className="block text-sm font-medium">{event.event}</span>
                        <span className="block text-xs leading-5 text-muted-foreground">{event.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </section>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <section className="card overflow-hidden">
            <CardHeader icon={<Wifi className="h-4 w-4" />} title="Connection" />
            <dl className="px-5 py-3">
              <InfoRow label="IP">{firstLive?.ip || firstHost?.ip || client.ip || "Not connected"}</InfoRow>
              <InfoRow label="MAC">{firstLive?.mac || firstHost?.mac || client.mac || "—"}</InfoRow>
              <InfoRow label="Uptime">{firstLive?.uptime || firstHost?.uptime || "—"}</InfoRow>
              <InfoRow label="Idle">{firstLive?.idleTime || firstHost?.idleTime || "—"}</InfoRow>
              <InfoRow label="Time left">{online ? timeLeft : "—"}</InfoRow>
              <InfoRow label="Last seen">{detail.usage.lastSeen ?? "Never"}</InfoRow>
            </dl>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon={<UserRound className="h-4 w-4" />} title="Guest details" />
            <dl className="px-5 py-3">
              <InfoRow label="Phone">{client.phone || "—"}</InfoRow>
              <InfoRow label="Package">{client.packageName}</InfoRow>
              <InfoRow label="Router">{client.routerName || "—"}</InfoRow>
              <InfoRow label="Paid">
                {money(client.amount)}{client.mpesaCode ? ` · ${client.mpesaCode}` : ""}
              </InfoRow>
              <InfoRow label="Requested">{client.createdAt ?? "—"}</InfoRow>
              <InfoRow label="Paid at">{client.paidAt ?? "—"}</InfoRow>
              <InfoRow label="Devices">{client.devices}</InfoRow>
              <InfoRow label="Periods">{client.periods}</InfoRow>
              <InfoRow label="Access ended">{client.endedAt ?? "—"}</InfoRow>
            </dl>
          </section>
        </div>
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
