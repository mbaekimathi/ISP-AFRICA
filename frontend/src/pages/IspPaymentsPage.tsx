import { Check, Landmark, Loader2, LockKeyhole, Plus, Receipt, Send, Smartphone, Timer, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type GatewayMode = "none" | "own_daraja" | "company_gateway";

type SettlementMode = "immediate" | "delayed" | "transactions" | "scheduled";

type PayoutSettings = {
  gateway_mode: GatewayMode;
  settlement_mode: SettlementMode;
  hold_hours: number;
  settle_every_n_tx: number | null;
  settle_schedule: { day: string; time: string }[] | null;
  last_settled_at: string | null;
  destination_type: "phone" | "paybill" | "till" | null;
  destination_value: string;
  account_reference: string;
  min_payout_override: string | null;
  pending_change: string | null;
  pending_change_effective_at: string | null;
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

type PaymentSettings = {
  mode: "own" | "company" | null;
  own: PaymentRecord | null;
  company: PaymentRecord | null;
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
                Optional — the callback URL receives STK push results, the confirmation and validation URLs receive
                manual M-Pesa payments, and the initiator credentials are used for payouts and reversals.
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
                id="daraja-confirmation-url"
                label="Confirmation URL"
                hint="Receives completed Paybill or Till payments made directly."
              >
                <input
                  id="daraja-confirmation-url"
                  className="field"
                  inputMode="url"
                  placeholder="https://portal.example.com/c2b/confirmation"
                  value={draft.confirmationUrl}
                  onChange={(event) => update("confirmationUrl", event.target.value)}
                />
              </FormField>
              <FormField
                id="daraja-validation-url"
                label="Validation URL"
                hint="Optional — checks a payment before it is accepted."
              >
                <input
                  id="daraja-validation-url"
                  className="field"
                  inputMode="url"
                  placeholder="https://portal.example.com/c2b/validation"
                  value={draft.validationUrl}
                  onChange={(event) => update("validationUrl", event.target.value)}
                />
              </FormField>
            </div>
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
  const [settings, setSettings] = useState<PayoutSettings | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [destinationValue, setDestinationValue] = useState("");
  const [shortcodeKind, setShortcodeKind] = useState<"paybill" | "till" | "">("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [checkState, setCheckState] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const [checks, setChecks] = useState<{ key: string; ok: boolean; detail: string }[]>([]);
  const [fees, setFees] = useState<GatewayFees | null>(null);
  const [settleMode, setSettleMode] = useState<SettlementMode>("immediate");
  const [holdHours, setHoldHours] = useState("");
  const [everyNTx, setEveryNTx] = useState("");
  const [periods, setPeriods] = useState<{ day: string; time: string }[]>([]);
  const [minPayout, setMinPayout] = useState("");

  const apply = useCallback((body: { settings: PayoutSettings; readOnly: boolean }) => {
    setSettings(body.settings);
    setReadOnly(body.readOnly);
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
        setPassword("");
        setDestinationValue("");
        setShortcodeKind("");
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
  const pendingChange = settings?.pending_change
    ? (() => {
        try {
          return JSON.parse(settings.pending_change as string) as { destination_type?: string; destination_value?: string };
        } catch {
          return null;
        }
      })()
    : null;

  const destinationDigits = destinationValue.replace(/\D/g, "");
  const detectedPhone = /^(?:254[17]\d{8}|0[17]\d{8}|[17]\d{8})$/.test(destinationDigits);
  const needsShortcodeKind = Boolean(destinationDigits) && !detectedPhone;

  const completePeriods = periods.filter((period) => period.day && period.time);
  const needsEveryNTx = settleMode === "transactions" && !(Number(everyNTx) >= 1);
  const needsPeriod = settleMode === "scheduled" && !completePeriods.length;

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
              The company collects on its M-Pesa shortcode and pays you out.
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
      {pendingChange ? (
        <p className="notice mt-4" role="status">
          Destination change to {pendingChange.destination_type} {pendingChange.destination_value ?? ""}{" "}
          applies at {settings?.pending_change_effective_at}. Contact the company before then to stop it.
        </p>
      ) : null}

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
                Enter your account password below, then check the connection — if everything is set up
                you're opted in automatically and subscribers start paying the company shortcode.
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
          <div className="grid gap-4 border-t border-border pt-4">
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
              id="gw-destination"
              label="Phone, paybill, or till number"
              hint="Enter your M-Pesa phone number, paybill, or till — payouts go there automatically. Leave empty to keep the current destination."
            >
              <input
                id="gw-destination"
                className="field"
                inputMode="tel"
                placeholder="e.g. 0712 345 678 or 654321"
                value={destinationValue}
                disabled={readOnly || pending}
                onChange={(event) => setDestinationValue(event.target.value)}
              />
            </FormField>
            {needsShortcodeKind ? (
              <FormField id="gw-shortcode-kind" label="That number is a">
                <select
                  id="gw-shortcode-kind"
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
        ) : null}

        {pooled ? (
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
              <FormField id="gw-settle-mode" label="Payout frequency">
                <select
                  id="gw-settle-mode"
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
                  id="gw-hold-hours"
                  label="Hold collections for"
                  hint="Each payment becomes payable this many hours after it confirms (1–720)."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="gw-hold-hours"
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
                  id="gw-every-n"
                  label="Pay out after every"
                  hint="A payout runs once this many payments have been collected (1–10,000)."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="gw-every-n"
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
                id="gw-min-payout"
                label="Minimum payout amount"
                hint="Optional — wait until at least this much is due. Leave empty for the company minimum."
              >
                <input
                  id="gw-min-payout"
                  className="field"
                  inputMode="decimal"
                  placeholder={
                    fees?.minPayout && Number(fees.minPayout) > 0
                      ? `Company minimum ${kes(fees.minPayout)}`
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
        ) : null}

        <div className="grid gap-4 rounded-xl border border-border bg-surface-muted/40 p-4">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning"
              aria-hidden="true"
            >
              <LockKeyhole className="h-4 w-4" />
            </span>
            <p className="text-sm text-muted-foreground">
              Confirm your account password to change the collection mode, payout frequency, or
              destination.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-52 flex-1">
              <FormField id="gw-password" label="Account password">
              <input
                id="gw-password"
                type="password"
                className="field"
                autoComplete="current-password"
                value={password}
                disabled={readOnly || pending}
                onChange={(event) => setPassword(event.target.value)}
              />
              </FormField>
            </div>
            {pooled ? (
              <PrimaryButton
                type="button"
                disabled={
                  readOnly ||
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
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
