import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CircleAlert,
  Filter,
  Inbox,
  Package,
  PackagePlus,
  Pencil,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type ServiceFilter = "all" | "pppoe" | "hotspot";
type PeriodMode = "all" | "day" | "month" | "year" | "period";

type Transaction = {
  id: string;
  kind: "payment" | "invoice" | "stk" | "purchase" | "gateway";
  method?: string;
  service: "pppoe" | "hotspot";
  customer: string;
  contact: string;
  detail: string;
  reference: string;
  amount: string;
  status: string;
  createdAt: string;
};

type TransactionReport = {
  transactions: Transaction[];
  total: number;
  collected: string;
  outstanding: string;
};

const serviceFilters: Array<{ value: ServiceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pppoe", label: "PPPoE" },
  { value: "hotspot", label: "Hotspot" },
];

const periodFilters: Array<{ value: PeriodMode; label: string }> = [
  { value: "all", label: "All time" },
  { value: "day", label: "Day" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "period", label: "Custom" },
];

function paymentMode(item: Transaction): string {
  const method = String(item.method || "").trim().toLowerCase();
  if (item.kind === "stk" || item.kind === "purchase" || item.kind === "gateway" || method === "stk" || method === "mpesa") {
    return "M-Pesa";
  }
  if (item.kind === "invoice") return "Invoice";
  if (method === "manual") return "Manual";
  if (method === "cash") return "Cash";
  if (method === "bank") return "Bank";
  if (method) return method.charAt(0).toUpperCase() + method.slice(1);
  return "Payment";
}

