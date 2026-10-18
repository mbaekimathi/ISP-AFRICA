import { ArrowRight, PackagePlus, Pencil } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/ui/DetailGrid";
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
      className="group flex h-full flex-col rounded-2xl border border-border bg-surface p-5 shadow-card transition duration-brand ease-brand hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-6"
    >
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <h2 className="mt-4 text-base font-semibold tracking-tight sm:text-lg">{title}</h2>
      <p className="mt-1 flex-1 text-sm leading-6 text-muted-foreground">{description}</p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
        Open packages
        <ArrowRight className="h-4 w-4 transition duration-brand ease-brand group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </Link>
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

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Billings"
        description="Every payment, invoice, and hotspot sale on this account. Filter by service, or pick a day, month, year, or custom period."
      />
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}
      <form className="toolbar mt-6 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()}>
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
      <div className="table-wrap mt-4">
        <table className="data-table min-w-[64rem]">
          <thead>
            <tr>
              <th className="px-3 py-3 font-medium">Date</th>
              <th className="px-3 py-3 font-medium">Customer</th>
              <th className="px-3 py-3 font-medium">Service</th>
              <th className="px-3 py-3 font-medium">Type</th>
              <th className="px-3 py-3 font-medium">Details</th>
              <th className="px-3 py-3 font-medium">M-Pesa code</th>
              <th className="px-3 py-3 text-right font-medium">Amount</th>
              <th className="px-3 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {!report && !message ? (
              <tr>
                <td colSpan={8} className="px-3 py-6">
                  <div className="grid gap-2.5" aria-hidden="true">
                    <div className="skeleton h-4 w-1/3" />
                    <div className="skeleton h-4 w-3/5" />
                    <div className="skeleton h-4 w-2/5" />
                  </div>
                  <span className="sr-only">Loading transactions…</span>
                </td>
              </tr>
            ) : null}
            {report?.transactions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No transactions match these filters.</td>
              </tr>
            ) : null}
            {report?.transactions.map((item) => (
              <tr key={item.id}>
                <td className="whitespace-nowrap px-3 py-3 tabular">{item.createdAt}</td>
                <td className="px-3 py-3">
                  <div className="font-medium">{item.customer || "—"}</div>
                  <div className="text-xs text-muted-foreground">{item.contact}</div>
                </td>
                <td className="px-3 py-3">
                  <StatusBadge tone={item.service === "pppoe" ? "active" : "neutral"}>
                    {item.service === "pppoe" ? "PPPoE" : "Hotspot"}
                  </StatusBadge>
                </td>
                <td className="px-3 py-3">{kindLabel[item.kind]}</td>
                <td className="px-3 py-3">{item.detail || "—"}</td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{item.reference || "—"}</td>
                <td
                  className={`px-3 py-3 text-right font-semibold tabular ${
                    item.status === "paid"
                      ? "text-success"
                      : item.status === "failed" || item.status === "void"
                        ? "text-destructive"
                        : "text-warning"
                  }`}
                >
                  {money(item.amount)}
                </td>
                <td className="px-3 py-3">
                  <StatusBadge tone={statusTone[item.status] ?? "neutral"}>{item.status}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report ? (
        <p className="mt-3 text-xs text-muted-foreground tabular">
          {report.total} transactions · Collected {money(report.collected)}
          {Number(report.outstanding) > 0 ? ` · Outstanding ${money(report.outstanding)}` : ""}
        </p>
      ) : null}

      <h2 className="mt-10 text-base font-semibold tracking-tight sm:text-lg">Packages</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Choose how this account is billed. Edit a default package, or register one of your own.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
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
    </div>
  );
}
