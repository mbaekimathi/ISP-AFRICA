import { Check, Landmark, Loader2, LockKeyhole, Receipt, Smartphone, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage } from "@/lib/accounts";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type GatewayMode = "none" | "own_daraja" | "company_gateway";

type PayoutSettings = {
  gateway_mode: GatewayMode;
};

type GatewayFees = {
  configured: boolean;
  commissionPercent?: string;
  commissionFlat?: string;
  payoutFeeEstimate?: string;
  minPayout?: string;
  maxPayoutPerTx?: string;
  txnFeesEnabled?: boolean;
  bands?: { id: string; min: string; max: string | null; fee: string }[];
};

function kes(value: string | number | null | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    minimumFractionDigits: 0,
  }).format(amount);
}

type PaymentDraft = {
  environment: "" | "sandbox" | "live";
  accountType: "" | "paybill" | "till";
  shortCode: string;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  callbackUrl: string;
  confirmationUrl: string;
  validationUrl: string;
  initiatorName: string;
  securityCredential: string;
};

type PaymentRecord = {
  environment: "sandbox" | "live";
  accountType: "paybill" | "till";
  shortCode: string;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  callbackUrl: string;
  confirmationUrl: string;
  validationUrl: string;
  initiatorName: string;
  securityCredential: string;
  updatedAt: string | null;
};

type ConnectionCheck = { state: "idle" | "checking" | "ok" | "failed"; reason: string };

type C2bCheck = { key: string; label: string; ok: boolean; detail: string };

type C2bActivity = {
  id: string;
  receipt: string | null;
  accountReference: string;
  amount: string;
  status: string;
  reason: string;
  createdAt: string;
};

type C2bHealth = {
  optional: boolean;
  enabled: boolean;
  ready: boolean;
  checks: C2bCheck[];
  confirmationUrl: string;
  validationUrl: string;
  registration: {
    registeredAt: string | null;
    ok: boolean;
    detail: string;
    accountType: string;
    shortCode: string;
  };
  counts: { matched: number; unmatched: number };
  recent: C2bActivity[];
};

type PaymentSettings = {
  mode: "own" | "company" | null;
  own: PaymentRecord | null;
  company: PaymentRecord | null;
  c2b?: C2bHealth;
};

const emptyDraft: PaymentDraft = {
  environment: "",
  accountType: "",
  shortCode: "",
  consumerKey: "",
  consumerSecret: "",
  passkey: "",
  callbackUrl: "",
  confirmationUrl: "",
  validationUrl: "",
  initiatorName: "",
  securityCredential: "",
};

function draftFrom(record: PaymentRecord | null): PaymentDraft {
  if (!record) return emptyDraft;
  return {
    environment: record.environment,
    accountType: record.accountType,
    shortCode: record.shortCode,
    consumerKey: "",
    consumerSecret: "",
    passkey: "",
    callbackUrl: record.callbackUrl,
    confirmationUrl: record.confirmationUrl,
    validationUrl: record.validationUrl,
    initiatorName: record.initiatorName,
    securityCredential: "",
  };
}