function money(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

function localDay(value = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function monthRange(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return null;
  const last = String(new Date(year, month, 0).getDate()).padStart(2, "0");
  return { from: `${value}-01`, to: `${value}-${last}` };
}

function isCredit(item: Transaction) {
  if (item.status === "failed" || item.status === "void") return false;
  if (item.kind === "invoice") return false;
  return item.status === "paid" || item.kind === "payment" || item.kind === "stk" || item.kind === "purchase" || item.kind === "gateway";
}

function statusTone(status: string): StatusTone {
  if (status === "paid") return "active";
  if (status === "failed" || status === "void") return "critical";
  if (status === "pending" || status === "due") return "due";
  return "pending";
}

function statusLabel(status: string) {
  if (!status) return "Open";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function dayKey(createdAt: string) {
  const match = createdAt.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return createdAt;
  return localDay(parsed);
}

function dayHeading(key: string) {
  const today = localDay();
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = localDay(yesterdayDate);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const parsed = new Date(`${key}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return key;
  return parsed.toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function PackageAction({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-4 px-5 py-4 transition hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition duration-brand ease-brand group-hover:scale-105">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <ArrowRight
        className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition duration-brand ease-brand group-hover:translate-x-0.5 group-hover:text-primary"
        aria-hidden="true"
      />
    </Link>
  );
}

function MetricChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-3.5 py-3 backdrop-blur-sm">
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">{label}</p>
      <p
        className={cn(
          "mt-1 truncate text-sm font-semibold tabular tracking-tight sm:text-base",
          tone === "success" && "text-emerald-300",
          tone === "danger" && "text-rose-300",
          tone === "neutral" && "text-white",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex w-full flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface-muted/60 p-0.5 sm:w-max"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-9 flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out sm:flex-none sm:px-3.5",
              value === option.value
                ? "bg-surface text-foreground shadow-xs ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TransactionRow({ item }: { item: Transaction }) {
  const credit = isCredit(item);
  const Icon = credit ? ArrowDownLeft : ArrowUpRight;

  return (
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition hover:bg-surface-muted/70 sm:gap-4 sm:px-5">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition duration-fast ease-out group-hover:scale-105",
          credit ? "bg-success-soft/80 text-success" : "bg-warning-soft/80 text-warning",
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold tracking-tight">{item.customer || paymentMode(item)}</p>
          <StatusBadge tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusBadge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="tabular">{item.createdAt}</span>
          <span aria-hidden="true" className="hidden text-border sm:inline">
            ·
          </span>
          <span>{paymentMode(item)}</span>
          <span className="hidden uppercase tracking-wide sm:inline">{item.service}</span>
          {item.reference ? (
            <>
              <span aria-hidden="true" className="hidden text-border sm:inline">
                ·
              </span>
              <span className="truncate font-mono text-[11px] text-foreground/80" title={item.reference}>
                {item.reference}
              </span>
            </>
          ) : null}
        </div>
        {item.detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{item.detail}</p> : null}
      </div>

      <div className="text-right">
        <p
          className={cn(
            "text-sm font-semibold tabular tracking-tight sm:text-[15px]",
            credit ? "text-success" : item.status === "failed" || item.status === "void" ? "text-destructive" : "text-warning",
          )}
        >
          {credit ? "+" : "−"}
          {money(item.amount)}
        </p>
        <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {credit ? "In" : "Out"}
        </p>
      </div>
    </li>
  );
}

function TransactionSkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5" aria-hidden="true">
          <div className="skeleton h-10 w-10 rounded-full" />
          <div className="min-w-0 space-y-2">
            <div className="skeleton h-3.5 w-2/5" />
            <div className="skeleton h-3 w-3/5" />
          </div>
          <div className="skeleton h-3.5 w-16 justify-self-end" />
        </li>
      ))}
    </>
  );
}

export function BillingsPage() {
  const { user } = useAuth();
  usePageMeta("Billings — ISP CENTRIC", "Every transaction on this account, filtered by service and date.");
  const packagesTo = user ? clientPage(user, "/account/settings/isp-package") : "/account/settings/isp-package";
  const accountNumber = user?.clientCode ?? "";

  const [report, setReport] = useState<TransactionReport | null>(null);
  const [message, setMessage] = useState("");
  const [service, setService] = useState<ServiceFilter>("all");
  const [mode, setMode] = useState<PeriodMode>("all");
  const [day, setDay] = useState(localDay());
  const [month, setMonth] = useState(localDay().slice(0, 7));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const range = useMemo(() => {
    if (mode === "day") return day ? { from: day, to: day } : { from: "", to: "" };
    if (mode === "month") return monthRange(month) ?? { from: "", to: "" };
    if (mode === "year") return /^\d{4}$/.test(year) ? { from: `${year}-01-01`, to: `${year}-12-31` } : { from: "", to: "" };
    if (mode === "period") return { from, to };
    return { from: "", to: "" };
  }, [mode, day, month, year, from, to]);

  function load() {
    const params = new URLSearchParams();
    params.set("service", service);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    apiRequest<TransactionReport>(`/api/billings/transactions?${params.toString()}`)
      .then((body) => {
        setReport(body);
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Transactions could not be loaded.");
      });
  }

  useEffect(() => {
    load();
  }, [service, range]);

  const transactions = report?.transactions ?? [];
  const outstandingDue = report ? Number(report.outstanding) > 0 : false;
  const accountClear = report ? Number(report.outstanding) <= 0 : false;

  const grouped = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const item of transactions) {
      const key = dayKey(item.createdAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return Array.from(map.entries());
  }, [transactions]);

  return (
    <div className="page-shell py-6 sm:py-8">
      <div className="page-header">
        <div className="page-header-text">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Billings</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Account statement for payments, invoices, and hotspot sales.
          </p>
        </div>
      </div>

      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      <section
        className="relative mt-5 overflow-hidden rounded-2xl border border-border shadow-lift sm:rounded-3xl"
        style={{
          background:
            "radial-gradient(ellipse 80% 70% at 12% 0%, rgb(var(--accent-rgb) / 0.28), transparent 55%), radial-gradient(ellipse 60% 50% at 100% 100%, rgb(var(--primary-rgb) / 0.35), transparent 50%), linear-gradient(145deg, #0e1322 0%, #151b2e 48%, #1a2340 100%)",
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "linear-gradient(rgb(255 255 255 / 0.06) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.06) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
          aria-hidden="true"
        />
        <div className="relative grid gap-6 p-5 text-white sm:p-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-end lg:gap-8">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white/85">
                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                Account balance
              </span>
              {accountNumber ? (
                <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 font-mono text-[11px] tracking-[0.16em] text-white/70">
                  {accountNumber}
                </span>
              ) : null}
              {report ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                    outstandingDue
                      ? "border-rose-400/30 bg-rose-500/15 text-rose-200"
                      : "border-emerald-400/30 bg-emerald-500/15 text-emerald-200",
                  )}
                >
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", outstandingDue ? "bg-rose-300" : "bg-emerald-300")}
                    aria-hidden="true"
                  />
                  {outstandingDue ? "Balance due" : "Settled"}
                </span>
              ) : null}
            </div>

            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-white/50">Outstanding</p>
            <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular sm:text-5xl">
              {report ? money(report.outstanding) : "…"}
            </p>
            <p className="mt-2 max-w-md text-sm leading-6 text-white/60">
              {report
                ? outstandingDue
                  ? "Amount still awaiting payment on this account."
                  : "Nothing owed for the selected period."
                : "Loading the latest account position…"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <MetricChip label="Collected" value={report ? money(report.collected) : "…"} tone="success" />
            <MetricChip label="Activity" value={report ? String(report.total) : "…"} />
            <MetricChip
              label="Status"
              value={report ? (accountClear ? "Clear" : "Due") : "…"}
              tone={report ? (accountClear ? "success" : "danger") : "neutral"}
            />
          </div>
        </div>
      </section>

      <section className="card mt-4 overflow-hidden" style={{ animation: "port-rise 420ms var(--ease-out) both" }}>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <Filter className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Statement filters</h2>
            <p className="text-xs text-muted-foreground">Narrow the ledger by service or period</p>
          </div>
        </div>
        <form className="grid gap-4 px-4 py-4 sm:px-5 sm:pb-5" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
            <SegmentedControl label="Service" value={service} options={serviceFilters} onChange={setService} />
            <SegmentedControl label="Period" value={mode} options={periodFilters} onChange={setMode} />
          </div>

          {mode === "day" ? (
            <label className="grid max-w-xs gap-1.5 text-xs font-medium text-muted-foreground">
              Day
              <input
                type="date"
                className="field h-10 min-h-10 w-full py-0 text-sm"
                value={day}
                onChange={(event) => setDay(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "month" ? (
            <label className="grid max-w-xs gap-1.5 text-xs font-medium text-muted-foreground">
              Month
              <input
                type="month"
                className="field h-10 min-h-10 w-full py-0 text-sm"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "year" ? (
            <label className="grid max-w-xs gap-1.5 text-xs font-medium text-muted-foreground">
              Year
              <input
                type="number"
                className="field h-10 min-h-10 w-full py-0 text-sm"
                min={2000}
                max={2100}
                inputMode="numeric"
                value={year}
                onChange={(event) => setYear(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "period" ? (
            <div className="grid gap-3 sm:grid-cols-2 sm:max-w-lg">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                From
                <input
                  type="date"
                  className="field h-10 min-h-10 w-full py-0 text-sm"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                To
                <input
                  type="date"
                  className="field h-10 min-h-10 w-full py-0 text-sm"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            </div>
          ) : null}
        </form>
      </section>

      <section className="mt-6" style={{ animation: "port-rise 480ms var(--ease-out) 60ms both" }}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <ReceiptText className="h-3.5 w-3.5" />
              </span>
              Activity
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">Newest first · money in and out on this account</p>
          </div>
          {report ? (
            <p className="text-xs tabular-nums text-muted-foreground">{report.total} transaction{report.total === 1 ? "" : "s"}</p>
          ) : null}
        </div>

        {report && transactions.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title="No transactions"
              description="No transactions match these filters. Try a different service or period."
            />
          </div>
        ) : (
          <div className="panel mt-3 overflow-hidden">
            {!report && !message ? (
              <ul className="divide-y divide-border">
                <TransactionSkeletonRows />
                <li className="sr-only">Loading transactions…</li>
              </ul>
            ) : (
              <div className="divide-y divide-border">
                {grouped.map(([key, rows]) => (
                  <div key={key}>
                    <div className="sticky top-[calc(var(--header-height)+0.25rem)] z-10 border-b border-border/70 bg-surface-muted/90 px-4 py-2 backdrop-blur-md sm:px-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {dayHeading(key)}
                      </p>
                    </div>
                    <ul className="divide-y divide-border/80">
                      {rows.map((item) => (
                        <TransactionRow key={item.id} item={item} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card mt-4 overflow-hidden" style={{ animation: "port-rise 520ms var(--ease-out) 100ms both" }}>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <Package className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Packages</h2>
            <p className="text-xs text-muted-foreground">Choose how this account is billed</p>
          </div>
        </div>
        <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <PackageAction
            to={`${packagesTo}#registered-packages`}
            icon={<Pencil className="h-5 w-5" aria-hidden="true" />}
            title="Edit default packages"
            description="Company packages start here as defaults. Change the name, price, speed, or routers for this account."
          />
          <PackageAction
            to={`${packagesTo}#register-package`}
            icon={<PackagePlus className="h-5 w-5" aria-hidden="true" />}
            title="Register a new package"
            description="Add a package with its own price and speed, then attach it to the routers on this account."
          />
        </div>
      </section>

      {outstandingDue ? (
        <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground" role="status">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Outstanding balances stay visible until matching payments clear them on this statement.
        </p>
      ) : null}
    </div>
  );
}
