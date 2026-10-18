import { ArrowRight, CircleAlert, Filter, Package, PackagePlus, Pencil, ReceiptText, Wallet } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type ServiceFilter = "all" | "pppoe" | "hotspot";
type PeriodMode = "all" | "day" | "month" | "year" | "period";

type Transaction = {
  id: string;
  kind: "payment" | "invoice" | "stk" | "purchase";
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
};

const statusTone: Record<string, "active" | "due" | "critical" | "paused" | "neutral"> = {
  paid: "active",
  pending: "due",
  processing: "due",
  failed: "critical",
  void: "paused",
};

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
        <form className="grid gap-3 px-5 pb-5 pt-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()}>
          <label className="grid gap-1.5 text-sm font-medium">
            Service
            <select className="field" value={service} onChange={(event) => setService(event.target.value as ServiceFilter)}>
              <option value="all">All services</option>
              <option value="pppoe">PPPoE</option>
              <option value="hotspot">Hotspot</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Period
            <select className="field" value={mode} onChange={(event) => setMode(event.target.value as PeriodMode)}>
              <option value="all">All time</option>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              <option value="period">Custom period</option>
            </select>
          </label>
          {mode === "day" ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Day
              <input type="date" className="field" value={day} onChange={(event) => setDay(event.target.value)} />
            </label>
          ) : null}
          {mode === "month" ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Month
              <input type="month" className="field" value={month} onChange={(event) => setMonth(event.target.value)} />
            </label>
          ) : null}
          {mode === "year" ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Year
              <input
                type="number"
                className="field"
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
              <label className="grid gap-1.5 text-sm font-medium">
                From
                <input type="date" className="field" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                To
                <input type="date" className="field" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
            </>
          ) : null}
        </form>
      </section>

      <section className="card mt-4 overflow-hidden">
        <CardHeader icon={<ReceiptText className="h-4 w-4" />} title="Transactions">
          {report ? <p className="text-xs tabular-nums text-muted-foreground">{report.total} in this period</p> : null}
        </CardHeader>

        <div className="hidden overflow-x-auto md:block">
          <table className="data-table min-w-[56rem]">
            <thead>
              <tr>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Customer</th>
                <th className="px-5 py-3 font-medium">Service</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Details</th>
                <th className="px-5 py-3 font-medium">M-Pesa code</th>
                <th className="px-5 py-3 text-right font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {!report && !message ? (
                <tr>
                  <td colSpan={8} className="px-5 py-6">
                    <div className="grid gap-2.5" aria-hidden="true">
                      <div className="skeleton h-4 w-1/3" />
                      <div className="skeleton h-4 w-3/5" />
                      <div className="skeleton h-4 w-2/5" />
                    </div>
                    <span className="sr-only">Loading transactions…</span>
                  </td>
                </tr>
              ) : null}
              {report && transactions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-muted-foreground">No transactions match these filters.</td>
                </tr>
              ) : null}
              {transactions.map((item) => (
                <tr key={item.id}>
                  <td className="whitespace-nowrap px-5 py-3 tabular">{item.createdAt}</td>
                  <td className="px-5 py-3">
                    <div className="font-medium">{item.customer || "—"}</div>
                    <div className="text-xs text-muted-foreground">{item.contact}</div>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge tone={item.service === "pppoe" ? "active" : "neutral"}>
                      {item.service === "pppoe" ? "PPPoE" : "Hotspot"}
                    </StatusBadge>
                  </td>
                  <td className="px-5 py-3">{kindLabel[item.kind]}</td>
                  <td className="px-5 py-3">{item.detail || "—"}</td>
                  <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{item.reference || "—"}</td>
                  <td className={`px-5 py-3 text-right font-semibold tabular ${amountClass(item.status)}`}>
                    {money(item.amount)}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge tone={statusTone[item.status] ?? "neutral"}>{item.status}</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-border md:hidden">
          {!report && !message ? (
            <div className="grid gap-2.5 px-5 py-6" aria-hidden="true">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-4 w-3/5" />
              <div className="skeleton h-4 w-2/5" />
              <span className="sr-only">Loading transactions…</span>
            </div>
          ) : null}
          {report && transactions.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No transactions match these filters.</p>
          ) : null}
          {transactions.map((item) => (
            <div key={item.id} className="grid gap-2 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.customer || "—"}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.contact || item.createdAt}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <p className={`font-semibold tabular ${amountClass(item.status)}`}>{money(item.amount)}</p>
                  <StatusBadge tone={statusTone[item.status] ?? "neutral"}>{item.status}</StatusBadge>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                <span className="tabular">{item.createdAt}</span>
                <StatusBadge tone={item.service === "pppoe" ? "active" : "neutral"}>
                  {item.service === "pppoe" ? "PPPoE" : "Hotspot"}
                </StatusBadge>
                <span>{kindLabel[item.kind]}</span>
              </div>
              {item.detail || item.reference ? (
                <p className="truncate text-xs text-muted-foreground">
                  {item.detail}
                  {item.detail && item.reference ? " · " : ""}
                  <span className="font-mono">{item.reference}</span>
                </p>
              ) : null}
            </div>
          ))}
        </div>
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
