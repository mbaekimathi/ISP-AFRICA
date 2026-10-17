import { useEffect, useState } from "react";
import { ReviewGate } from "@/components/auth/ReviewGate";
import { PrimaryButton } from "@/components/ui/Buttons";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { listAccountsForReview, type PublicAccount } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

export function ReviewsPage() {
  usePageMeta("Account reviews — ISP CENTRIC", "Approve pending ISP CENTRIC client accounts.");
  const { approve } = useAuth();
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");

  const pending = accounts.filter((account) => account.status !== "approved");
  const approved = accounts.filter((account) => account.status === "approved");

  useEffect(() => {
    listAccountsForReview()
      .then(setAccounts)
      .catch((error: unknown) => {
        setMessageTone("error");
        setMessage(error instanceof Error ? error.message : "Could not load accounts.");
      });
  }, []);

  async function onApprove(id: string) {
    try {
      await approve(id);
      setAccounts(await listAccountsForReview());
      setMessageTone("success");
      setMessage("Account approved. That client can now open their unique ISP account.");
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "Could not approve that account.");
    }
  }

  return (
    <div className="page-shell py-8">
      <ReviewGate>
      <div className="grid gap-8">
        <PageHeader
          title="Account approval"
          description="New ISP client accounts stay pending until a Director approves them. Approval is saved in ISP-DB."
        />
        {message ? (
          <p
            className={`rounded-xl border px-4 py-3 text-sm text-foreground ${messageTone === "error" ? "border-warning/40 bg-warning/10" : "border-success/30 bg-success/10"}`}
            role="status"
          >
            {message}
          </p>
        ) : null}
        <section className="grid gap-4" aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="text-xl font-semibold">
            Pending
          </h2>
          {pending.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface p-5 text-sm text-muted-foreground">No accounts are waiting.</p>
          ) : (
            pending.map((account) => (
              <article key={account.id} className="rounded-xl border border-border bg-surface p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <img src={account.photoDataUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">
                        {account.firstName} {account.lastName}
                      </h3>
                      <StatusBadge tone="due">Pending</StatusBadge>
                    </div>
                  </div>
                  <PrimaryButton type="button" onClick={() => onApprove(account.id)}>
                    Approve
                  </PrimaryButton>
                </div>
                <div className="mt-3">
                  <DetailGrid
                    items={[
                      { label: "Username", value: account.username },
                      { label: "Email", value: account.email },
                      { label: "Phone", value: account.phone },
                      { label: "Login code", value: account.loginCode },
                    ]}
                  />
                </div>
              </article>
            ))
          )}
        </section>
        <section className="grid gap-3" aria-labelledby="approved-heading">
          <h2 id="approved-heading" className="text-xl font-semibold">
            Approved
          </h2>
          {approved.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved client accounts yet.</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {approved.map((account) => (
                <li key={account.id} className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-4 px-5 py-3 text-sm">
                  <span className="truncate font-medium text-foreground">
                    {account.firstName} {account.lastName}
                  </span>
                  <span className="truncate text-right font-medium tabular-nums text-muted-foreground">{account.clientCode}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      </ReviewGate>
    </div>
  );
}
