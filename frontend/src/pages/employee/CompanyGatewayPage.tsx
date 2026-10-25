import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  Download,
  FileWarning,
  HandCoins,
  Landmark,
  ReceiptText,
  ScrollText,
  Send,
  ShieldCheck,
  Timer,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormPicker } from "@/components/ui/FormField";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type Overview = {
  float: { balance: string | null; checkedAt: string | null };
  gatewayStatus: string | null;
  killSwitch: boolean;
  heldByClient: { clientId: string; balance: string }[];
  payouts: Record<string, { count: number; total: string }>;
  suspenseCount: number;
  pendingDestinationChanges: number;
};

type PaymentRow = {
  id: string;
  client_id: string;
  source: string;
  channel: string;
  msisdn: string;
  amount: string;
  mpesa_receipt: string | null;
  status: string;
  custody: string;
  confirmed_at: string | null;
  created_at: string;
  batch_id: string | null;
  transfers_total: number | null;
  transfers_confirmed: number | null;
  transfer_receipt: string | null;
};

type PayoutRow = {
  id: string;
  batch_id: string;
  client_id: string;
  destination_type: string;
  destination_value: string;
  account_reference: string;
  amount: string;
  status: string;
  mpesa_receipt: string | null;
  last_error: string;
  note: string | null;
  batch_status: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  created_at: string;
};

type BatchRow = {
  id: string;
  client_id: string;
  period_from: string;
  period_to: string;
  gross: string;
  commission: string;
  payout_fee: string;
  net: string;
  status: string;
  entries: number;
  payouts: number;
  created_at: string;
};

type SuspenseRow = {
  id: string;
  channel: string;
  msisdn: string;
  amount: string;
  mpesa_receipt: string | null;
  account_reference: string;
  checkout_id: string | null;
  created_at: string;
};

type PendingRow = {
  client_id: string;
  pending_change: string;
  pending_change_effective_at: string;
  current: { destination_type: string; destination_value: string; account_reference: string };
};

type AuditRow = {
  id: string;
  client_id: string | null;
  actor_kind: string;
  action: string;
  created_at: string;
};

type NoticeRow = { id: string; kind: string; subject: string; detail: string; created_at: string };

type DirectoryEntry = { id: string; name: string; email: string; status: string };

type HeldRow = {
  client_id: string;
  name: string | null;
  balance: string;
  settlement_mode: string;
  hold_hours: number | null;
  destination_type: string | null;
  destination_value: string | null;
  account_reference: string | null;
  gateway_mode: string;
  hold: { code: string; message: string } | null;
};

type Tab = "held" | "payments" | "payouts" | "batches" | "suspense" | "pending" | "audit" | "notices";

const holdTone: Record<string, StatusTone> = {
  eligible: "pending",
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

const settlementLabel: Record<string, string> = {
  immediate: "Immediate",
  delayed: "Delayed",
  transactions: "Every N payments",
  scheduled: "Scheduled",
};

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
  submitting_review: "overdue",
  timed_out: "overdue",
  needs_review: "overdue",
  failed: "critical",
};

const batchTone: Record<string, StatusTone> = {
  paid: "active",
  processing: "pending",
  scheduled: "neutral",
  partially_paid: "due",
  failed: "critical",
};

