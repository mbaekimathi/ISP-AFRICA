import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Banknote, Wallet } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage } from "@/lib/accounts";
import { clientStaffRoleLabel } from "@/lib/clientStaff";
import {
  addPayrollTransaction,
  formatMoney,
  listPayroll,
  payCycleLabel,
  payCycles,
  payMethodLabel,
  payMethods,
  payrollAccount,
  payrollKindLabel,
  payrollKinds,
  removePayrollTransaction,
  savePayrollAccount,
  type PayCycle,
  type PayMethod,
  type PayrollAccountView,
  type PayrollEmployee,
  type PayrollKind,
  type PayrollTransaction,
} from "@/lib/payroll";
import { useAuth } from "@/providers/AuthProvider";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_TONES: Record<PayrollKind, StatusTone> = {
  salary: "active",
  bonus: "active",
  loan: "due",
  advance: "due",
  repayment: "pending",
  deduction: "error",
};

const KIND_SIGNS: Record<PayrollKind, string> = {
  salary: "+",
  bonus: "+",
  loan: "+",
  advance: "+",
  repayment: "−",
  deduction: "−",
};

function formatPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return `${SHORT_MONTHS[month - 1]} ${year}`;
}

function formatStamp(value: string | null) {
  if (!value) return "";
  const [date, time] = value.split(" ");
  const [y, m, d] = (date ?? "").split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${d} ${SHORT_MONTHS[m - 1]} ${y} · ${(time ?? "").slice(0, 5)}`;
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-caption uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular tracking-tight text-foreground">{value}</p>
      {detail ? <p className="mt-0.5 text-caption text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function MemberBadges({ entry }: { entry: PayrollEmployee }) {
  const { staff } = entry;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="font-semibold">
        {staff.firstName} {staff.lastName}
      </p>
      {staff.status === "pending" ? <StatusBadge tone="pending">Pending approval</StatusBadge> : null}
      {staff.status === "suspended" ? <StatusBadge tone="suspended">Suspended</StatusBadge> : null}
      {staff.role ? <StatusBadge tone="neutral">{clientStaffRoleLabel(staff.role)}</StatusBadge> : null}
      {entry.summary.outstanding > 0 ? (
        <StatusBadge tone="due">{`Owes ${formatMoney(entry.summary.outstanding)}`}</StatusBadge>
      ) : null}
    </div>
  );
}

export function PayrollPage() {
  usePageMeta("Payroll — ISP CENTRIC", "Pay employees and track loans and advances.");
  const { user } = useAuth();
  const [employees, setEmployees] = useState<PayrollEmployee[] | null>(null);
  const [error, setError] = useState("");
  const isDelegate = Boolean(user?.delegate);

  useEffect(() => {
    if (isDelegate) return;
    let stopped = false;
    listPayroll()
      .then((rows) => {
        if (!stopped) setEmployees(rows);
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Payroll could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate]);

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Payroll" />
        <p className="notice">Only the account owner can manage payroll.</p>
      </div>
    );
  }

  const registered = employees?.filter((entry) => entry.account) ?? [];
  const baseTotal = registered.reduce((sum, entry) => sum + (entry.account?.baseSalary ?? 0), 0);
  const paidMonth = employees?.reduce((sum, entry) => sum + entry.summary.paidMonth, 0) ?? 0;
  const outstanding = employees?.reduce((sum, entry) => sum + entry.summary.outstanding, 0) ?? 0;

  return (
    <div className="page-shell py-8">
      <PageHeader title="Payroll" description="Pay employees and track loans and advances." />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-2" aria-label="HR views">
          <SecondaryButton to={user ? clientPage(user, "/hr") : "/hr"}>Employees</SecondaryButton>
          <SecondaryButton to={user ? clientPage(user, "/hr/performance") : "/hr/performance"}>
            Performance
          </SecondaryButton>
          <SecondaryButton to={user ? clientPage(user, "/hr/payroll") : "/hr/payroll"} aria-current="page">
            Payroll
          </SecondaryButton>
        </nav>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Base pay"
          value={formatMoney(baseTotal)}
          detail={`${registered.length} of ${employees?.length ?? 0} employees registered`}
        />
        <StatCard label="Paid this month" value={formatMoney(paidMonth)} detail="Salary and bonuses" />
        <StatCard label="Outstanding" value={formatMoney(outstanding)} detail="Loans and advances to recover" />
      </div>
      {error ? (
        <p className="notice mt-4" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="panel mt-4 divide-y divide-border overflow-hidden">
        {!employees && !error ? (
          <li className="px-4 py-6" aria-hidden="true">
            <div className="grid gap-3">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton h-4 w-1/4" />
            </div>
          </li>
        ) : null}
        {employees?.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">
            No employees are saved yet — add them on the HR page first.
          </li>
        ) : null}
        {employees?.map((entry) => (
          <li
            key={entry.staff.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-fast ease-out hover:bg-surface-muted/50"
          >
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={entry.staff.photoDataUrl}
                alt=""
                className="h-11 w-11 shrink-0 rounded-full border border-border object-cover"
              />
              <div className="min-w-0">
                <MemberBadges entry={entry} />
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {entry.account
                    ? `${formatMoney(entry.account.baseSalary)} · ${payCycleLabel(entry.account.payCycle)} · ${payMethodLabel(entry.account.payMethod)}`
                    : "Payroll details not registered"}
                </p>
                {entry.account ? (
                  <p className="mt-0.5 text-caption text-muted-foreground">
                    Paid this month {formatMoney(entry.summary.paidMonth)} · Paid out{" "}
                    {formatMoney(entry.summary.paidOut)}
                  </p>
                ) : null}
              </div>
            </div>
            <SecondaryButton
              to={user ? clientPage(user, `/hr/payroll/${entry.staff.id}`) : `/hr/payroll/${entry.staff.id}`}
            >
              {entry.account ? "Open payroll" : "Register"}
            </SecondaryButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

type AccountDraft = {
  employeeNo: string;
  baseSalary: string;
  payCycle: PayCycle;
  payMethod: PayMethod;
  mpesaPhone: string;
  bankName: string;
  bankBranch: string;
  bankAccount: string;
  nationalId: string;
  kraPin: string;
  notes: string;
};

const emptyAccountDraft: AccountDraft = {
  employeeNo: "",
  baseSalary: "",
  payCycle: "monthly",
  payMethod: "mpesa",
  mpesaPhone: "",
  bankName: "",
  bankBranch: "",
  bankAccount: "",
  nationalId: "",
  kraPin: "",
  notes: "",
};

type PaymentDraft = {
  kind: PayrollKind;
  amount: string;
  period: string;
  method: PayMethod;
  reference: string;
  notes: string;
};

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const emptyPaymentDraft: PaymentDraft = {
  kind: "salary",
  amount: "",
  period: currentPeriod(),
  method: "cash",
  reference: "",
  notes: "",
};

function PaymentRow({
  tx,
  busy,
  confirming,
  onConfirm,
  onRemove,
}: {
  tx: PayrollTransaction;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const out = payrollKinds.find((item) => item.value === tx.kind)?.out ?? true;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={KIND_TONES[tx.kind]}>{payrollKindLabel(tx.kind)}</StatusBadge>
          <p className="text-sm font-semibold tabular text-foreground">
            {KIND_SIGNS[tx.kind]}
            {formatMoney(tx.amount)}
          </p>
          {tx.period ? <span className="text-caption text-muted-foreground">{formatPeriod(tx.period)}</span> : null}
        </div>
        <p className="mt-0.5 text-caption text-muted-foreground">
          {payMethodLabel(tx.method)}
          {tx.reference ? ` · Ref ${tx.reference}` : ""}
          {tx.createdAt ? ` · ${formatStamp(tx.createdAt)}` : ""}
        </p>
        {tx.notes ? <p className="mt-0.5 text-caption text-muted-foreground">{tx.notes}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold tabular ${out ? "text-success" : "text-destructive"}`}>
          {out ? "Paid" : "Recovered"}
        </span>
        {confirming ? (
          <SecondaryButton type="button" disabled={busy} onClick={onRemove}>
            {busy ? "Removing…" : "Confirm remove"}
          </SecondaryButton>
        ) : (
          <SecondaryButton type="button" disabled={busy} onClick={onConfirm}>
            Remove
          </SecondaryButton>
        )}
      </div>
    </li>
  );
}

function SectionCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PayrollAccountPage() {
  usePageMeta("Payroll account — ISP CENTRIC", "Employee payroll details and payments.");
  const { user } = useAuth();
  const { staffId } = useParams();
  const [view, setView] = useState<PayrollAccountView | null>(null);
  const [error, setError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccountDraft);
  const [payDraft, setPayDraft] = useState<PaymentDraft>(emptyPaymentDraft);
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const isDelegate = Boolean(user?.delegate);

  useEffect(() => {
    if (isDelegate || !staffId) return;
    let stopped = false;
    setView(null);
    payrollAccount(staffId)
      .then((body) => {
        if (!stopped) setView(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "The payroll account could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate, staffId]);

  function openAccountForm() {
    const account = view?.account;
    setAccountDraft(
      account
        ? {
            employeeNo: account.employeeNo,
            baseSalary: String(account.baseSalary),
            payCycle: account.payCycle,
            payMethod: account.payMethod,
            mpesaPhone: account.mpesaPhone,
            bankName: account.bankName,
            bankBranch: account.bankBranch,
            bankAccount: account.bankAccount,
            nationalId: account.nationalId,
            kraPin: account.kraPin,
            notes: account.notes,
          }
        : { ...emptyAccountDraft, mpesaPhone: view?.staff.phone ?? "" },
    );
    setFormError("");
    setAccountOpen(true);
  }

  function openPayForm() {
    setPayDraft({
      ...emptyPaymentDraft,
      method: view?.account?.payMethod ?? "cash",
      amount: view?.account ? String(view.account.baseSalary) : "",
    });
    setFormError("");
    setPayOpen(true);
  }

  function updateAccount(field: keyof AccountDraft, value: string) {
    setAccountDraft((current) => ({ ...current, [field]: value }));
  }

  function updatePay(field: keyof PaymentDraft, value: string) {
    setPayDraft((current) => ({ ...current, [field]: value }));
  }

  async function onSaveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!staffId) return;
    const baseSalary = Number(accountDraft.baseSalary);
    if (!Number.isFinite(baseSalary) || baseSalary <= 0) {
      setFormError("Enter the employee's base salary.");
      return;
    }
    setPending(true);
    setFormError("");
    try {
      const saved = await savePayrollAccount(staffId, { ...accountDraft, baseSalary });
      setView((current) => (current ? { ...current, ...saved, transactions: current.transactions } : current));
      setAccountOpen(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The payroll details could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function onPay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!staffId) return;
    const amount = Number(payDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError("Enter the amount paid.");
      return;
    }
    setPending(true);
    setFormError("");
    try {
      setView(await addPayrollTransaction(staffId, { ...payDraft, amount }));
      setPayOpen(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The payment could not be recorded.");
    } finally {
      setPending(false);
    }
  }

  async function removeTx(tx: PayrollTransaction) {
    if (!staffId) return;
    setError("");
    setBusyId(tx.id);
    try {
      setView(await removePayrollTransaction(staffId, tx.id));
      setConfirmingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment record could not be removed.");
    } finally {
      setBusyId(null);
    }
  }

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Payroll" />
        <p className="notice">Only the account owner can manage payroll.</p>
      </div>
    );
  }

  const account = view?.account ?? null;
  const summary = view?.summary ?? null;
  const staff = view?.staff ?? null;
  const payrollTo = user ? clientPage(user, "/hr/payroll") : "/hr/payroll";

  return (
    <div className="page-shell py-8">
      <PageHeader title="Payroll account" />
      <nav className="mt-2" aria-label="Payroll">
        <Link
          to={payrollTo}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Payroll
        </Link>
      </nav>
      {!view && !error ? (
        <div className="panel mt-6 px-4 py-6" aria-hidden="true">
          <div className="grid gap-3">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-4 w-2/5" />
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="notice mt-4" role="alert">
          {error}
        </p>
      ) : null}
      {view && staff ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={staff.photoDataUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-full border border-border object-cover"
              />
              <div className="min-w-0">
                <MemberBadges entry={view} />
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {staff.title ? `${staff.title} · ` : ""}
                  {staff.phone}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton type="button" onClick={openAccountForm}>
                {account ? "Edit payroll details" : "Register payroll"}
              </SecondaryButton>
              <PrimaryButton type="button" onClick={openPayForm}>
                Record payment
              </PrimaryButton>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Base salary"
              value={account ? formatMoney(account.baseSalary) : "—"}
              detail={account ? `${payCycleLabel(account.payCycle)} · ${payMethodLabel(account.payMethod)}` : "Not registered"}
            />
            <StatCard label="Paid this month" value={formatMoney(summary?.paidMonth ?? 0)} detail="Salary and bonuses" />
            <StatCard
              label="Outstanding"
              value={formatMoney(summary?.outstanding ?? 0)}
              detail="Loans and advances to recover"
            />
            <StatCard
              label="Total paid out"
              value={formatMoney(summary?.paidOut ?? 0)}
              detail={summary && summary.deducted > 0 ? `${formatMoney(summary.deducted)} deducted` : "All time"}
            />
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <SectionCard
                title="Payroll details"
                action={
                  account ? (
                    <SecondaryButton type="button" onClick={openAccountForm}>
                      Edit
                    </SecondaryButton>
                  ) : undefined
                }
              >
                {account ? (
                  <div className="px-4 py-3">
                    <DetailGrid
                      items={[
                        { label: "Employee no", value: account.employeeNo || "—" },
                        { label: "Base salary", value: `${formatMoney(account.baseSalary)} / ${payCycleLabel(account.payCycle)}` },
                        { label: "Pay via", value: payMethodLabel(account.payMethod) },
                        ...(account.payMethod === "mpesa"
                          ? [{ label: "M-Pesa phone", value: account.mpesaPhone }]
                          : []),
                        ...(account.payMethod === "bank"
                          ? [
                              { label: "Bank", value: account.bankName },
                              { label: "Branch", value: account.bankBranch || "—" },
                              { label: "Account", value: account.bankAccount },
                            ]
                          : []),
                        { label: "National ID", value: account.nationalId || "—" },
                        { label: "KRA PIN", value: account.kraPin || "—" },
                        { label: "Notes", value: account.notes || "—" },
                      ]}
                    />
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center">
                    <Wallet className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      Register this employee's salary and payment details to start their payroll.
                    </p>
                    <PrimaryButton type="button" className="mt-4" onClick={openAccountForm}>
                      Register payroll details
                    </PrimaryButton>
                  </div>
                )}
              </SectionCard>
            </div>
            <div className="lg:col-span-3">
              <SectionCard
                title="Payments"
                action={
                  <span className="text-caption text-muted-foreground">
                    {view.transactions.length} record{view.transactions.length === 1 ? "" : "s"}
                  </span>
                }
              >
                <ul className="divide-y divide-border">
                  {view.transactions.length === 0 ? (
                    <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No payments recorded yet — record a salary payment, loan, or advance.
                    </li>
                  ) : null}
                  {view.transactions.map((tx) => (
                    <PaymentRow
                      key={tx.id}
                      tx={tx}
                      busy={busyId === tx.id}
                      confirming={confirmingId === tx.id}
                      onConfirm={() => setConfirmingId(tx.id)}
                      onRemove={() => void removeTx(tx)}
                    />
                  ))}
                </ul>
              </SectionCard>
            </div>
          </div>
        </>
      ) : null}
      <Dialog.Root open={accountOpen} onOpenChange={(next) => { if (!next && !pending) setAccountOpen(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-2xl">
            <div className="flex items-start gap-3.5">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Wallet className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
                  Payroll details{staff ? ` — ${staff.firstName} ${staff.lastName}` : ""}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                  The salary and payment details used when recording payments for this employee.
                </Dialog.Description>
              </div>
            </div>
            <form className="grid gap-5" onSubmit={onSaveAccount} noValidate>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField id="payroll-employee-no" label="Employee no.">
                  <input
                    id="payroll-employee-no"
                    className="field"
                    autoComplete="off"
                    value={accountDraft.employeeNo}
                    onChange={(event) => updateAccount("employeeNo", event.target.value)}
                  />
                </FormField>
                <FormField id="payroll-salary" label="Base salary (KES)">
                  <input
                    id="payroll-salary"
                    className="field"
                    autoComplete="off"
                    inputMode="decimal"
                    value={accountDraft.baseSalary}
                    onChange={(event) => updateAccount("baseSalary", event.target.value)}
                  />
                </FormField>
                <FormField id="payroll-cycle" label="Pay cycle">
                  <select
                    id="payroll-cycle"
                    className="field"
                    value={accountDraft.payCycle}
                    onChange={(event) => updateAccount("payCycle", event.target.value)}
                  >
                    {payCycles.map((cycle) => (
                      <option key={cycle.value} value={cycle.value}>
                        {cycle.label}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="payroll-method" label="Pay via">
                  <select
                    id="payroll-method"
                    className="field"
                    value={accountDraft.payMethod}
                    onChange={(event) => updateAccount("payMethod", event.target.value)}
                  >
                    {payMethods.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                {accountDraft.payMethod === "mpesa" ? (
                  <FormField id="payroll-mpesa" label="M-Pesa phone">
                    <input
                      id="payroll-mpesa"
                      className="field"
                      autoComplete="off"
                      inputMode="tel"
                      value={accountDraft.mpesaPhone}
                      onChange={(event) => updateAccount("mpesaPhone", event.target.value)}
                    />
                  </FormField>
                ) : null}
                {accountDraft.payMethod === "bank" ? (
                  <>
                    <FormField id="payroll-bank" label="Bank name">
                      <input
                        id="payroll-bank"
                        className="field"
                        autoComplete="off"
                        value={accountDraft.bankName}
                        onChange={(event) => updateAccount("bankName", event.target.value)}
                      />
                    </FormField>
                    <FormField id="payroll-branch" label="Branch">
                      <input
                        id="payroll-branch"
                        className="field"
                        autoComplete="off"
                        value={accountDraft.bankBranch}
                        onChange={(event) => updateAccount("bankBranch", event.target.value)}
                      />
                    </FormField>
                    <FormField id="payroll-account" label="Account number">
                      <input
                        id="payroll-account"
                        className="field"
                        autoComplete="off"
                        value={accountDraft.bankAccount}
                        onChange={(event) => updateAccount("bankAccount", event.target.value)}
                      />
                    </FormField>
                  </>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="payroll-national-id" label="National ID">
                  <input
                    id="payroll-national-id"
                    className="field"
                    autoComplete="off"
                    value={accountDraft.nationalId}
                    onChange={(event) => updateAccount("nationalId", event.target.value)}
                  />
                </FormField>
                <FormField id="payroll-kra" label="KRA PIN">
                  <input
                    id="payroll-kra"
                    className="field"
                    autoComplete="off"
                    value={accountDraft.kraPin}
                    onChange={(event) => updateAccount("kraPin", event.target.value)}
                  />
                </FormField>
              </div>
              <FormField id="payroll-notes" label="Notes">
                <textarea
                  id="payroll-notes"
                  className="field min-h-20 resize-y"
                  value={accountDraft.notes}
                  onChange={(event) => updateAccount("notes", event.target.value)}
                />
              </FormField>
              {formError ? (
                <p className="notice" role="alert">
                  {formError}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <SecondaryButton type="button" disabled={pending} onClick={() => setAccountOpen(false)}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save payroll details"}
                </PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={payOpen} onOpenChange={(next) => { if (!next && !pending) setPayOpen(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-xl">
            <div className="flex items-start gap-3.5">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Banknote className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
                  Record a payment{staff ? ` — ${staff.firstName} ${staff.lastName}` : ""}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                  {summary && summary.outstanding > 0
                    ? `${formatMoney(summary.outstanding)} in loans and advances is still outstanding.`
                    : "Salary, bonuses, loans, advances, repayments, and deductions are kept on this ledger."}
                </Dialog.Description>
              </div>
            </div>
            <form className="grid gap-5" onSubmit={onPay} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="tx-kind" label="Payment type">
                  <select
                    id="tx-kind"
                    className="field"
                    value={payDraft.kind}
                    onChange={(event) => updatePay("kind", event.target.value)}
                  >
                    {payrollKinds.map((kind) => (
                      <option key={kind.value} value={kind.value}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField id="tx-amount" label="Amount (KES)">
                  <input
                    id="tx-amount"
                    className="field"
                    autoComplete="off"
                    inputMode="decimal"
                    value={payDraft.amount}
                    onChange={(event) => updatePay("amount", event.target.value)}
                  />
                </FormField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="tx-method" label="Paid via">
                  <select
                    id="tx-method"
                    className="field"
                    value={payDraft.method}
                    onChange={(event) => updatePay("method", event.target.value)}
                  >
                    {payMethods.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                {payDraft.kind === "salary" ? (
                  <FormField id="tx-period" label="Pay period">
                    <input
                      id="tx-period"
                      type="month"
                      className="field"
                      value={payDraft.period}
                      onChange={(event) => updatePay("period", event.target.value)}
                    />
                  </FormField>
                ) : (
                  <FormField id="tx-reference" label="Reference">
                    <input
                      id="tx-reference"
                      className="field"
                      autoComplete="off"
                      placeholder="Receipt or M-Pesa code"
                      value={payDraft.reference}
                      onChange={(event) => updatePay("reference", event.target.value)}
                    />
                  </FormField>
                )}
              </div>
              {payDraft.kind === "salary" ? (
                <FormField id="tx-reference-alt" label="Reference">
                  <input
                    id="tx-reference-alt"
                    className="field"
                    autoComplete="off"
                    placeholder="Receipt or M-Pesa code"
                    value={payDraft.reference}
                    onChange={(event) => updatePay("reference", event.target.value)}
                  />
                </FormField>
              ) : null}
              <FormField id="tx-notes" label="Notes">
                <input
                  id="tx-notes"
                  className="field"
                  autoComplete="off"
                  value={payDraft.notes}
                  onChange={(event) => updatePay("notes", event.target.value)}
                />
              </FormField>
              {formError ? (
                <p className="notice" role="alert">
                  {formError}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <SecondaryButton type="button" disabled={pending} onClick={() => setPayOpen(false)}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Record payment"}
                </PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
