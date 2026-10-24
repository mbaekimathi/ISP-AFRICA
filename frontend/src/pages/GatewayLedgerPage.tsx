import { ArrowLeftRight, BellRing, Landmark, ScrollText, Timer, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormPicker } from "@/components/ui/FormField";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Summary = {
  mode: string | null;
  balance: string;
  unbatchedPayments: number;
  settlement: {
    mode: string | null;
    holdHours: number | null;
    minPayoutOverride: string | null;
    settleEveryNTx: number | null;
    settleSchedule: { day: string; time: string }[] | null;
    lastSettledAt: string | null;
  };
  destination: { type: string | null; value: string | null; accountReference: string | null };
  pendingChange: string | null;
  pendingChangeEffectiveAt: string | null;
};

function settlementText(settlement: Summary["settlement"]) {
  if (settlement.mode === "delayed") return `After ${settlement.holdHours}h`;
  if (settlement.mode === "transactions") {
    return `Every ${settlement.settleEveryNTx ?? "?"} payments`;
  }
  if (settlement.mode === "scheduled") {
    const periods = settlement.settleSchedule?.length ?? 0;
    return periods === 1 ? "1 scheduled time" : `${periods} scheduled times`;
  }
  return "Immediate";
}

type PaymentRow = {
  id: string;
  source: string;
  channel: string;
  msisdn: string;
  amount: string;
  mpesa_receipt: string | null;
  status: string;
  custody: string;
  batch_id: string | null;
  transfers_total: number;
  transfers_confirmed: number;
  transfer_receipt: string | null;
  created_at: string;
};

type PayoutRow = {
  id: string;
  destination_type: string;
  destination_value: string;
  account_reference: string;
  amount: string;
  status: string;
  mpesa_receipt: string | null;
  last_error: string;
  batch_status: string | null;
  created_at: string;
};

type LedgerRow = {
  id: string;
  type: string;
  amount: string;
  balance_after: string;
  payment_id: string | null;
  payout_id: string | null;
  created_at: string;
};

type NoticeRow = { id: string; kind: string; subject: string; detail: string; created_at: string };

type Tab = "payments" | "payouts" | "ledger" | "notices";

const custodyTone: Record<string, StatusTone> = {
  delivered: "active",
  in_transit: "pending",
  scheduled: "pending",
  held: "due",
  awaiting: "paused",
  under_review: "overdue",
  unmatched: "critical",
  failed: "critical",
};

const payoutTone: Record<string, StatusTone> = {
  confirmed: "active",
  submitted: "pending",
  submitting: "pending",
  queued: "neutral",
  timed_out: "overdue",
  needs_review: "overdue",
  failed: "critical",
};

const custodyLabel: Record<string, string> = {
  awaiting: "Not confirmed",
  held: "Held — not transferred",
  scheduled: "Queued to transfer",
  in_transit: "Transferring",
  delivered: "Transferred",
  under_review: "Transfer under review",
  unmatched: "Unmatched",
  failed: "Failed",
};

const ledgerLabel: Record<string, string> = {
  collection: "Collection",
  payout: "Payout sent",
  commission: "Company commission",
  payout_fee: "Payout fee",
  reversal: "Reversal",
  adjustment: "Adjustment",
};

