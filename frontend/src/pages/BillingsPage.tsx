import {
  ArrowRight,
  Banknote,
  CircleAlert,
  FileText,
  Filter,
  Inbox,
  Landmark,
  Package,
  PackagePlus,
  Pencil,
  ReceiptText,
  Smartphone,
  Ticket,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
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

const kindLabel: Record<Transaction["kind"], string> = {
  payment: "Payment",
  invoice: "Invoice",
  stk: "STK push",
  purchase: "Hotspot sale",
  gateway: "Gateway payment",
};

const statusTone: Record<string, "active" | "due" | "critical" | "paused" | "neutral"> = {
  paid: "active",
  pending: "due",
  processing: "due",
  failed: "critical",
  void: "paused",
};

const kindIcon: Record<Transaction["kind"], ReactNode> = {
  payment: <Banknote className="h-4 w-4" />,
  invoice: <FileText className="h-4 w-4" />,
  stk: <Smartphone className="h-4 w-4" />,
  purchase: <Ticket className="h-4 w-4" />,
  gateway: <Landmark className="h-4 w-4" />,
};

const serviceFilters: Array<{ value: ServiceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pppoe", label: "PPPoE" },
  { value: "hotspot", label: "Hotspot" },
];

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

function amountClass(status: string) {
  if (status === "paid") return "text-success";
  if (status === "failed" || status === "void") return "text-destructive";
  return "text-warning";
}

function iconTone(status: string) {
  if (status === "paid") return "bg-success-soft/70 text-success";
  if (status === "failed" || status === "void") return "bg-destructive-soft/70 text-destructive";
  return "bg-warning-soft/70 text-warning";
}

function TransactionCard({ item }: { item: Transaction }) {
  return (
    <article className="flex h-full flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5 shadow-xs transition duration-fast ease-out hover:border-primary/40 hover:shadow-card">
      <div className="flex items-center gap-2.5">
        <span
          className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", iconTone(item.status))}
          aria-hidden="true"
        >
          {kindIcon[item.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-5">{item.customer || "—"}</p>
          <p className="truncate text-xs text-muted-foreground">{item.contact || kindLabel[item.kind]}</p>
        </div>
        <p className={cn("shrink-0 text-sm font-semibold tabular", amountClass(item.status))}>{money(item.amount)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
        <StatusBadge tone={statusTone[item.status] ?? "neutral"}>{item.status}</StatusBadge>
        <StatusBadge tone={item.service === "pppoe" ? "active" : "neutral"}>
          {item.service === "pppoe" ? "PPPoE" : "Hotspot"}
        </StatusBadge>
        <span className="tabular">{item.createdAt}</span>
        <span className="ml-auto">{kindLabel[item.kind]}</span>
      </div>
      {item.detail || item.reference ? (
        <p className="truncate text-xs text-muted-foreground" title={`${item.detail} ${item.reference}`.trim()}>
          {item.detail}
          {item.detail && item.reference ? " · " : ""}
          <span className="font-mono text-[11px]">{item.reference}</span>
        </p>
      ) : null}
    </article>
  );
}

function TransactionSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5 shadow-xs">
      <div className="flex items-center gap-2.5">
        <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="skeleton h-3 w-2/3" />
          <div className="skeleton h-2.5 w-1/3" />
        </div>
        <div className="skeleton h-3.5 w-12" />
      </div>
      <div className="border-t border-border/60 pt-2.5">
        <div className="skeleton h-5 w-3/4 rounded-full" />
      </div>
    </div>
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

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
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
          className="flex flex-wrap items-end gap-x-4 gap-y-3 px-5 pb-5 pt-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Service</span>
            <div
              role="group"
              aria-label="Service"
              className="inline-flex w-max items-center gap-0.5 rounded-lg border border-border bg-surface-muted/60 p-0.5"
            >
              {serviceFilters.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={service === value}
                  onClick={() => setService(value)}
                  className={cn(
                    "rounded-md px-3.5 py-1.5 text-xs font-semibold transition duration-fast ease-out",
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
              className="field h-9 min-h-9 w-full py-0 text-sm sm:w-44"
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
                className="field h-9 min-h-9 w-full py-0 text-sm sm:w-40"
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
                className="field h-9 min-h-9 w-full py-0 text-sm sm:w-40"
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
                className="field h-9 min-h-9 w-full py-0 text-sm sm:w-28"
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
                  className="field h-9 min-h-9 w-full py-0 text-sm sm:w-40"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                To
                <input
                  type="date"
                  className="field h-9 min-h-9 w-full py-0 text-sm sm:w-40"
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

        {!report && !message ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <TransactionSkeleton key={index} />
            ))}
            <span className="sr-only">Loading transactions…</span>
          </div>
        ) : report && transactions.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title="No transactions"
              description="No transactions match these filters. Try a different service or period."
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {transactions.map((item) => (
              <TransactionCard key={item.id} item={item} />
            ))}
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