function money(value: string | number | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

function total(list: { balance: string }[]) {
  return list.reduce((sum, row) => sum + Number(row.balance || 0), 0);
}

function StatCard({ icon, label, value, hint, danger }: { icon: ReactNode; label: string; value: ReactNode; hint?: string; danger?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${danger ? "bg-destructive-soft/70 text-destructive" : "bg-primary/10 text-primary"}`} aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight">{value}</div>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function pendingChangeText(raw: string) {
  try {
    const change = JSON.parse(raw) as { destination_type?: string; destination_value?: string; account_reference?: string };
    return `${change.destination_type ?? "?"} ${change.destination_value ?? ""}${change.account_reference ? ` ref ${change.account_reference}` : ""}`.trim();
  } catch {
    return "a new destination";
  }
}

export function CompanyGatewayPage() {
  usePageMeta("COMPANY GATEWAY BILLINGS — ISP CENTRIC", "Pooled collections, settlements, and payouts across every ISP.");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("held");
  const [heldRows, setHeldRows] = useState<HeldRow[] | null>(null);
  const [maxPerTx, setMaxPerTx] = useState("");
  const [transferFor, setTransferFor] = useState<HeldRow | null>(null);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[] | null>(null);
  const [batches, setBatches] = useState<BatchRow[] | null>(null);
  const [suspense, setSuspense] = useState<SuspenseRow[] | null>(null);
  const [pendingRows, setPendingRows] = useState<PendingRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [notices, setNotices] = useState<NoticeRow[] | null>(null);
  const [message, setMessage] = useState("");
  const [assigning, setAssigning] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEntry[] | null>(null);
  const [payoutBusy, setPayoutBusy] = useState<string | null>(null);

  const loadOverview = useCallback(() => {
    apiRequest<Overview>("/api/employee/company/gateway/overview")
      .then(setOverview)
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "Gateway overview could not be loaded."));
  }, []);

  useEffect(loadOverview, [loadOverview]);

  useEffect(() => {
    setMessage("");
    const fail = (cause: unknown) =>
      setMessage(cause instanceof Error ? cause.message : "That view could not be loaded.");
    const base = "/api/employee/company/gateway";
    if (tab === "held") {
      apiRequest<{ clients: HeldRow[]; directory: DirectoryEntry[]; maxPayoutPerTx: string }>(`${base}/clients`)
        .then((b) => {
          setHeldRows(b.clients);
          setDirectory((current) => current ?? b.directory);
          setMaxPerTx(b.maxPayoutPerTx || "");
        })
        .catch(fail);
    }
    if (tab === "payments") apiRequest<{ payments: PaymentRow[] }>(`${base}/payments`).then((b) => setPayments(b.payments)).catch(fail);
    if (tab === "payouts") apiRequest<{ payouts: PayoutRow[] }>(`${base}/payouts`).then((b) => setPayouts(b.payouts)).catch(fail);
    if (tab === "batches") apiRequest<{ batches: BatchRow[] }>(`${base}/batches`).then((b) => setBatches(b.batches)).catch(fail);
    if (tab === "suspense") apiRequest<{ suspense: SuspenseRow[] }>(`${base}/suspense`).then((b) => setSuspense(b.suspense)).catch(fail);
    if (tab === "pending") apiRequest<{ pending: PendingRow[] }>(`${base}/pending-changes`).then((b) => setPendingRows(b.pending)).catch(fail);
    if (tab === "audit") apiRequest<{ audit: AuditRow[] }>(`${base}/audit`).then((b) => setAudit(b.audit)).catch(fail);
    if (tab === "notices") apiRequest<{ notifications: NoticeRow[] }>(`${base}/notifications`).then((b) => setNotices(b.notifications)).catch(fail);
    if (tab === "suspense" && directory === null)
      apiRequest<{ directory: DirectoryEntry[] }>(`${base}/clients`)
        .then((b) => setDirectory(b.directory))
        .catch(() => setDirectory([]));
  }, [tab]);

  function assignSuspense(paymentId: string) {
    if (!assignTarget.trim()) return;
    setAssignBusy(true);
    apiRequest("/api/employee/company/gateway/suspense/assign", {
      method: "POST",
      body: JSON.stringify({ paymentId, clientId: assignTarget.trim() }),
    })
      .then(() => {
        setSuspense((rows) => (rows ?? []).filter((row) => row.id !== paymentId));
        setAssigning(null);
        setAssignTarget("");
        loadOverview();
      })
      .catch((cause: unknown) =>
        setMessage(cause instanceof Error ? cause.message : "The payment could not be assigned."))
      .finally(() => setAssignBusy(false));
  }

  function exportCsv(kind: string) {
    apiRequest<{ filename: string; csv: string }>(`/api/employee/company/gateway/export?kind=${kind}`)
      .then((body) => {
        const blob = new Blob([body.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = body.filename;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : "Export failed."));
  }

  function payoutAction(payoutId: string, action: "check" | "mark-failed") {
    setPayoutBusy(payoutId);
    setMessage("");
    apiRequest(`/api/employee/company/gateway/payouts/${action}`, {
      method: "POST",
      body: JSON.stringify({ payoutId }),
    })
      .then(() =>
        apiRequest<{ payouts: PayoutRow[] }>("/api/employee/company/gateway/payouts")
          .then((b) => setPayouts(b.payouts)))
      .then(() => {
        if (action === "check")
          setMessage("Status query sent — the payout updates when Daraja answers.");
      })
      .catch((cause: unknown) =>
        setMessage(cause instanceof Error ? cause.message : "That payout action failed."))
      .finally(() => setPayoutBusy(null));
  }

  const held = overview ? total(overview.heldByClient) : 0;
  const payoutCounts = overview?.payouts ?? {};
  const inFlight = (payoutCounts.submitting?.count ?? 0) + (payoutCounts.submitted?.count ?? 0) + (payoutCounts.queued?.count ?? 0);
  const reviewCount = (payoutCounts.needs_review?.count ?? 0) + (payoutCounts.timed_out?.count ?? 0);

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Gateway billings"
        description="Pooled M-Pesa collections and scheduled settlements. Every row shows where the money is right now."
      />
      {overview?.killSwitch ? (
        <p className="notice mt-4 border-destructive-border bg-destructive-soft/60" role="alert">
          The gateway kill switch is on — collections and payouts are halted.
        </p>
      ) : null}
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<Landmark className="h-4 w-4" />}
          label="Payout float"
          value={overview?.float.balance != null ? money(overview.float.balance) : "—"}
          hint={overview?.float.checkedAt ? `Checked ${overview.float.checkedAt}` : "No balance check yet"}
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="Held for ISPs"
          value={money(held)}
          hint={`${overview?.heldByClient.length ?? 0} client${overview?.heldByClient.length === 1 ? "" : "s"} pooled`}
        />
        <StatCard
          icon={<ArrowLeftRight className="h-4 w-4" />}
          label="In flight"
          value={String(inFlight)}
          hint="Queued or submitted payouts"
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          danger={(overview?.suspenseCount ?? 0) + reviewCount + (overview?.pendingDestinationChanges ?? 0) > 0}
          label="Needs attention"
          value={String((overview?.suspenseCount ?? 0) + reviewCount + (overview?.pendingDestinationChanges ?? 0))}
          hint={`${overview?.suspenseCount ?? 0} suspense · ${reviewCount} review · ${overview?.pendingDestinationChanges ?? 0} pending`}
        />
      </div>

      <div className="mt-6">
        <FormPicker
          label="Gateway views"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          options={[
            { id: "held", label: `Held${overview?.heldByClient.length ? ` (${overview.heldByClient.length})` : ""}` },
            { id: "payments", label: "Payments" },
            { id: "payouts", label: "Payouts" },
            { id: "batches", label: "Batches" },
            { id: "suspense", label: `Suspense${overview?.suspenseCount ? ` (${overview.suspenseCount})` : ""}` },
            { id: "pending", label: "Pending" },
            { id: "audit", label: "Audit" },
            { id: "notices", label: "Notices" },
          ]}
        />
      </div>

      {tab === "held" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><HandCoins className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Held balances</h2>
            <p className="ml-auto text-xs text-muted-foreground">
              Why each client's money is still in the pool — send it any time with a manual transfer
            </p>
          </header>
          <DataTable
            head={["Client", "Held", "Settlement", "Destination", "Why it's held", ""]}
            loading={heldRows === null}
            empty={(heldRows ?? []).length === 0 && "No clients are pooled on the company gateway."}
          >
            {(heldRows ?? []).map((row) => {
              const transferable =
                Number(row.balance) > 0 &&
                !!row.destination_type &&
                !!row.destination_value &&
                overview?.gatewayStatus === "active" &&
                !overview?.killSwitch;
              return (
                <tr key={row.client_id}>
                  <td className="px-5 py-3">
                    <div className="text-sm font-medium">{row.name || "Unnamed client"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.client_id.slice(0, 8)}</div>
                  </td>
                  <td className="px-5 py-3 text-right font-semibold tabular">{money(row.balance)}</td>
                  <td className="px-5 py-3 text-sm">
                    {settlementLabel[row.settlement_mode] || row.settlement_mode}
                    {row.settlement_mode === "delayed" ? ` · ${row.hold_hours ?? 24}h` : ""}
                  </td>
                  <td className="px-5 py-3 text-sm">
                    {row.destination_type ? (
                      <>
                        <span className="tabular">{row.destination_type} {row.destination_value}</span>
                        {row.account_reference ? (
                          <div className="text-xs text-muted-foreground">ref {row.account_reference}</div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Not set</span>
                    )}
                  </td>
                  <td className="max-w-80 px-5 py-3">
                    {row.hold ? (
                      <div className="flex items-start gap-2">
                        <StatusBadge tone={holdTone[row.hold.code] ?? "neutral"}>{row.hold.code}</StatusBadge>
                        <span className="text-xs text-muted-foreground">{row.hold.message}</span>
                      </div>
                    ) : Number(row.balance) > 0 ? (
                      <span className="text-xs text-muted-foreground">Not pooled.</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Nothing held.</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <SecondaryButton
                      type="button"
                      disabled={!transferable}
                      title={
                        Number(row.balance) <= 0
                          ? "Nothing is held for this client"
                          : !row.destination_type
                            ? "Set a payout destination first"
                            : "Send held funds to this client's account now"
                      }
                      onClick={() => setTransferFor(row)}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden="true" /> Transfer…
                    </SecondaryButton>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </section>
      ) : null}

      {tab === "payments" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ReceiptText className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Pooled payments</h2>
            <SecondaryButton type="button" className="ml-auto" onClick={() => exportCsv("payments")}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export
            </SecondaryButton>
          </header>
          <DataTable
            head={["When", "Client", "Channel", "From", "Receipt", "Amount", "Status", "Custody"]}
            loading={payments === null}
            empty={(payments ?? []).length === 0 && "No pooled payments yet."}
          >
            {(payments ?? []).map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                <td className="px-5 py-3 font-mono text-xs">{row.client_id ? row.client_id.slice(0, 8) : "—"}</td>
                <td className="px-5 py-3">{row.channel}/{row.source}</td>
                <td className="px-5 py-3 tabular">{row.msisdn || "—"}</td>
                <td className="px-5 py-3 font-mono text-xs">{row.mpesa_receipt || "—"}</td>
                <td className="px-5 py-3 text-right font-semibold tabular">{money(row.amount)}</td>
                <td className="px-5 py-3">{row.status}</td>
                <td className="px-5 py-3">
                  <StatusBadge tone={custodyTone[row.custody] ?? "neutral"}>{row.custody}</StatusBadge>
                  {row.transfers_total ? (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {row.transfers_confirmed}/{row.transfers_total} payout{row.transfers_total === 1 ? "" : "s"}
                      {row.transfer_receipt ? <> · <span className="font-mono">{row.transfer_receipt}</span></> : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "payouts" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowLeftRight className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Settlement payouts</h2>
            <SecondaryButton type="button" className="ml-auto" onClick={() => exportCsv("payouts")}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export
            </SecondaryButton>
          </header>
          <DataTable
            head={["Client", "Destination", "Amount", "Status", "Receipt", "Batch", "Error", "Actions"]}
            loading={payouts === null}
            empty={(payouts ?? []).length === 0 && "No payouts queued yet."}
          >
            {(payouts ?? []).map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3 font-mono text-xs">{row.client_id.slice(0, 8)}</td>
                <td className="px-5 py-3">
                  <div className="tabular">{row.destination_type} {row.destination_value}</div>
                  {row.account_reference ? <div className="text-xs text-muted-foreground">ref {row.account_reference}</div> : null}
                  {row.note ? <div className="text-xs text-muted-foreground">“{row.note}”</div> : null}
                </td>
                <td className="px-5 py-3 text-right font-semibold tabular">{money(row.amount)}</td>
                <td className="px-5 py-3"><StatusBadge tone={payoutTone[row.status] ?? "neutral"}>{row.status}</StatusBadge></td>
                <td className="px-5 py-3 font-mono text-xs">{row.mpesa_receipt || "—"}</td>
                <td className="px-5 py-3 text-xs text-muted-foreground">{row.batch_status || "—"}</td>
                <td className="max-w-52 truncate px-5 py-3 text-xs text-muted-foreground" title={row.last_error}>{row.last_error || "—"}</td>
                <td className="px-5 py-3">
                  {["submitted", "timed_out", "needs_review"].includes(row.status) ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <SecondaryButton
                        type="button"
                        disabled={payoutBusy === row.id}
                        onClick={() => payoutAction(row.id, "check")}
                      >
                        Check status
                      </SecondaryButton>
                      {row.status !== "submitted" ? (
                        <SecondaryButton
                          type="button"
                          disabled={payoutBusy === row.id}
                          onClick={() => payoutAction(row.id, "mark-failed")}
                        >
                          Mark failed
                        </SecondaryButton>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "batches" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ScrollText className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Settlement batches</h2>
            <SecondaryButton type="button" className="ml-auto" onClick={() => exportCsv("batches")}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export
            </SecondaryButton>
          </header>
          <DataTable
            head={["Client", "Period", "Gross", "Commission", "Fee", "Net", "Entries", "Payouts", "Status"]}
            loading={batches === null}
            empty={(batches ?? []).length === 0 && "No settlement batches yet."}
          >
            {(batches ?? []).map((row) => (
              <tr key={row.id}>
                <td className="px-5 py-3 font-mono text-xs">{row.client_id.slice(0, 8)}</td>
                <td className="whitespace-nowrap px-5 py-3 text-xs text-muted-foreground">{row.period_from} → {row.period_to}</td>
                <td className="px-5 py-3 text-right tabular">{money(row.gross)}</td>
                <td className="px-5 py-3 text-right tabular">{money(row.commission)}</td>
                <td className="px-5 py-3 text-right tabular">{money(row.payout_fee)}</td>
                <td className="px-5 py-3 text-right font-semibold tabular">{money(row.net)}</td>
                <td className="px-5 py-3 text-right tabular">{row.entries}</td>
                <td className="px-5 py-3 text-right tabular">{row.payouts}</td>
                <td className="px-5 py-3"><StatusBadge tone={batchTone[row.status] ?? "neutral"}>{row.status}</StatusBadge></td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "suspense" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive-soft/70 text-destructive"><FileWarning className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Unmatched payments</h2>
            <p className="ml-auto text-xs text-muted-foreground">C2B receipts and amount mismatches waiting for attribution</p>
          </header>
          <DataTable
            head={["When", "Channel", "From", "Receipt", "Reference", "Amount", "Assign"]}
            loading={suspense === null}
            empty={(suspense ?? []).length === 0 && "The suspense queue is empty."}
          >
            {(suspense ?? []).map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                <td className="px-5 py-3">{row.channel}</td>
                <td className="px-5 py-3 tabular">{row.msisdn || "—"}</td>
                <td className="px-5 py-3 font-mono text-xs">{row.mpesa_receipt || "—"}</td>
                <td className="px-5 py-3 text-xs text-muted-foreground">{row.account_reference || "—"}</td>
                <td className="px-5 py-3 text-right font-semibold tabular">{money(row.amount)}</td>
                <td className="px-5 py-3">
                  {assigning === row.id ? (
                    <span className="flex items-center gap-2">
                      <input
                        className="field h-8 w-52 text-xs"
                        placeholder="client id or pick from the list"
                        list="gateway-client-directory"
                        value={assignTarget}
                        onChange={(event) => setAssignTarget(event.target.value)}
                      />
                      <datalist id="gateway-client-directory">
                        {(directory ?? []).map((client) => (
                          <option key={client.id} value={client.id}>
                            {client.name || client.email} · {client.id.slice(0, 8)}
                          </option>
                        ))}
                      </datalist>
                      <PrimaryButton type="button" disabled={assignBusy || !assignTarget.trim()} onClick={() => assignSuspense(row.id)}>
                        Assign
                      </PrimaryButton>
                    </span>
                  ) : (
                    <SecondaryButton type="button" onClick={() => { setAssigning(row.id); setAssignTarget(""); }}>
                      Assign…
                    </SecondaryButton>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "pending" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning-soft/70 text-warning"><Timer className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Pending destination changes</h2>
            <p className="ml-auto text-xs text-muted-foreground">Apply after the 24-hour cooling-off window</p>
          </header>
          <DataTable
            head={["Client", "Current", "Becomes", "Applies at"]}
            loading={pendingRows === null}
            empty={(pendingRows ?? []).length === 0 && "No destination changes are cooling off."}
          >
            {(pendingRows ?? []).map((row) => (
              <tr key={row.client_id}>
                <td className="px-5 py-3 font-mono text-xs">{row.client_id.slice(0, 8)}</td>
                <td className="px-5 py-3 text-sm">
                  {row.current.destination_type || "—"} {row.current.destination_value}
                  {row.current.account_reference ? ` ref ${row.current.account_reference}` : ""}
                </td>
                <td className="px-5 py-3 text-sm font-medium">{pendingChangeText(row.pending_change)}</td>
                <td className="whitespace-nowrap px-5 py-3 tabular">{row.pending_change_effective_at}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck className="h-4 w-4" /></span>
            <h2 className="text-sm font-semibold">Gateway audit log</h2>
          </header>
          <DataTable
            head={["When", "Actor", "Client", "Action"]}
            loading={audit === null}
            empty={(audit ?? []).length === 0 && "Nothing audited yet."}
          >
            {(audit ?? []).map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-5 py-3 tabular">{row.created_at}</td>
                <td className="px-5 py-3">{row.actor_kind}</td>
                <td className="px-5 py-3 font-mono text-xs">{row.client_id ? row.client_id.slice(0, 8) : "—"}</td>
                <td className="px-5 py-3 font-mono text-xs">{row.action}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      {tab === "notices" ? (
        <section className="card mt-4 overflow-hidden">
          <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><AlertTriangle className="h-4 w-4" /></span>
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

      {transferFor ? (
        <TransferDialog
          row={transferFor}
          maxPerTx={maxPerTx}
          onClose={() => setTransferFor(null)}
          onSent={(result) => {
            setTransferFor(null);
            loadOverview();
            apiRequest<{ clients: HeldRow[] }>("/api/employee/company/gateway/clients")
              .then((b) => setHeldRows(b.clients))
              .catch(() => setHeldRows(null));
            setMessage(
              `Sent ${money(result.amount)} to ${result.destination}` +
                (result.payouts > 1 ? ` — split into ${result.payouts} payouts.` : ".") +
                (result.floatShort ? " The payout float looks short — the transfer stays queued until it covers." : ""),
            );
          }}
        />
      ) : null}
    </div>
  );
}

type TransferResult = {
  ok: boolean;
  batchId: string;
  amount: string;
  payouts: number;
  destination: string;
  floatShort: boolean;
  balanceAfter: string;
};

function TransferDialog({
  row,
  maxPerTx,
  onClose,
  onSent,
}: {
  row: HeldRow;
  maxPerTx: string;
  onClose: () => void;
  onSent: (result: TransferResult) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parsed = Number(amount);
  const balance = Number(row.balance);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= balance;
  const splits = Number.isFinite(Number(maxPerTx)) && Number(maxPerTx) > 0 && parsed > Number(maxPerTx)
    ? Math.ceil(parsed / Number(maxPerTx))
    : 1;
  const destination = row.destination_type
    ? `${row.destination_type} ${row.destination_value}${row.account_reference ? ` ref ${row.account_reference}` : ""}`
    : "—";

  function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    apiRequest<TransferResult>("/api/employee/company/gateway/transfer", {
      method: "POST",
      body: JSON.stringify({ clientId: row.client_id, amount: parsed, reason: reason.trim() }),
    })
      .then(onSent)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The transfer could not be sent."))
      .finally(() => setBusy(false));
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="text-base font-semibold text-foreground">
            Manual transfer — {row.name || row.client_id.slice(0, 8)}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            Send held funds to this client's payout account now, ahead of the settlement schedule.
          </Dialog.Description>

          <div className="mt-4 grid gap-3 rounded-xl border border-border bg-surface-raised/60 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Held balance</span>
              <span className="font-semibold tabular">{money(row.balance)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Sends to</span>
              <span className="tabular">{destination}</span>
            </div>
          </div>

          <div className="mt-4 grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="transfer-amount">Amount (KES)</label>
            <div className="flex items-center gap-2">
              <input
                id="transfer-amount"
                className="field"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                autoFocus
              />
              <SecondaryButton type="button" onClick={() => setAmount(String(balance))}>
                All
              </SecondaryButton>
            </div>
            {amount && !valid ? (
              <p className="text-xs text-destructive">Enter an amount between 0 and {money(row.balance)}.</p>
            ) : null}
            {splits > 1 ? (
              <p className="text-xs text-muted-foreground">
                Above the per-transaction cap — this sends as {splits} separate payouts.
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="transfer-reason">Reason (optional)</label>
            <input
              id="transfer-reason"
              className="field"
              maxLength={160}
              placeholder="e.g. Early settlement request"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Shown on the payout record and sent as the M-Pesa remarks.</p>
          </div>

          {error ? <p className="notice mt-4" role="alert">{error}</p> : null}

          <div className="mt-5 flex items-center justify-end gap-2">
            <SecondaryButton type="button" disabled={busy} onClick={onClose}>
              Cancel
            </SecondaryButton>
            <PrimaryButton type="button" disabled={!valid || busy} onClick={submit}>
              {busy ? "Sending…" : "Send transfer"}
            </PrimaryButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DataTable({
  head,
  loading,
  empty,
  children,
}: {
  head: string[];
  loading: boolean;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table min-w-[60rem]">
        <thead>
          <tr>
            {head.map((label, index) => (
              <th key={label} className={`px-5 py-3 font-medium ${index >= head.length - 3 && index >= head.length - 2 ? "text-left" : ""}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={head.length} className="px-5 py-6">
                <div className="grid gap-2.5" aria-hidden="true">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-4 w-3/5" />
                  <div className="skeleton h-4 w-2/5" />
                </div>
              </td>
            </tr>
          ) : null}
          {!loading && empty ? (
            <tr>
              <td colSpan={head.length} className="px-5 py-10 text-center text-muted-foreground">{empty}</td>
            </tr>
          ) : null}
          {children}
        </tbody>
      </table>
    </div>
  );
}
