import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Subscriber = {
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
  live: { connection: string; ip: string; mac: string; uptime: string; router: string; lastSeen: string | null };
  usage: { days: { day: string; bytesIn: number; bytesOut: number }[]; monthBytesIn: number; monthBytesOut: number };
  sessions: { login: string | null; logout: string | null; duration: number; ip: string; bytesIn: number; bytesOut: number; cause: string }[];
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
type DialogKind = "suspend" | "package" | "migrate" | "disconnect" | "terminate";
type Tone = "active" | "due" | "paused" | "neutral";
type TrendPoint = { label: string; date: string; minutes: number; drops: number };

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${value} B`;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function labelFor(status: string): { label: string; tone: Tone } {
  const map: Record<string, { label: string; tone: Tone }> = {
    pending_activation: { label: "Not started yet", tone: "due" },
    active: { label: "Active", tone: "active" },
    suspended: { label: "Suspended", tone: "paused" },
    expired: { label: "Expired", tone: "due" },
    disconnected: { label: "Disconnected", tone: "paused" },
    cancelled: { label: "Service ended", tone: "paused" },
  };
  return map[status] ?? { label: status, tone: "neutral" };
}

function billingLabelFor(status: string): { label: string; tone: Tone } {
  const map: Record<string, { label: string; tone: Tone }> = {
    pending: { label: "Payment pending", tone: "due" },
    paid: { label: "Paid", tone: "active" },
    overdue: { label: "Overdue", tone: "due" },
    suspended: { label: "Billing suspended", tone: "paused" },
    cancelled: { label: "Billing cancelled", tone: "paused" },
  };
  return map[status] ?? { label: status, tone: "neutral" };
}

function invoiceTone(status: string): Tone {
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
      className="group border-t border-border"
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
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [editing, setEditing] = useState(search.get("edit") === "1");
  const [openSection, setOpenSection] = useState<string | null>(search.get("edit") === "1" ? "details" : search.get("recharge") === "1" ? "billing" : null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [reason, setReason] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [healthTrend, setHealthTrend] = useState<TrendPoint[] | null>(null);
  const [usageTrend, setUsageTrend] = useState<TrendPoint[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

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
    const timer = window.setInterval(() => {
      apiRequest<{ connection: Subscriber["connection"]; live: Subscriber["live"]; status: string; billingStatus: string }>(
        `/api/pppoe/subscribers/${subscriberId}/status`,
      )
        .then((body) => {
          setSubscriber((current) => current ? { ...current, connection: body.connection, live: { ...current.live, ...body.live, connection: body.connection }, status: body.status, billingStatus: body.billingStatus } : current);
        })
        .catch(() => undefined);
    }, 20000);
    return () => window.clearInterval(timer);
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
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
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
    setEditing(false);
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
  const home = (path: string) => (user ? clientPage(user, path) : path);
  const status = labelFor(subscriber.status);
  const billing = billingLabelFor(subscriber.billingStatus);
  const connectionDot = subscriber.connection === "online" ? "bg-success" : subscriber.connection === "offline" ? "bg-destructive" : "bg-warning";
  const connectionLabel = subscriber.connection === "online" ? "Online" : subscriber.connection === "offline" ? "Offline" : "Unknown";
  const suspended = subscriber.status === "suspended";
  const pendingApproval = subscriber.status === "pending_activation";
  const ended = subscriber.status === "disconnected" || subscriber.status === "cancelled";
  const sessionOpen = subscriber.connection === "online";
  const initials = `${subscriber.firstName.trim().charAt(0)}${subscriber.lastName.trim().charAt(0)}`.toUpperCase() || "?";
  const outstandingDue = Number(subscriber.billing.outstanding) > 0;
  const paidAmount = Number(amount);
  const packagePrice = Number(subscriber.billing.price);
  const purchasedDays = packagePrice > 0 && paidAmount > 0 ? Math.floor((paidAmount * subscriber.billing.cycleDays) / packagePrice) : 0;
  const anchor = subscriber.billing.expiry && subscriber.billing.expiry > new Date().toISOString().slice(0, 10) ? subscriber.billing.expiry : new Date().toISOString().slice(0, 10);
  const newExpiry = purchasedDays > 0 ? new Date(`${anchor}T00:00:00`) : null;
  if (newExpiry) newExpiry.setDate(newExpiry.getDate() + purchasedDays + subscriber.billing.graceDays);

  // The browser fires a "toggle" event on <details> both for user clicks and
  // when React sets/removes the open attribute. Guard the close branch so a
  // programmatic close of one section can't wipe out the section that was
  // just opened.
  const toggleSection = (id: string) => (next: boolean) =>
    setOpenSection((current) => (next ? id : current === id ? null : current));

  const ledger = [
    ...subscriber.billing.invoices.map((invoice) => ({
      id: `inv-${invoice.id}`,
      createdAt: invoice.createdAt,
      label: invoice.purpose ? invoice.purpose.charAt(0).toUpperCase() + invoice.purpose.slice(1) : "Invoice",
      amount: `KSh ${invoice.amount}`,
      badge: <StatusBadge tone={invoiceTone(invoice.status)}>{invoice.status}</StatusBadge>,
      payment: false,
    })),
    ...subscriber.billing.payments.map((payment) => ({
      id: `pay-${payment.id}`,
      createdAt: payment.createdAt,
      label: `Payment · ${payment.method}`,
      amount: `KSh ${payment.amount}`,
      badge: null,
      payment: true,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const menuItems: { label: string; danger?: boolean; onClick: () => void }[] = [
    ...(ended
      ? []
      : [
          { label: "Change package", onClick: () => setDialog("package") },
          { label: "Move to another router", onClick: () => setDialog("migrate") },
        ]),
    ...(sessionOpen ? [{ label: "Disconnect current session", onClick: () => setDialog("disconnect") }] : []),
    { label: "Reset password", onClick: () => void post("password", {}) },
    { label: "Show password", onClick: () => void post("reveal", {}) },
    {
      label: "Edit customer details",
      onClick: () => {
        setOpenSection("details");
        setEditing(true);
      },
    },
    ...(ended ? [] : [{ label: "divider", onClick: () => undefined }, { label: "End service", danger: true, onClick: () => setDialog("terminate") }]),
  ];

  return (
    <div className="page-shell py-8">
      <SecondaryButton to={home("/clients")}>
        <ArrowLeft className="h-4 w-4" />
        Back to PPPoE clients
      </SecondaryButton>

      <section className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="p-5 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-4">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                  aria-hidden="true"
                >
                  {initials}
                </div>
                <PageHeader title={`${subscriber.firstName} ${subscriber.lastName}`} description={`${subscriber.phone} · ${subscriber.username}`} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <span className={`h-3 w-3 rounded-full ${connectionDot}`} aria-hidden="true" />
                  {connectionLabel}
                </span>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <StatusBadge tone={billing.tone}>{billing.label}</StatusBadge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {subscriber.routerName} · {subscriber.packageName}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                type="button"
                onClick={() => {
                  setOpenSection("billing");
                  window.setTimeout(() => amountRef.current?.focus(), 50);
                }}
              >
                Record payment
              </PrimaryButton>
              {pendingApproval ? (
                <SecondaryButton type="button" onClick={() => void post("activate", {})}>
                  Approve
                </SecondaryButton>
              ) : ended || subscriber.status === "expired" ? null : (
                <SecondaryButton type="button" onClick={() => setDialog("suspend")}>
                  {suspended ? "Continue" : "Suspend"}
                </SecondaryButton>
              )}
              <div className="relative" ref={menuRef}>
                <SecondaryButton type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
                  More
                  <ChevronDown className="h-4 w-4" />
                </SecondaryButton>
                {menuOpen ? (
                  <div role="menu" className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg">
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
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <p className="text-xs text-muted-foreground">Status</p>
            <p className="mt-1 text-sm font-semibold">{connectionLabel}</p>
            <p className="text-xs text-muted-foreground">
              {subscriber.connection === "online"
                ? `IP ${subscriber.live.ip || "—"}`
                : `Last seen ${subscriber.live.lastSeen ?? "never"}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Plan</p>
            <p className="mt-1 text-sm font-semibold">
              {subscriber.downloadMbps ?? "—"}↓ {subscriber.uploadMbps ?? "—"}↑ Mbps
            </p>
            <p className="text-xs text-muted-foreground">{subscriber.packageName}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Usage · 30d</p>
            <p className="mt-1 text-sm font-semibold">{bytes(subscriber.usage.monthBytesIn + subscriber.usage.monthBytesOut)}</p>
            <p className="text-xs text-muted-foreground">
              {bytes(subscriber.usage.monthBytesIn)}↓ {bytes(subscriber.usage.monthBytesOut)}↑
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Outstanding</p>
            <p className={`mt-1 text-sm font-semibold ${outstandingDue ? "text-destructive" : "text-success"}`}>
              {outstandingDue ? `KSh ${subscriber.billing.outstanding}` : "KSh 0"}
            </p>
            <p className="text-xs text-muted-foreground">Due {subscriber.billing.nextDueDate ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Access expires</p>
            <p className="mt-1 text-sm font-semibold">{subscriber.billing.expiry ?? "—"}</p>
            <p className="text-xs text-muted-foreground">{billing.label}</p>
          </div>
        </div>

        <div className="grid gap-4 border-t border-border px-5 py-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">PPPoE username</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="text-sm font-semibold">{subscriber.username}</code>
              <SecondaryButton type="button" className="min-h-7 px-2 text-xs" onClick={() => void navigator.clipboard.writeText(subscriber.username)}>
                Copy
              </SecondaryButton>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">PPPoE password</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="text-sm font-semibold">{password || "••••••••••"}</code>
              {password ? (
                <>
                  <SecondaryButton type="button" className="min-h-7 px-2 text-xs" onClick={() => void navigator.clipboard.writeText(password)}>
                    Copy
                  </SecondaryButton>
                  <SecondaryButton type="button" className="min-h-7 px-2 text-xs" onClick={() => setPassword("")}>
                    Hide
                  </SecondaryButton>
                </>
              ) : (
                <SecondaryButton type="button" className="min-h-7 px-2 text-xs" onClick={() => void post("reveal", {})}>
                  Show
                </SecondaryButton>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Enter these on the customer's router or CPE.</p>
          </div>
        </div>

        <Section title="Payments &amp; billing" open={openSection === "billing"} onToggle={toggleSection("billing")}>
          <div className="grid gap-6 lg:grid-cols-2">
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void post("renew", { amount, mpesaReference: reference });
              }}
            >
              <FormField id="payment-amount" label="Amount (KSh)">
                <input id="payment-amount" ref={amountRef} className="field" value={amount} onChange={(event) => setAmount(event.target.value)} />
              </FormField>
              {paidAmount > 0 && packagePrice > 0 ? (
                <p className="text-xs text-muted-foreground">
                  ≈ {purchasedDays} {purchasedDays === 1 ? "day" : "days"} of internet
                  {newExpiry ? ` · access until ${newExpiry.toISOString().slice(0, 10)}` : ""}
                  {purchasedDays === 0 ? " · less than a day — enter a higher amount" : ""}
                </p>
              ) : null}
              <FormField id="payment-reference" label="M-Pesa reference (optional)">
                <input id="payment-reference" className="field" value={reference} onChange={(event) => setReference(event.target.value)} />
              </FormField>
              <div className="flex flex-wrap gap-2">
                <PrimaryButton type="submit">Record payment</PrimaryButton>
                <SecondaryButton type="button" onClick={() => void post("payment", { amount, method: "stk" })}>Send STK push</SecondaryButton>
              </div>
            </form>
            <div>
              <h3 className="text-sm font-semibold">Invoices &amp; payments</h3>
              {ledger.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No invoices or payments yet.</p>
              ) : (
                <ul className="mt-3 grid gap-2 text-sm">
                  {ledger.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2">
                      <span>{entry.label}</span>
                      <span className="flex items-center gap-2">
                        <span className={entry.payment ? "font-medium text-success" : "font-medium"}>{entry.amount}</span>
                        {entry.badge}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <Section title="Usage" open={openSection === "usage"} onToggle={toggleSection("usage")}>
          <p className="text-sm text-muted-foreground">
            Plan {subscriber.downloadMbps ?? "—"}↓ / {subscriber.uploadMbps ?? "—"}↑ Mbps · Last 30 days{" "}
            {bytes(subscriber.usage.monthBytesIn + subscriber.usage.monthBytesOut)} ({bytes(subscriber.usage.monthBytesIn)}↓ {bytes(subscriber.usage.monthBytesOut)}↑)
          </p>
        </Section>

        <Section
          title="Customer details"
          open={openSection === "details" || editing}
          onToggle={toggleSection("details")}
          action={
            editing ? null : (
              <SecondaryButton
                type="button"
                className="min-h-8 px-3"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenSection("details");
                  setEditing(true);
                }}
              >
                Edit
              </SecondaryButton>
            )
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Connection</h3>
              <DetailGrid items={[
                { label: "State", value: connectionLabel },
                { label: "IP", value: subscriber.live.ip || "Not connected" },
                { label: "MAC", value: subscriber.live.mac || "—" },
                { label: "Uptime", value: subscriber.live.uptime || "—" },
                { label: "Router", value: subscriber.live.router },
                { label: "Last seen", value: subscriber.live.lastSeen ?? "Never" },
              ]} />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Customer details</h3>
              {editing ? (
                <form className="mt-3 grid gap-3" onSubmit={(event) => void saveEdit(event)}>
                  <FormField id="edit-firstName" label="First name"><input id="edit-firstName" className="field" name="firstName" defaultValue={subscriber.firstName} /></FormField>
                  <FormField id="edit-lastName" label="Last name"><input id="edit-lastName" className="field" name="lastName" defaultValue={subscriber.lastName} /></FormField>
                  <FormField id="edit-phone" label="Phone"><input id="edit-phone" className="field" name="phone" defaultValue={subscriber.phone} /></FormField>
                  <FormField id="edit-email" label="Email"><input id="edit-email" className="field" name="email" defaultValue={subscriber.email} /></FormField>
                  <FormField id="edit-buildingName" label="Building"><input id="edit-buildingName" className="field" name="buildingName" defaultValue={subscriber.buildingName} /></FormField>
                  <FormField id="edit-houseNumber" label="House number"><input id="edit-houseNumber" className="field" name="houseNumber" defaultValue={subscriber.houseNumber} /></FormField>
                  <FormField id="edit-serial" label="Device serial"><input id="edit-serial" className="field" name="serial" defaultValue={subscriber.serial} /></FormField>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton type="submit">Save</PrimaryButton>
                    <SecondaryButton type="button" onClick={() => setEditing(false)}>Cancel</SecondaryButton>
                  </div>
                </form>
              ) : (
                <DetailGrid items={[
                  { label: "Phone", value: subscriber.phone || "—" },
                  { label: "Email", value: subscriber.email || "—" },
                  { label: "Building", value: subscriber.buildingName || "—" },
                  { label: "House", value: subscriber.houseNumber || "—" },
                  { label: "Device serial", value: subscriber.serial || "—" },
                  { label: "IP assignment", value: subscriber.staticIp || "From pool" },
                ]} />
              )}
            </div>
          </div>
        </Section>

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
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2">Started</th>
                      <th className="py-2">Ended</th>
                      <th className="py-2">Duration</th>
                      <th className="py-2">IP</th>
                      <th className="py-2">Downloaded</th>
                      <th className="py-2">Uploaded</th>
                      <th className="py-2">Ended because</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriber.sessions.length === 0 ? <tr><td colSpan={7} className="py-3 text-muted-foreground">No sessions yet.</td></tr> : null}
                    {subscriber.sessions.map((session) => (
                      <tr key={`${session.login}-${session.ip}`} className="border-t border-border">
                        <td className="py-2">{session.login ?? "—"}</td>
                        <td className="py-2">{session.logout ?? <span className="text-success">Still connected</span>}</td>
                        <td className="py-2">{duration(session.duration)}</td>
                        <td className="py-2">{session.ip}</td>
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

        <div className="grid border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-border">
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
          <div className="p-5">
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
    </div>
  );
}