function money(value: string | number | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

function signedMoney(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const formatted = money(Math.abs(amount));
  return amount < 0 ? `−${formatted}` : `+${formatted}`;
}

function StatCard({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight">{value}</div>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function pendingChangeText(raw: string | null) {
  if (!raw) return "";
  try {
    const change = JSON.parse(raw) as { destination_type?: string; destination_value?: string };
    return `${change.destination_type ?? "?"} destination`;
  } catch {
    return "a new payout destination";
  }
}

export function GatewayLedgerPage() {
  const { user } = useAuth();
  usePageMeta("Gateway billings — ISP CENTRIC", "Money collected through the company gateway and its settlement status.");
  const settingsTo = user ? clientPage(user, "/account/settings/isp-payments") : "/account/settings/isp-payments";

  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<Tab>("payments");
  const [paymentStatus, setPaymentStatus] = useState("all");
  const [paymentsOffset, setPaymentsOffset] = useState(0);
  const [paymentsMore, setPaymentsMore] = useState(false);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[] | null>(null);
  const [entries, setEntries] = useState<LedgerRow[] | null>(null);
  const [notices, setNotices] = useState<NoticeRow[] | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiRequest<Summary>("/api/gateway/summary")
      .then(setSummary)
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "Gateway summary could not be loaded."));
  }, []);

  useEffect(() => {
    const fail = (cause: unknown) =>
      setMessage(cause instanceof Error ? cause.message : "That view could not be loaded.");
    if (tab === "payments") {
      if (paymentsOffset === 0) setPayments(null);
      const params = new URLSearchParams({ limit: "500", offset: String(paymentsOffset) });
      if (paymentStatus !== "all") params.set("status", paymentStatus);
      apiRequest<{ payments?: PaymentRow[] }>(`/api/gateway/payments?${params}`)
        .then((b) => {
          const batch = b.payments ?? [];
          setPayments((rows) => (paymentsOffset === 0 ? batch : [...(rows ?? []), ...batch]));
          setPaymentsMore(batch.length >= 500);
        })
        .catch(fail);
    }
    if (tab === "payouts") apiRequest<{ payouts?: PayoutRow[] }>("/api/gateway/payouts").then((b) => setPayouts(b.payouts ?? [])).catch(fail);
    if (tab === "ledger") apiRequest<{ entries?: LedgerRow[] }>("/api/gateway/ledger").then((b) => setEntries(b.entries ?? [])).catch(fail);
    if (tab === "notices") apiRequest<{ notifications?: NoticeRow[] }>("/api/gateway/notifications").then((b) => setNotices(b.notifications ?? [])).catch(fail);
  }, [tab, paymentStatus, paymentsOffset]);

  const pooled = summary?.mode === "company_gateway";

  return (
    <div className="page-shell py-6 sm:py-8">
      <PageHeader
        title="Gateway billings"
        description="Payments collected through the company M-Pesa gateway, held safely, then settled to your payout destination."
      />
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      {summary && !pooled ? (
        <section className="card mt-4">
          <div className="px-5 py-8 text-sm text-muted-foreground">
            This account is not on the company gateway — collections use{" "}
            {summary.mode === "own_daraja" ? "your own Daraja API" : "no payment source yet"}. Opt in from{" "}
            <Link className="font-medium text-primary" to={settingsTo}>
              payment settings
            </Link>
            .
          </div>
        </section>
      ) : null}

      {summary && pooled ? (
        <>
          {summary.pendingChange ? (
            <p className="notice mt-4" role="status">
              A payout destination change ({pendingChangeText(summary.pendingChange)}) applies at{" "}
              {summary.pendingChangeEffectiveAt}. Contact the company before then to stop it.
            </p>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={<Wallet className="h-4 w-4" />}
              label="Held balance"
              value={money(summary.balance)}
              hint={`${summary.unbatchedPayments} payment${summary.unbatchedPayments === 1 ? "" : "s"} awaiting settlement`}
            />
            <StatCard
              icon={<Timer className="h-4 w-4" />}
              label="Settlement"
              value={settlementText(summary.settlement)}
              hint="When held money is released"
            />
            <StatCard
              icon={<Landmark className="h-4 w-4" />}
              label="Pays to"
              value={summary.destination.type ? `${summary.destination.type}` : "Not set"}
              hint={
                summary.destination.type
                  ? `${summary.destination.value ?? ""}${summary.destination.accountReference ? ` · ref ${summary.destination.accountReference}` : ""}`
                  : "Choose a payout destination in payment settings"
              }
            />
            <StatCard
              icon={<ScrollText className="h-4 w-4" />}
              label="Mode"
              value="Company gateway"
              hint="Collections pool through the company shortcode"
            />
          </div>

          <div className="mt-6">
            <FormPicker
              label="Gateway views"
              value={tab}
              onChange={(id) => { setTab(id as Tab); setPaymentsOffset(0); }}
              options={[
                { id: "payments", label: "Payments" },
                { id: "payouts", label: "Payouts" },
                { id: "ledger", label: "Ledger" },
                { id: "notices", label: "Notices" },
              ]}
            />
          </div>

          {tab === "payments" ? (
            <section className="card mt-4 overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowLeftRight className="h-4 w-4" /></span>
                <h2 className="text-sm font-semibold">All gateway transactions</h2>
                <select
                  className="field ml-auto w-auto py-1.5 text-xs"
                  value={paymentStatus}
                  onChange={(event) => { setPaymentStatus(event.target.value); setPaymentsOffset(0); }}
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  <option value="initiated">Initiated</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="unmatched">Unmatched</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </header>
              <div className="overflow-x-auto">
                <table className="data-table min-w-[48rem]">
                  <thead>
                    <tr>
                      <th className="px-5 py-3 font-medium">When</th>
                      <th className="px-5 py-3 font-medium">Channel</th>
                      <th className="px-5 py-3 font-medium">From</th>
                      <th className="px-5 py-3 font-medium">Receipt</th>
                      <th className="px-5 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Transfer status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments === null ? <LoadingRow cols={6} /> : null}
                    {payments !== null && payments.length === 0 ? (
                      <tr><td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">No transactions through the gateway yet.</td></tr>
                    ) : null}
                    {(payments ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                        <td className="px-5 py-3">{row.channel}/{row.source}</td>
                        <td className="px-5 py-3 tabular">{row.msisdn || "—"}</td>
                        <td className="px-5 py-3 font-mono text-xs">{row.mpesa_receipt || "—"}</td>
                        <td className="px-5 py-3 text-right font-semibold tabular">{money(row.amount)}</td>
                        <td className="px-5 py-3">
                          <StatusBadge tone={custodyTone[row.custody] ?? "neutral"}>{custodyLabel[row.custody] ?? row.custody}</StatusBadge>
                          {row.transfers_total ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {row.transfers_confirmed}/{row.transfers_total} payout{row.transfers_total === 1 ? "" : "s"}
                              {row.transfer_receipt ? <> · <span className="font-mono">{row.transfer_receipt}</span></> : null}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {paymentsMore ? (
                <div className="border-t border-border px-5 py-3 text-center">
                  <button
                    type="button"
                    className="field w-auto py-1.5 text-xs"
                    onClick={() => setPaymentsOffset((n) => n + 500)}
                  >
                    Show older transactions
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "payouts" ? (
            <section className="card mt-4 overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowLeftRight className="h-4 w-4" /></span>
                <h2 className="text-sm font-semibold">Settlement payouts</h2>
              </header>
              <div className="overflow-x-auto">
                <table className="data-table min-w-[48rem]">
                  <thead>
                    <tr>
                      <th className="px-5 py-3 font-medium">When</th>
                      <th className="px-5 py-3 font-medium">Destination</th>
                      <th className="px-5 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Receipt</th>
                      <th className="px-5 py-3 font-medium">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts === null ? <LoadingRow cols={6} /> : null}
                    {payouts !== null && payouts.length === 0 ? (
                      <tr><td colSpan={6} className="px-5 py-10 text-center text-muted-foreground">No payouts yet — money settles once the minimum is reached.</td></tr>
                    ) : null}
                    {(payouts ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                        <td className="px-5 py-3">
                          <div className="tabular">{row.destination_type} {row.destination_value}</div>
                          {row.account_reference ? <div className="text-xs text-muted-foreground">ref {row.account_reference}</div> : null}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold tabular">{money(row.amount)}</td>
                        <td className="px-5 py-3"><StatusBadge tone={payoutTone[row.status] ?? "neutral"}>{row.status}</StatusBadge></td>
                        <td className="px-5 py-3 font-mono text-xs">{row.mpesa_receipt || "—"}</td>
                        <td className="max-w-48 truncate px-5 py-3 text-xs text-muted-foreground" title={row.last_error}>{row.last_error || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {tab === "ledger" ? (
            <section className="card mt-4 overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ScrollText className="h-4 w-4" /></span>
                <h2 className="text-sm font-semibold">Pool ledger</h2>
                <p className="ml-auto text-xs text-muted-foreground">Append-only — corrections appear as new entries</p>
              </header>
              <div className="overflow-x-auto">
                <table className="data-table min-w-[40rem]">
                  <thead>
                    <tr>
                      <th className="px-5 py-3 font-medium">When</th>
                      <th className="px-5 py-3 font-medium">Entry</th>
                      <th className="px-5 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries === null ? <LoadingRow cols={4} /> : null}
                    {entries !== null && entries.length === 0 ? (
                      <tr><td colSpan={4} className="px-5 py-10 text-center text-muted-foreground">The ledger is empty — it fills as payments confirm.</td></tr>
                    ) : null}
                    {(entries ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                        <td className="px-5 py-3">{ledgerLabel[row.type] ?? row.type}</td>
                        <td className={`px-5 py-3 text-right font-semibold tabular ${Number(row.amount) < 0 ? "text-destructive" : "text-success"}`}>
                          {signedMoney(row.amount)}
                        </td>
                        <td className="px-5 py-3 text-right tabular">{money(row.balance_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {tab === "notices" ? (
            <section className="card mt-4 overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><BellRing className="h-4 w-4" /></span>
                <h2 className="text-sm font-semibold">Gateway notices</h2>
              </header>
              <div className="divide-y divide-border">
                {notices === null ? <p className="px-5 py-8 text-sm text-muted-foreground">Loading…</p> : null}
                {notices !== null && notices.length === 0 ? (
                  <p className="px-5 py-8 text-sm text-muted-foreground">No gateway notices yet.</p>
                ) : null}
                {(notices ?? []).map((row) => (
                  <div key={row.id} className="px-5 py-4">
                    <p className="text-sm font-medium">{row.subject}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>
                    <p className="mt-1 text-[11px] tabular text-muted-foreground">{row.kind} · {row.created_at}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function LoadingRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-5 py-6">
        <div className="grid gap-2.5" aria-hidden="true">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-4 w-3/5" />
          <div className="skeleton h-4 w-2/5" />
        </div>
      </td>
    </tr>
  );
}