export function IspPaymentsPage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP PAYMENTS SETTINGS — ISP CENTRIC", "Use your Daraja API or let the company collect for you.");
  const [draft, setDraft] = useState<PaymentDraft>(emptyDraft);
  const [record, setRecord] = useState<PaymentRecord | null>(null);
  const [check, setCheck] = useState<ConnectionCheck>({ state: "idle", reason: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"own" | "company">("own");
  const [gatewayMode, setGatewayMode] = useState<GatewayMode>("none");
  const [c2b, setC2b] = useState<C2bHealth | null>(null);
  const [c2bBusy, setC2bBusy] = useState(false);

  const testConnection = useCallback((form?: PaymentDraft) => {
    setCheck({ state: "checking", reason: "" });
    apiRequest<{ test: { connected: boolean; reason: string } }>("/api/payments/test", {
      method: "POST",
      body: JSON.stringify(
        form
          ? {
              mode: "own",
              own: {
                environment: form.environment,
                consumerKey: form.consumerKey,
                consumerSecret: form.consumerSecret,
              },
            }
          : { mode: "own" },
      ),
    })
      .then((body) => {
        setCheck(
          body.test.connected
            ? { state: "ok", reason: "" }
            : { state: "failed", reason: body.test.reason },
        );
      })
      .catch((cause: unknown) => {
        setCheck({
          state: "failed",
          reason: cause instanceof ApiRequestError ? cause.message : "The connection test could not be completed.",
        });
      });
  }, []);

  const apply = useCallback(
    (body: PaymentSettings) => {
      setRecord(body.own);
      setDraft(draftFrom(body.own));
      setC2b(body.c2b ?? null);
      setLoaded(true);
      if (body.own) testConnection();
    },
    [testConnection],
  );

  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    apiRequest<PaymentSettings>("/api/payments")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Payment settings could not be loaded.");
        }
      });
    apiRequest<{ settings: PayoutSettings }>("/api/gateway/settings")
      .then((body) => {
        if (stopped || !body.settings) return;
        setGatewayMode(body.settings.gateway_mode);
        if (body.settings.gateway_mode === "company_gateway") setView("company");
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [apply, userId]);

  function update(field: keyof PaymentDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function refreshC2b() {
    apiRequest<{ c2b: C2bHealth }>("/api/payments/c2b")
      .then((body) => setC2b(body.c2b))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Manual Paybill status could not be loaded."),
      );
  }

  function setC2bEnabled(enabled: boolean) {
    setError("");
    setNotice("");
    setC2bBusy(true);
    apiRequest<{ c2b: C2bHealth }>("/api/payments/c2b", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
      .then((body) => {
        setC2b(body.c2b);
        setNotice(
          enabled
            ? "Manual Paybill auto-credit is on — register the C2B URLs with Safaricom next."
            : "Manual Paybill auto-credit is off.",
        );
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not update manual Paybill settings.");
      })
      .finally(() => setC2bBusy(false));
  }

  function registerC2b() {
    setError("");
    setNotice("");
    setC2bBusy(true);
    apiRequest<{ c2b: C2bHealth }>("/api/payments/c2b/register", { method: "POST", body: "{}" })
      .then((body) => {
        setC2b(body.c2b);
        setNotice("C2B URLs registered on your Paybill — manual payments can now renew lines automatically.");
        if (body.c2b.confirmationUrl) {
          setDraft((current) => ({
            ...current,
            confirmationUrl: body.c2b.confirmationUrl,
            validationUrl: body.c2b.validationUrl,
          }));
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "C2B registration failed.");
        refreshC2b();
      })
      .finally(() => setC2bBusy(false));
  }

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.status !== "approved") {
    return <Navigate to="/account" replace />;
  }

  const statusDot =
    check.state === "ok" ? "bg-success" : check.state === "failed" ? "bg-destructive" : "bg-muted-foreground";
  const statusText =
    check.state === "checking"
      ? "Checking the connection…"
      : check.state === "ok"
        ? `Connected — Daraja accepted the ${record?.environment ?? ""} credentials.`
        : check.state === "failed"
          ? `Not connected — ${check.reason}`
          : record
            ? "Connection not tested yet."
            : "Save the details, then test the connection.";

  function savedHint(value: string) {
    return value ? `Saved: ${value} — type to replace` : undefined;
  }

  const pooled = gatewayMode === "company_gateway";
  const activeView = pooled ? "company" : "own";

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Payments"
        description="Collect payments with this account's own Daraja API, or opt in to the company gateway below. Saved secrets stay hidden and are kept when you leave those fields unchanged."
      />
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}
      <fieldset className="mt-6 grid max-w-2xl gap-3">
        <legend className="text-sm font-medium text-foreground">How do you want to collect payments?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            {
              id: "own",
              title: "My Daraja API",
              detail: "Collect directly to your own paybill or till.",
              icon: <Smartphone className="h-5 w-5" aria-hidden="true" />,
            },
            {
              id: "company",
              title: "Company gateway",
              detail: "The company collects for you and pays out to your destination.",
              icon: <Landmark className="h-5 w-5" aria-hidden="true" />,
            },
          ] as const).map((option) => {
            const selected = view === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setView(option.id)}
                aria-pressed={selected}
                className={cn(
                  "relative grid gap-2 rounded-2xl border p-4 text-left transition-all duration-fast ease-out",
                  selected
                    ? "border-primary bg-primary/5 shadow-glow-sm ring-1 ring-primary/30"
                    : "border-border bg-surface hover:-translate-y-0.5 hover:border-input hover:shadow-card",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
                      selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
                    )}
                  >
                    {option.icon}
                  </span>
                  {selected ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2 font-semibold">
                  {option.title}
                  {activeView === option.id ? (
                    <span className="rounded-full border border-success-border/60 bg-success-soft/70 px-2 py-0.5 text-caption font-semibold text-success">
                      Active
                    </span>
                  ) : null}
                </span>
                <span className="text-sm text-muted-foreground">{option.detail}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      {view === "own" ? (
      <>
      <form
        className="form-card mt-6 max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          apiRequest<PaymentSettings>("/api/payments", {
            method: "POST",
            body: JSON.stringify({ mode: "own", own: draft }),
          })
            .then((body) => {
              apply(body);
              setError("");
              setNotice("Saved — payments now use this account's Daraja API.");
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Payment settings could not be saved.");
            })
            .finally(() => setPending(false));
        }}
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Smartphone className="h-5 w-5" />
              </span>
              <div className="grid gap-0.5">
                <h2 className="text-lg font-semibold">Your Daraja API</h2>
                <p className="text-sm text-muted-foreground">Collect directly to your own paybill or till.</p>
              </div>
            </div>
            <div className="grid gap-1 justify-items-end">
              <p
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold",
                  check.state === "ok"
                    ? "border-success-border/60 bg-success-soft/70 text-success"
                    : check.state === "failed"
                      ? "border-destructive-border/60 bg-destructive-soft/60 text-destructive"
                      : "border-border bg-surface-muted/60 text-muted-foreground",
                )}
                role="status"
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", statusDot)} aria-hidden="true" />
                {check.state === "ok"
                  ? "Connected"
                  : check.state === "failed"
                    ? "Not connected"
                    : check.state === "checking"
                      ? "Checking…"
                      : "Not tested"}
              </p>
              {record?.updatedAt ? (
                <p className="text-xs text-muted-foreground">Last saved {record.updatedAt}</p>
              ) : null}
            </div>
          </div>
          {pooled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info-border/60 bg-info-soft/50 px-4 py-3">
              <p className="text-sm text-foreground">
                The company gateway is collecting payments — these credentials stay saved but are not
                in use until you switch back.
              </p>
              <SecondaryButton type="button" onClick={() => setView("company")}>
                Manage the company gateway
              </SecondaryButton>
            </div>
          ) : null}
          <fieldset className="grid gap-4" disabled={pooled}>
          {check.state !== "idle" && check.state !== "ok" ? (
            <p className="text-sm text-muted-foreground">{statusText}</p>
          ) : null}
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold text-foreground">M-Pesa collections</h3>
            <p className="text-sm text-muted-foreground">Credentials from your Daraja app.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="daraja-environment" label="Environment">
              <select
                id="daraja-environment"
                className="field"
                value={draft.environment}
                onChange={(event) => update("environment", event.target.value)}
              >
                <option value="">Choose environment</option>
                <option value="sandbox">Sandbox</option>
                <option value="live">Live</option>
              </select>
            </FormField>
            <FormField id="daraja-account-type" label="Account type">
              <select
                id="daraja-account-type"
                className="field"
                value={draft.accountType}
                onChange={(event) => update("accountType", event.target.value)}
              >
                <option value="">Choose account type</option>
                <option value="paybill">Paybill</option>
                <option value="till">Till</option>
              </select>
            </FormField>
            <FormField id="daraja-short-code" label="Business short code">
              <input
                id="daraja-short-code"
                className="field"
                inputMode="numeric"
                maxLength={10}
                value={draft.shortCode}
                onChange={(event) => update("shortCode", event.target.value.replace(/\D/g, "").slice(0, 10))}
              />
            </FormField>
            <FormField id="daraja-consumer-key" label="Consumer key" hint={savedHint(record?.consumerKey ?? "")}>
              <input
                id="daraja-consumer-key"
                className="field"
                autoComplete="off"
                value={draft.consumerKey}
                onChange={(event) => update("consumerKey", event.target.value)}
              />
            </FormField>
            <FormField
              id="daraja-consumer-secret"
              label="Consumer secret"
              hint={savedHint(record?.consumerSecret ?? "")}
            >
              <input
                id="daraja-consumer-secret"
                type="password"
                className="field"
                autoComplete="new-password"
                value={draft.consumerSecret}
                onChange={(event) => update("consumerSecret", event.target.value)}
              />
            </FormField>
            <FormField id="daraja-passkey" label="Passkey" hint={savedHint(record?.passkey ?? "")}>
              <input
                id="daraja-passkey"
                type="password"
                className="field"
                autoComplete="new-password"
                value={draft.passkey}
                onChange={(event) => update("passkey", event.target.value)}
              />
            </FormField>
          </div>
          <div className="grid gap-4 rounded-xl border border-border/70 bg-surface-muted/40 p-4">
            <div className="grid gap-1">
              <h3 className="text-sm font-semibold text-foreground">Payment URLs &amp; security</h3>
              <p className="text-sm text-muted-foreground">
                Optional — STK callback and initiator credentials. Manual Paybill confirmation/validation URLs are
                managed in the optional auto-credit panel below when you turn that on.
              </p>
            </div>
            <FormField
              id="daraja-callback-url"
              label="Callback URL"
              hint="Where Daraja posts STK push results — set it to https://<your-domain>/api/daraja/callback so the real M-Pesa code is saved."
            >
              <input
                id="daraja-callback-url"
                className="field"
                inputMode="url"
                placeholder="https://portal.example.com/api/daraja/callback"
                value={draft.callbackUrl}
                onChange={(event) => update("callbackUrl", event.target.value)}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                id="daraja-initiator-name"
                label="Initiator name"
                hint="The Daraja user allowed to send payouts or reversals."
              >
                <input
                  id="daraja-initiator-name"
                  className="field"
                  autoComplete="off"
                  value={draft.initiatorName}
                  onChange={(event) => update("initiatorName", event.target.value)}
                />
              </FormField>
              <FormField
                id="daraja-security-credential"
                label="Security credential"
                hint={savedHint(record?.securityCredential ?? "") ?? "The encrypted initiator credential."}
              >
                <input
                  id="daraja-security-credential"
                  type="password"
                  className="field"
                  autoComplete="new-password"
                  value={draft.securityCredential}
                  onChange={(event) => update("securityCredential", event.target.value)}
                />
              </FormField>
            </div>
          </div>
          <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/90 px-4 py-3 shadow-card backdrop-blur-md sm:-mx-1">
            <PrimaryButton type="submit" disabled={pending || !loaded}>
              Save my Daraja API
            </PrimaryButton>
            <SecondaryButton
              type="button"
              disabled={pending || check.state === "checking"}
              onClick={() => testConnection(draft)}
            >
              Test connection
            </SecondaryButton>
          </div>
          </fieldset>
        </div>
      </form>
      {view === "own" ? (
        <section className="form-card mt-6 max-w-2xl">
          <h2 className="text-lg font-semibold">Manual Paybill recognition (optional)</h2>
          <p className="text-sm text-muted-foreground">
            Off by default. Turn this on if customers pay your Paybill without STK and enter their PPPoE username as
            the account number — the system will match and renew the line automatically.
          </p>
          {c2b ? (
            <>
              <label className="flex items-start gap-3 rounded-lg border border-border bg-surface-muted/40 px-3.5 py-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={c2b.enabled}
                  disabled={c2bBusy || gatewayMode === "company_gateway"}
                  onChange={(event) => setC2bEnabled(event.target.checked)}
                />
                <span>
                  <span className="font-medium">Auto-credit manual Paybill payments</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">
                    Only applies while this account uses your own Daraja API — not the company gateway.
                  </span>
                </span>
              </label>
              {c2b.enabled ? (
                <>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className={`h-2 w-2 rounded-full ${c2b.ready ? "bg-success" : "bg-destructive"}`} />
                    {c2b.ready
                      ? "Ready — matched payments renew the line automatically."
                      : "Not ready yet — fix the items below, then register the C2B URLs."}
                  </p>
                  <ul className="grid gap-1.5 rounded-lg border border-border bg-surface-muted/60 px-3.5 py-3">
                    {c2b.checks.map((item) => (
                      <li key={item.key} className="grid gap-0.5">
                        <div className="flex items-center gap-2 text-caption">
                          {item.ok ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                          )}
                          <span className={item.ok ? "text-muted-foreground" : "font-medium"}>{item.label}</span>
                        </div>
                        <p className="pl-5 text-[11px] leading-4 text-muted-foreground">{item.detail}</p>
                      </li>
                    ))}
                  </ul>
                  {c2b.confirmationUrl ? (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      Confirmation: {c2b.confirmationUrl}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <PrimaryButton
                      type="button"
                      disabled={
                        c2bBusy || !c2b.confirmationUrl || c2b.registration.accountType !== "paybill"
                      }
                      onClick={registerC2b}
                    >
                      {c2bBusy ? "Working…" : c2b.registration.ok ? "Re-register C2B URLs" : "Register C2B URLs"}
                    </PrimaryButton>
                    <SecondaryButton type="button" disabled={c2bBusy} onClick={refreshC2b}>
                      Refresh status
                    </SecondaryButton>
                  </div>
                  <div className="grid gap-2">
                    <h3 className="text-sm font-semibold">Recent manual payments</h3>
                    <p className="text-caption text-muted-foreground">
                      Matched {c2b.counts.matched} · Unmatched {c2b.counts.unmatched}
                    </p>
                    {c2b.recent.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No C2B receipts yet. After registration, a manual payment with the PPPoE username as account
                        number should appear here.
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-border">
                        <table className="w-full text-left text-sm">
                          <thead className="border-b border-border bg-surface-muted/50 text-caption text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2 font-medium">When</th>
                              <th className="px-3 py-2 font-medium">Receipt</th>
                              <th className="px-3 py-2 font-medium">Account</th>
                              <th className="px-3 py-2 font-medium">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {c2b.recent.map((row) => (
                              <tr key={row.id} className="border-b border-border last:border-0">
                                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                                  {row.createdAt}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">{row.receipt || "—"}</td>
                                <td className="px-3 py-2 font-mono text-xs">{row.accountReference || "—"}</td>
                                <td className="px-3 py-2">
                                  <div className={row.status === "confirmed" ? "text-success" : "text-destructive"}>
                                    {row.status === "confirmed" ? "Matched" : "Unmatched"}
                                  </div>
                                  <div className="text-[11px] leading-4 text-muted-foreground">{row.reason}</div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Save your Daraja details first to configure this option.</p>
          )}
        </section>
      </>
      ) : (
        <GatewaySettingsCard
          onModeChange={(mode) => {
            setGatewayMode(mode);
            setView(mode === "company_gateway" ? "company" : "own");
          }}
        />
      )}
    </div>
  );
}

function GatewaySettingsCard({ onModeChange }: { onModeChange?: (mode: GatewayMode) => void }) {
  const { user } = useAuth();
  const gatewayBillingsTo = user ? clientPage(user, "/billings/gateway") : "/billings/gateway";
  const [settings, setSettings] = useState<PayoutSettings | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [checkState, setCheckState] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const [checks, setChecks] = useState<{ key: string; ok: boolean; detail: string }[]>([]);
  const [fees, setFees] = useState<GatewayFees | null>(null);

  const apply = useCallback((body: { settings: PayoutSettings; readOnly: boolean }) => {
    setSettings(body.settings);
    setReadOnly(body.readOnly);
    if (body.readOnly) setUnlocked(true);
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
          onModeChange?.(result.settings.gateway_mode);
        }
        setNotice(
          result.outcome === "destination-pending"
            ? "Saved — the new payout destination applies after the 24-hour review window."
            : result.outcome === "destination-set"
              ? "Saved — the payout destination is set."
              : "Saved.",
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Gateway settings could not be saved."))
      .finally(() => setPending(false));
  }

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

  function runCheck(thenOptIn: boolean) {
    setError("");
    setCheckState("checking");
    apiRequest<{ ok: boolean; checks: { key: string; ok: boolean; detail: string }[] }>(
      "/api/gateway/settings/check",
    )
      .then((body) => {
        setChecks(body.checks);
        setCheckState(body.ok ? "ok" : "failed");
        if (body.ok && thenOptIn) save({ gatewayMode: "company_gateway" });
      })
      .catch((cause: unknown) => {
        setCheckState("failed");
        setError(cause instanceof Error ? cause.message : "The gateway check could not be completed.");
      });
  }

  if (!loaded) return null;
  const pooled = settings?.gateway_mode === "company_gateway";

  const feeRows: [string, string][] = [];
  if (fees?.configured) {
    const flat = Number(fees.commissionFlat || 0);
    feeRows.push([
      "Company commission",
      `${fees.commissionPercent || "0"}%${flat ? ` + ${kes(flat)}` : ""} of each payout`,
    ]);
    if (Number(fees.payoutFeeEstimate) > 0) {
      feeRows.push(["Payout fee", `about ${kes(fees.payoutFeeEstimate)} per M-Pesa transaction`]);
    }
    if (Number(fees.minPayout) > 0) {
      feeRows.push(["Smallest payout", kes(fees.minPayout)]);
    }
    if (Number(fees.maxPayoutPerTx) > 0) {
      feeRows.push(["Largest single payout", kes(fees.maxPayoutPerTx)]);
    }
  }

  return (
    <section className="form-card mt-6 max-w-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              pooled ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
            )}
            aria-hidden="true"
          >
            <Landmark className="h-5 w-5" />
          </span>
          <div className="grid gap-0.5">
            <h2 className="text-lg font-semibold">Company gateway</h2>
            <p className="text-sm text-muted-foreground">
              The company collects on its M-Pesa shortcode and pays you out. Manual Paybill payments with the
              PPPoE username as account number are recognised by the company gateway automatically.
            </p>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold",
            pooled
              ? "border-success-border/60 bg-success-soft/70 text-success"
              : "border-border bg-surface-muted/60 text-muted-foreground",
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", pooled ? "bg-success" : "bg-muted-foreground")}
            aria-hidden="true"
          />
          {pooled ? "Active" : "Not connected"}
        </span>
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
                Enter your password to change how this account collects payments.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-52 flex-1">
              <FormField id="gw-password" label="Account password">
                <input
                  id="gw-password"
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
        {fees?.configured ? (
          <div className="grid gap-3 rounded-xl border border-border bg-surface-muted/40 p-4">
            <div className="flex items-center gap-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Receipt className="h-4 w-4" />
              </span>
              <div className="grid gap-0.5">
                <h3 className="text-sm font-semibold text-foreground">What the company gateway costs</h3>
                <p className="text-sm text-muted-foreground">
                  Deducted from your pooled collections before each payout.
                </p>
              </div>
            </div>
            <dl className="grid gap-1.5 text-sm">
              {feeRows.map(([label, value]) => (
                <div key={label} className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            {fees.txnFeesEnabled && fees.bands?.length ? (
              <div className="grid gap-1.5">
                <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  Transaction charge per payout
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    {fees.bands.map((band) => (
                      <tr key={band.id} className="border-t border-border/60 first:border-0">
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {band.max
                            ? `${kes(band.min)} – ${kes(band.max)}`
                            : `${kes(band.min)} and above`}
                        </td>
                        <td className="py-1.5 text-right font-medium text-foreground">
                          {kes(band.fee)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          className={cn(
            "grid gap-3 rounded-xl border p-4",
            pooled ? "border-success-border/60 bg-success-soft/50" : "border-border bg-surface-muted/40",
          )}
        >
          {pooled ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                Collections are pooled through the company shortcode.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <SecondaryButton
                  type="button"
                  disabled={readOnly || pending || checkState === "checking"}
                  onClick={() => runCheck(false)}
                >
                  {checkState === "checking" ? "Checking…" : "Test connection"}
                </SecondaryButton>
                <SecondaryButton
                  type="button"
                  disabled={readOnly || pending || !password}
                  onClick={() => save({ gatewayMode: "own_daraja" })}
                >
                  Switch back to my Daraja
                </SecondaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Check the connection — if everything is set up you're opted in automatically and
                subscribers start paying the company shortcode.
              </p>
              <PrimaryButton
                type="button"
                disabled={readOnly || pending || !password || checkState === "checking"}
                onClick={() => runCheck(true)}
              >
                {checkState === "checking" ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Checking…
                  </span>
                ) : (
                  "Check connection & opt in"
                )}
              </PrimaryButton>
            </div>
          )}
          {checks.length ? (
            <ul className="grid gap-1.5">
              {checks.map((check) => (
                <li key={check.key} className="flex items-start gap-2 text-sm">
                  {check.ok ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  )}
                  <span className={check.ok ? "text-foreground" : "text-destructive"}>
                    {check.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {pooled ? (
          <p className="rounded-xl border border-border bg-surface-muted/40 px-4 py-3 text-sm text-muted-foreground">
            Change payout destination and frequency under{" "}
            <Link className="font-medium text-primary underline-offset-2 hover:underline" to={gatewayBillingsTo}>
              Gateway billings → Gateway settings
            </Link>
            .
          </p>
        ) : null}
      </div>
      )}
    </section>
  );
}
