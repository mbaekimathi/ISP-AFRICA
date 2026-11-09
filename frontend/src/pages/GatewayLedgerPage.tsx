import { ArrowLeftRight, BellRing, Landmark, Loader2, LockKeyhole, Plus, ScrollText, Send, Timer, Trash2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type SettlementMode = "immediate" | "delayed" | "transactions" | "scheduled";

type PayoutSettings = {
  gateway_mode: string;
  settlement_mode: SettlementMode;
  hold_hours: number;
  settle_every_n_tx: number | null;
  settle_schedule: { day: string; time: string }[] | null;
  destination_type: "phone" | "paybill" | "till" | null;
  destination_value: string;
  account_reference: string;
  min_payout_override: string | null;
  pending_change: string | null;
  pending_change_effective_at: string | null;
};

type GatewayFees = {
  configured: boolean;
  minPayout?: string;
};

const SCHEDULE_DAYS = [
  { id: "daily", label: "Every day" },
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
] as const;

type Summary = {
  mode: string | null;
  balance: string;
  unbatchedPayments: number;
  hold: { code: string; message: string } | null;
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
  mpesa_receipt: string | null;
  created_at: string;
};

type NoticeRow = { id: string; kind: string; subject: string; detail: string; created_at: string };

type Tab = "payments" | "payouts" | "ledger" | "notices" | "settings";

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

const holdTone: Record<string, StatusTone> = {
  eligible: "pending",
  queued: "pending",
  kill_switch: "critical",
  suspended: "critical",
  unconfigured: "critical",
  no_destination: "overdue",
  residual: "due",
  hold: "due",
  threshold: "due",
  schedule: "due",
  minimum: "due",
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
  const paymentsSettingsTo = user ? clientPage(user, "/account/settings/isp-payments") : "/account/settings/isp-payments";

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

  const refreshSummary = useCallback(() => {
    apiRequest<Summary>("/api/gateway/summary")
      .then(setSummary)
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "Gateway summary could not be loaded."));
  }, []);

  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

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
            <Link className="font-medium text-primary" to={paymentsSettingsTo}>
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

          {summary.hold ? (
            <p className="notice mt-4" role="status">
              <StatusBadge tone={holdTone[summary.hold.code] ?? "neutral"}>{summary.hold.code}</StatusBadge>{" "}
              {summary.hold.message}
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
                  : "Set a payout destination under Gateway settings"
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
                { id: "settings", label: "Gateway settings" },
              ]}
            />
          </div>

          {tab === "payments" ? (
            <section className="card mt-4 overflow-hidden">
              <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
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
              <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
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
              <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
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
                        <td className="px-5 py-3">
                          {ledgerLabel[row.type] ?? row.type}
                          {row.mpesa_receipt ? <div className="font-mono text-xs text-muted-foreground">{row.mpesa_receipt}</div> : null}
                        </td>
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
              <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
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

          {tab === "settings" ? (
            <GatewaySettingsPanel onSaved={refreshSummary} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GatewaySettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const [settings, setSettings] = useState<PayoutSettings | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [destinationValue, setDestinationValue] = useState("");
  const [shortcodeKind, setShortcodeKind] = useState<"paybill" | "till" | "">("");
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fees, setFees] = useState<GatewayFees | null>(null);
  const [settleMode, setSettleMode] = useState<SettlementMode>("immediate");
  const [holdHours, setHoldHours] = useState("");
  const [everyNTx, setEveryNTx] = useState("");
  const [periods, setPeriods] = useState<{ day: string; time: string }[]>([]);
  const [minPayout, setMinPayout] = useState("");

  const apply = useCallback((body: { settings: PayoutSettings; readOnly: boolean }) => {
    setSettings(body.settings);
    setReadOnly(body.readOnly);
    if (body.readOnly) setUnlocked(true);
    setSettleMode(body.settings?.settlement_mode ?? "immediate");
    setHoldHours(body.settings?.hold_hours ? String(body.settings.hold_hours) : "");
    setEveryNTx(body.settings?.settle_every_n_tx ? String(body.settings.settle_every_n_tx) : "");
    setPeriods(body.settings?.settle_schedule ?? []);
    setMinPayout(body.settings?.min_payout_override ?? "");
    setLoaded(true);
  }, []);

  useEffect(() => {
    apiRequest<{ settings: PayoutSettings; readOnly: boolean }>("/api/gateway/settings")
      .then(apply)
      .catch((cause: unknown) => {
        setLoaded(true);
        setError(cause instanceof Error ? cause.message : "Gateway settings could not be loaded.");
      });
    apiRequest<GatewayFees>("/api/gateway/fees")
      .then(setFees)
      .catch(() => undefined);
  }, [apply]);

  function unlock() {
    setError("");
    setNotice("");
    setPending(true);
    apiRequest<{ outcome: string; settings: PayoutSettings }>("/api/gateway/settings", {
      method: "POST",
      body: JSON.stringify({ password }),
    })
      .then((result) => {
        if (result.settings) {
          setSettings((current) => (current ? { ...current, ...result.settings } : result.settings));
        }
        setUnlocked(true);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The account password could not be confirmed."))
      .finally(() => setPending(false));
  }

  function save(body: Record<string, unknown>) {
    setError("");
    setNotice("");
    setPending(true);
    apiRequest<{ outcome: string; settings: PayoutSettings }>("/api/gateway/settings", {
      method: "POST",
      body: JSON.stringify({ ...body, password }),
    })
      .then((result) => {
        if (result.settings) {
          setSettings((current) => (current ? { ...current, ...result.settings } : result.settings));
          setSettleMode(result.settings.settlement_mode ?? "immediate");
          setHoldHours(result.settings.hold_hours ? String(result.settings.hold_hours) : "");
          setEveryNTx(result.settings.settle_every_n_tx ? String(result.settings.settle_every_n_tx) : "");
          setPeriods(result.settings.settle_schedule ?? []);
          setMinPayout(result.settings.min_payout_override ?? "");
        }
        setDestinationValue("");
        setShortcodeKind("");
        setNotice(
          result.outcome === "destination-pending"
            ? "Saved — the new payout destination applies after the 24-hour review window."
            : result.outcome === "destination-set"
              ? "Saved — the payout destination is set."
              : "Saved.",
        );
        onSaved?.();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Gateway settings could not be saved."))
      .finally(() => setPending(false));
  }

  if (!loaded) {
    return (
      <section className="card mt-4 px-5 py-8 text-sm text-muted-foreground">
        Loading gateway settings…
      </section>
    );
  }

  const destinationDigits = destinationValue.replace(/\D/g, "");
  const detectedPhone = /^(?:254[17]\d{8}|0[17]\d{8}|[17]\d{8})$/.test(destinationDigits);
  const needsShortcodeKind = Boolean(destinationDigits) && !detectedPhone;
  const completePeriods = periods.filter((period) => period.day && period.time);
  const needsEveryNTx = settleMode === "transactions" && !(Number(everyNTx) >= 1);
  const needsPeriod = settleMode === "scheduled" && !completePeriods.length;

  return (
    <section className="form-card mt-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
          <Timer className="h-5 w-5" />
        </span>
        <div className="grid gap-0.5">
          <h2 className="text-lg font-semibold">Gateway settings</h2>
          <p className="text-sm text-muted-foreground">
            Choose where payouts go and how often money collected by the company is sent to you.
          </p>
        </div>
      </div>

      {readOnly ? (
        <p className="notice mt-4" role="status">
          Staff view — only the account owner can change payout settings.
        </p>
      ) : null}
      {error ? (
        <p className="notice mt-4" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}

      {!unlocked ? (
        <form
          className="mt-4 grid gap-4 rounded-xl border border-border bg-surface-muted/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            unlock();
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning"
              aria-hidden="true"
            >
              <LockKeyhole className="h-4 w-4" />
            </span>
            <div className="grid gap-0.5">
              <h3 className="text-sm font-semibold text-foreground">Confirm your account password</h3>
              <p className="text-sm text-muted-foreground">
                Enter your password to view and change payout destination or frequency.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-52 flex-1">
              <FormField id="gw-ledger-password" label="Account password">
                <input
                  id="gw-ledger-password"
                  type="password"
                  className="field"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </FormField>
            </div>
            <PrimaryButton type="submit" disabled={pending || !password}>
              {pending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Checking…
                </span>
              ) : (
                "Continue"
              )}
            </PrimaryButton>
          </div>
        </form>
      ) : (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-4 border-t border-border pt-4 first:border-0 first:pt-0">
            <div className="flex items-center gap-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Send className="h-4 w-4" />
              </span>
              <div className="grid gap-0.5">
                <h3 className="text-sm font-semibold text-foreground">Where to send your money</h3>
                {settings?.destination_type ? (
                  <p className="text-sm text-muted-foreground">
                    Currently sent to {settings.destination_type} {settings.destination_value}
                    {settings.account_reference ? ` · ref ${settings.account_reference}` : ""}.
                  </p>
                ) : null}
              </div>
            </div>
            <FormField
              id="gw-ledger-destination"
              label="Phone, paybill, or till number"
              hint="Enter your M-Pesa phone number, paybill, or till — payouts go there automatically. Leave empty to keep the current destination."
            >
              <input
                id="gw-ledger-destination"
                className="field"
                inputMode="tel"
                placeholder="e.g. 0712 345 678 or 654321"
                value={destinationValue}
                disabled={readOnly || pending}
                onChange={(event) => setDestinationValue(event.target.value)}
              />
            </FormField>
            {needsShortcodeKind ? (
              <FormField id="gw-ledger-shortcode-kind" label="That number is a">
                <select
                  id="gw-ledger-shortcode-kind"
                  className="field"
                  value={shortcodeKind}
                  disabled={readOnly || pending}
                  onChange={(event) => setShortcodeKind(event.target.value as "paybill" | "till")}
                >
                  <option value="">Choose one</option>
                  <option value="paybill">Paybill</option>
                  <option value="till">Till (Buy Goods)</option>
                </select>
              </FormField>
            ) : null}
          </div>

          <div className="grid gap-4 border-t border-border pt-4">
            <div className="flex items-center gap-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Timer className="h-4 w-4" />
              </span>
              <div className="grid gap-0.5">
                <h3 className="text-sm font-semibold text-foreground">How often you're paid</h3>
                <p className="text-sm text-muted-foreground">
                  Choose when money collected by the company is sent to your destination.
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="gw-ledger-settle-mode" label="Payout frequency">
                <select
                  id="gw-ledger-settle-mode"
                  className="field"
                  value={settleMode}
                  disabled={readOnly || pending}
                  onChange={(event) => setSettleMode(event.target.value as SettlementMode)}
                >
                  <option value="immediate">As soon as money arrives</option>
                  <option value="delayed">After a holding period</option>
                  <option value="transactions">After a number of payments</option>
                  <option value="scheduled">On a set schedule</option>
                </select>
              </FormField>
              {settleMode === "delayed" ? (
                <FormField
                  id="gw-ledger-hold-hours"
                  label="Hold collections for"
                  hint="Each payment becomes payable this many hours after it confirms (1–720)."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="gw-ledger-hold-hours"
                      className="field"
                      inputMode="numeric"
                      value={holdHours}
                      disabled={readOnly || pending}
                      onChange={(event) =>
                        setHoldHours(event.target.value.replace(/\D/g, "").slice(0, 3))
                      }
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">hours</span>
                  </div>
                </FormField>
              ) : null}
              {settleMode === "transactions" ? (
                <FormField
                  id="gw-ledger-every-n"
                  label="Pay out after every"
                  hint="A payout runs once this many payments have been collected (1–10,000)."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="gw-ledger-every-n"
                      className="field"
                      inputMode="numeric"
                      value={everyNTx}
                      disabled={readOnly || pending}
                      onChange={(event) =>
                        setEveryNTx(event.target.value.replace(/\D/g, "").slice(0, 5))
                      }
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">payments</span>
                  </div>
                </FormField>
              ) : null}
              <FormField
                id="gw-ledger-min-payout"
                label="Minimum payout amount"
                hint="Optional — wait until at least this much is due. Leave empty for the company minimum."
              >
                <input
                  id="gw-ledger-min-payout"
                  className="field"
                  inputMode="decimal"
                  placeholder={
                    fees?.minPayout && Number(fees.minPayout) > 0
                      ? `Company minimum ${money(fees.minPayout)}`
                      : "e.g. 500"
                  }
                  value={minPayout}
                  disabled={readOnly || pending}
                  onChange={(event) =>
                    setMinPayout(event.target.value.replace(/[^\d.]/g, "").slice(0, 12))
                  }
                />
              </FormField>
            </div>
            {settleMode === "scheduled" ? (
              <div className="grid gap-2">
                <p className="text-sm font-medium text-foreground">Payout times</p>
                {periods.map((period, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <select
                      className="field flex-1"
                      value={period.day}
                      disabled={readOnly || pending}
                      aria-label={`Payout day ${index + 1}`}
                      onChange={(event) =>
                        setPeriods((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, day: event.target.value } : entry,
                          ),
                        )
                      }
                    >
                      {SCHEDULE_DAYS.map((day) => (
                        <option key={day.id} value={day.id}>
                          {day.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="time"
                      className="field w-32"
                      value={period.time}
                      disabled={readOnly || pending}
                      aria-label={`Payout time ${index + 1}`}
                      onChange={(event) =>
                        setPeriods((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, time: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-muted hover:text-destructive disabled:opacity-60"
                      aria-label={`Remove payout time ${index + 1}`}
                      disabled={readOnly || pending}
                      onClick={() =>
                        setPeriods((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <div>
                  <SecondaryButton
                    type="button"
                    disabled={readOnly || pending || periods.length >= 24}
                    onClick={() =>
                      setPeriods((current) => [...current, { day: "daily", time: "09:00" }])
                    }
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add a payout time
                  </SecondaryButton>
                </div>
                <p className="text-caption text-muted-foreground">
                  Money is sent at each listed time — for example every day at 09:00, or Fridays
                  at 17:00.
                </p>
              </div>
            ) : null}
          </div>

          {!readOnly ? (
            <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/90 px-4 py-3 shadow-card backdrop-blur-md">
              <PrimaryButton
                type="button"
                disabled={
                  pending ||
                  !password ||
                  (needsShortcodeKind && !shortcodeKind) ||
                  needsEveryNTx ||
                  needsPeriod
                }
                onClick={() => {
                  const body: Record<string, unknown> = {
                    settlementMode: settleMode,
                    minPayoutOverride: minPayout.trim(),
                  };
                  if (settleMode === "delayed" && holdHours.trim()) {
                    body.holdHours = holdHours.trim();
                  }
                  if (settleMode === "transactions") {
                    body.settleEveryNTx = everyNTx.trim();
                  }
                  if (settleMode === "scheduled") {
                    body.settleSchedule = completePeriods;
                  }
                  if (destinationValue.trim()) {
                    body.destination = {
                      type: detectedPhone ? "phone" : shortcodeKind,
                      value: destinationValue.trim(),
                      accountReference: "",
                    };
                  }
                  save(body);
                }}
              >
                Save gateway settings
              </PrimaryButton>
            </div>
          ) : null}
        </div>
      )}
    </section>
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
