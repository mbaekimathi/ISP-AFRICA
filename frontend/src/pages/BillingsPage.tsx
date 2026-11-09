import {
  ArrowRight,
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
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
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
    <div className="rounded-xl border border-border bg-surface p-2.5 shadow-card sm:rounded-2xl sm:p-4">
      <div className="flex items-center justify-between gap-1.5">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">
          {label}
        </p>
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md sm:h-7 sm:w-7 sm:rounded-lg ${iconClass ?? "bg-primary/10 text-primary"}`}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <div
        className={`mt-1.5 flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold tracking-tight sm:mt-2 sm:text-lg ${valueClass ?? ""}`}
      >
        {value}
      </div>
      {hint != null && hint !== "" ? (
        <p className={`mt-0.5 truncate text-[10px] sm:text-xs ${hintClass ?? "text-muted-foreground"}`}>{hint}</p>
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

function amountClass(status: string) {
  if (status === "paid") return "text-success";
  if (status === "failed" || status === "void") return "text-destructive";
  return "text-warning";
}

const transactionGrid =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-3 sm:grid-cols-[8.5rem_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-x-4 sm:px-5";

function TransactionRow({ item }: { item: Transaction }) {
  return (
    <li className={transactionGrid}>
      <p className="order-1 truncate text-[11px] tabular text-muted-foreground sm:order-none sm:text-sm">
        {item.createdAt}
      </p>
      <p className="order-3 col-span-2 truncate text-sm font-medium sm:order-none sm:col-span-1">
        {item.customer || "—"}
      </p>
      <p className="order-4 truncate text-sm sm:order-none">{paymentMode(item)}</p>
      <p
        className={cn(
          "order-5 truncate font-mono text-[11px] sm:order-none sm:text-xs",
          item.reference ? "text-foreground" : "text-muted-foreground",
        )}
        title={item.reference || undefined}
      >
        {item.reference || "—"}
      </p>
      <p className={cn("order-2 text-sm font-semibold tabular sm:order-none sm:text-right", amountClass(item.status))}>
        {money(item.amount)}
      </p>
    </li>
  );
}

function TransactionSkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className={`${transactionGrid} gap-y-1.5`} aria-hidden="true">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-3.5 w-14 justify-self-end" />
          <div className="skeleton col-span-2 h-3 w-2/5 sm:col-span-1 sm:w-28" />
          <div className="skeleton h-3 w-16 sm:w-14" />
          <div className="skeleton h-3 w-24 sm:w-28" />
        </li>
      ))}
    </>
  );
}

export function BillingsPage() {
  const { user } = useAuth();
  usePageMeta("Billings — ISP CENTRIC", "Every transaction on this account, filtered by service and date.");
  const packagesTo = user ? clientPage(user, "/account/settings/isp-package") : "/account/settings/isp-package";

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

  return (
    <div className="page-shell py-6 sm:py-8">
      <div className="page-header">
        <div className="page-header-text">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Billings</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Every payment, invoice, and hotspot sale on this account. Filter by service, or pick a day, month, year, or custom period.
          </p>
        </div>
      </div>

      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        <StatCard
          icon={<ReceiptText className="h-4 w-4" />}
          label="Transactions"
          value={report ? String(report.total) : "…"}
          hint="In the selected period"
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          iconClass="bg-success-soft/70 text-success"
          label="Collected"
          value={report ? money(report.collected) : "…"}
          valueClass="text-success"
          hint="Paid and settled"
        />
        <StatCard
          icon={<CircleAlert className="h-4 w-4" />}
          iconClass={outstandingDue ? "bg-destructive-soft/70 text-destructive" : "bg-success-soft/70 text-success"}
          label="Outstanding"
          value={report ? money(report.outstanding) : "…"}
          valueClass={outstandingDue ? "text-destructive" : "text-success"}
          hint={outstandingDue ? "Awaiting payment" : "Nothing owed"}
        />
      </div>

      <section className="card mt-4 overflow-hidden">
        <CardHeader icon={<Filter className="h-4 w-4" />} title="Filters" />
        <form
          className="grid grid-cols-1 gap-3 px-4 pb-4 pt-3 sm:grid-cols-2 sm:px-5 sm:pb-5 sm:pt-4 md:grid-cols-[auto_minmax(0,11rem)_minmax(0,11rem)] md:items-end"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="grid gap-1.5 sm:col-span-2 md:col-span-1">
            <span className="text-xs font-medium text-muted-foreground">Service</span>
            <div
              role="group"
              aria-label="Service"
              className="inline-flex w-full items-center gap-0.5 rounded-lg border border-border bg-surface-muted/60 p-0.5 sm:w-max"
            >
              {serviceFilters.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={service === value}
                  onClick={() => setService(value)}
                  className={cn(
                    "min-h-9 flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out sm:flex-none sm:px-3.5",
                    service === value
                      ? "bg-surface text-foreground shadow-xs ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Period
            <select
              className="field h-9 min-h-9 w-full py-0 text-sm"
              value={mode}
              onChange={(event) => setMode(event.target.value as PeriodMode)}
            >
              <option value="all">All time</option>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              <option value="period">Custom period</option>
            </select>
          </label>
          {mode === "day" ? (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Day
              <input
                type="date"
                className="field h-9 min-h-9 w-full py-0 text-sm"
                value={day}
                onChange={(event) => setDay(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "month" ? (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Month
              <input
                type="month"
                className="field h-9 min-h-9 w-full py-0 text-sm"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "year" ? (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Year
              <input
                type="number"
                className="field h-9 min-h-9 w-full py-0 text-sm"
                min={2000}
                max={2100}
                inputMode="numeric"
                value={year}
                onChange={(event) => setYear(event.target.value)}
              />
            </label>
          ) : null}
          {mode === "period" ? (
            <>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                From
                <input
                  type="date"
                  className="field h-9 min-h-9 w-full py-0 text-sm"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground md:col-start-2">
                To
                <input
                  type="date"
                  className="field h-9 min-h-9 w-full py-0 text-sm"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            </>
          ) : null}
        </form>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <ReceiptText className="h-3.5 w-3.5" />
            </span>
            Transactions
          </h2>
          {report ? (
            <p className="text-xs tabular-nums text-muted-foreground">{report.total} in this period</p>
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
            <div className="hidden border-b border-border px-5 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[8.5rem_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1fr)_auto] sm:gap-x-4">
              <span>When</span>
              <span>Customer</span>
              <span>Payment</span>
              <span>M-Pesa ref</span>
              <span className="text-right">Amount</span>
            </div>
            <ul className="divide-y divide-border">
              {!report && !message ? (
                <>
                  <TransactionSkeletonRows />
                  <li className="sr-only">Loading transactions…</li>
                </>
              ) : null}
              {transactions.map((item) => (
                <TransactionRow key={item.id} item={item} />
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card mt-4 overflow-hidden">
        <CardHeader icon={<Package className="h-4 w-4" />} title="Packages">
          <p className="text-xs text-muted-foreground">Choose how this account is billed</p>
        </CardHeader>
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
    </div>
  );
}
