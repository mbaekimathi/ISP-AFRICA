import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, CalendarClock, Wallet } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import { billingLabelFor, invoiceTone, type Subscriber } from "@/pages/PppoeCustomerPage";

export function PppoeCustomerTransactionsPage() {
  const { subscriberId = "" } = useParams();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [message, setMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [payOpen, setPayOpen] = useState(search.get("pay") === "1");
  const amountRef = useRef<HTMLInputElement>(null);

  usePageMeta("Customer transactions — ISP CENTRIC", "Payments and invoices for one PPPoE client.");

  function load() {
    apiRequest<{ subscriber: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}`)
      .then((body) => {
        setSubscriber(body.subscriber);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }

  useEffect(() => {
    load();
  }, [subscriberId]);

  async function post(action: string, body: Record<string, unknown>) {
    setMessage("");
    try {
      const response = await apiRequest<{ subscriber?: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (response.subscriber) setSubscriber(response.subscriber);
      else load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    }
  }

  if (!subscriber) {
    return <div className="page-shell py-8 text-sm text-muted-foreground">{message || "Loading transactions..."}</div>;
  }

  const home = (path: string) => (user ? clientPage(user, path) : path);
  const billing = billingLabelFor(subscriber.billingStatus);
  const outstandingDue = Number(subscriber.billing.outstanding) > 0;
  const paidAmount = Number(amount);
  const packagePrice = Number(subscriber.billing.price);
  const purchasedDays = packagePrice > 0 && paidAmount > 0 ? Math.floor((paidAmount * subscriber.billing.cycleDays) / packagePrice) : 0;
  const anchor = subscriber.billing.expiry && subscriber.billing.expiry > new Date().toISOString().slice(0, 10) ? subscriber.billing.expiry : new Date().toISOString().slice(0, 10);
  const newExpiry = purchasedDays > 0 ? new Date(`${anchor}T00:00:00`) : null;
  if (newExpiry) newExpiry.setDate(newExpiry.getDate() + purchasedDays + subscriber.billing.graceDays);

  const ledger = [
    ...subscriber.billing.invoices.map((invoice) => ({
      id: `inv-${invoice.id}`,
      createdAt: invoice.createdAt,
      label: invoice.purpose ? invoice.purpose.charAt(0).toUpperCase() + invoice.purpose.slice(1) : "Invoice",
      amount: `KSh ${invoice.amount}`,
      badge: <StatusBadge tone={invoiceTone(invoice.status)}>{invoice.status}</StatusBadge>,
      payment: false,
      reference: invoice.reference,
    })),
    ...subscriber.billing.payments.map((payment) => ({
      id: `pay-${payment.id}`,
      createdAt: payment.createdAt,
      label: `Payment · ${payment.method}`,
      amount: `KSh ${payment.amount}`,
      badge: null,
      payment: true,
      reference: payment.reference,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="page-shell py-8">
      <SecondaryButton to={home(`/pppoe/${subscriberId}`)}>
        <ArrowLeft className="h-4 w-4" />
        Back to customer
      </SecondaryButton>

      <section className="mt-4 rounded-2xl border border-border bg-surface shadow-card">
        <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {subscriber.firstName} {subscriber.lastName}
              </h1>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {subscriber.phone} · {subscriber.username} · {subscriber.packageName}
              </p>
            </div>
            <PrimaryButton
              type="button"
              onClick={() => {
                setPayOpen(true);
                window.setTimeout(() => amountRef.current?.focus(), 50);
              }}
            >
              Record payment
            </PrimaryButton>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusBadge tone={billing.tone}>{billing.label}</StatusBadge>
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              {outstandingDue ? `KSh ${subscriber.billing.outstanding} outstanding` : "Nothing outstanding"}
            </span>
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              Access expires {subscriber.billing.expiry ?? "—"}
            </span>
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-border bg-surface p-5 shadow-card sm:px-6">
        <h2 className="text-sm font-semibold">Transactions</h2>
        {ledger.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No invoices or payments yet.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {ledger.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2">
                <span>
                  <span className="block font-medium">{entry.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {entry.createdAt}
                    {entry.reference ? ` · Ref ${entry.reference}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={entry.payment ? "font-medium text-success" : "font-medium"}>{entry.amount}</span>
                  {entry.badge}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {message ? <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">{message}</p> : null}

      <Dialog.Root open={payOpen} onOpenChange={setPayOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <div>
              <Dialog.Title className="text-base font-semibold text-foreground">Record payment</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                Extend access for {subscriber.firstName} {subscriber.lastName} or send an M-Pesa prompt to their phone.
              </Dialog.Description>
            </div>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void post("renew", { amount, mpesaReference: reference }).then(() => setPayOpen(false));
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
              <div className="flex flex-wrap justify-end gap-2">
                <SecondaryButton type="button" onClick={() => setPayOpen(false)}>Cancel</SecondaryButton>
                <SecondaryButton type="button" onClick={() => void post("payment", { amount, method: "stk" })}>Send STK push</SecondaryButton>
                <PrimaryButton type="submit">Record payment</PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
