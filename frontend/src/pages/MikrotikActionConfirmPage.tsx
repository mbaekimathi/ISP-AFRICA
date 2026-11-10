import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Router } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type ActionSummary = {
  action: "suspend" | "delete";
  status: "pending" | "confirmed" | "cancelled" | "expired";
  deviceName: string;
  deviceSite: string;
  requester: string;
  email: string;
  expiresAt: string | null;
  confirmedAt: string | null;
};

type ConfirmResult = {
  ok: boolean;
  already?: boolean;
  action: string;
  deviceName: string;
  message: string;
};

export function MikrotikActionConfirmPage() {
  usePageMeta("Confirm MikroTik action — ISP CENTRIC", "Confirm a MikroTik suspend or delete request from email.");
  const { token = "" } = useParams();
  const [summary, setSummary] = useState<ActionSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);

  useEffect(() => {
    if (!token) {
      setError("That confirmation link is incomplete.");
      setLoading(false);
      return;
    }
    let stopped = false;
    apiRequest<ActionSummary>(`/api/public/mikrotik-action/${encodeURIComponent(token)}`)
      .then((body) => {
        if (stopped) return;
        setSummary(body);
        setError("");
      })
      .catch((cause: unknown) => {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "That confirmation link could not be opened.");
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [token]);

  async function confirm() {
    if (!token || confirming) return;
    setConfirming(true);
    setError("");
    try {
      const body = await apiRequest<ConfirmResult>(`/api/public/mikrotik-action/${encodeURIComponent(token)}/confirm`, {
        method: "POST",
        body: "{}",
      });
      setResult(body);
      setSummary((current) => (current ? { ...current, status: "confirmed" } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That confirmation could not be completed.");
    } finally {
      setConfirming(false);
    }
  }

  if (loading) {
    return <LiveLoad label="Opening confirmation" />;
  }

  const actionLabel = summary?.action === "delete" ? "delete" : "suspend";
  const done = Boolean(result) || summary?.status === "confirmed";

  return (
    <div className="min-h-screen bg-surface-muted px-4 py-10">
      <div className="mx-auto grid w-full max-w-lg gap-6">
        <div className="flex justify-center">
          <Logo className="h-8" />
        </div>
        <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden="true">
              {done ? <CheckCircle2 className="h-5 w-5" /> : <Router className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">MikroTik security</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                {done ? "Action confirmed" : `Confirm ${actionLabel}`}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {done
                  ? result?.message || "This change has already been applied."
                  : "Confirming runs the change immediately. Ignore this page if you did not request it."}
              </p>
            </div>
          </div>

          {error ? (
            <p className="notice mt-5" role="alert">
              {error}
            </p>
          ) : null}

          {summary ? (
            <dl className="mt-5 grid gap-0 text-sm">
              {[
                ["Router", summary.deviceName],
                ["Site", summary.deviceSite || "—"],
                ["Requested by", summary.requester || "—"],
                ["Action", actionLabel],
                ["Status", summary.status],
                ["Expires", summary.expiresAt || "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {!done && summary?.status === "pending" ? (
            <div className="mt-5 grid gap-3">
              <p className="inline-flex items-start gap-2 rounded-xl border border-warning-border/60 bg-warning-soft/70 px-3 py-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {summary.action === "delete"
                  ? "Deleting removes this router and disconnects its clients."
                  : "Suspending keeps the record but stops treating the router as active."}
              </p>
              <PrimaryButton type="button" disabled={confirming} onClick={() => void confirm()}>
                {confirming ? "Confirming…" : `Confirm ${actionLabel} now`}
              </PrimaryButton>
            </div>
          ) : null}

          {summary && summary.status !== "pending" && !done ? (
            <p className="mt-5 text-sm text-muted-foreground">
              This confirmation is {summary.status}. Request a new one from the Mikrotiks page if you still need the change.
            </p>
          ) : null}

          <div className="mt-6">
            <SecondaryButton to="/login">Back to sign in</SecondaryButton>
          </div>
        </section>
      </div>
    </div>
  );
}
