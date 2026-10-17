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

type PaymentMode = "own" | "company";

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
  mode: PaymentMode | null;
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

const choices: { mode: PaymentMode; title: string; detail: string }[] = [
  {
    mode: "own",
    title: "My Daraja API",
    detail: "Collect with the consumer key, secret, short code, and passkey for this account.",
  },
  {
    mode: "company",
    title: "Company payment settings",
    detail: "Collect with the company Paybill or Till instead of this account’s own Daraja app.",
  },
];

export function IspPaymentsPage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP PAYMENTS SETTINGS — ISP CENTRIC", "Use your Daraja API or the company payment settings.");
  const [mode, setMode] = useState<PaymentMode>("own");
  const [drafts, setDrafts] = useState<Record<PaymentMode, PaymentDraft>>({ own: emptyDraft, company: emptyDraft });
  const [saved, setSaved] = useState<Record<PaymentMode, PaymentRecord | null>>({ own: null, company: null });
  const [checks, setChecks] = useState<Record<PaymentMode, ConnectionCheck>>({
    own: { state: "idle", reason: "" },
    company: { state: "idle", reason: "" },
  });
  const [savedMode, setSavedMode] = useState<PaymentMode | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const testConnection = useCallback((tested: PaymentMode, form?: PaymentDraft) => {
    setChecks((current) => ({ ...current, [tested]: { state: "checking", reason: "" } }));
    apiRequest<{ test: { connected: boolean; reason: string } }>("/api/payments/test", {
      method: "POST",
      body: JSON.stringify(
        form
          ? {
              mode: tested,
              [tested]: {
                environment: form.environment,
                consumerKey: form.consumerKey,
                consumerSecret: form.consumerSecret,
              },
            }
          : { mode: tested },
      ),
    })
      .then((body) => {
        setChecks((current) => ({
          ...current,
          [tested]: body.test.connected
            ? { state: "ok", reason: "" }
            : { state: "failed", reason: body.test.reason },
        }));
      })
      .catch((cause: unknown) => {
        setChecks((current) => ({
          ...current,
          [tested]: {
            state: "failed",
            reason: cause instanceof ApiRequestError ? cause.message : "The connection test could not be completed.",
          },
        }));
      });
  }, []);

  const apply = useCallback(
    (body: PaymentSettings) => {
      setSavedMode(body.mode);
      if (body.mode) setMode(body.mode);
      setSaved({ own: body.own, company: body.company });
      setDrafts({ own: draftFrom(body.own), company: draftFrom(body.company) });
      setLoaded(true);
      if (body.own) testConnection("own");
      if (body.company) testConnection("company");
    },
    [testConnection],
  );

  useEffect(() => {
    if (!user || user.status !== "approved") return;
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
    return () => {
      stopped = true;
    };
  }, [apply, user]);

  function update(field: keyof PaymentDraft, value: string) {
    setDrafts((current) => ({ ...current, [mode]: { ...current[mode], [field]: value } }));
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

  const draft = drafts[mode];
  const record = saved[mode];
  const check = checks[mode];
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

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Payments"
        description="Set up this account’s Daraja API, or use the company payment settings. Saved secrets stay hidden and are kept when you leave those fields unchanged."
      />
      {savedMode ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Payments currently use {savedMode === "own" ? "this account’s Daraja API" : "the company payment settings"}.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-foreground" role="status">
          {notice}
        </p>
      ) : null}
      <form
        className="form-card mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          apiRequest<PaymentSettings>("/api/payments", {
            method: "POST",
            body: JSON.stringify({ mode, [mode]: draft }),
          })
            .then((body) => {
              apply(body);
              setError("");
              setNotice(
                "Saved — payments now use " +
                  (mode === "own" ? "this account's Daraja API." : "the company payment settings."),
              );
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Payment settings could not be saved.");
            })
            .finally(() => setPending(false));
        }}
      >
        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium text-foreground">Payment source</legend>
          {choices.map((choice) => {
            const selected = mode === choice.mode;
            return (
              <label
                key={choice.mode}
                className={cn(
                  "grid cursor-pointer gap-1 rounded-lg border px-3 py-2",
                  selected ? "border-primary" : "border-border",
                )}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="payment-mode"
                    className="h-4 w-4"
                    checked={selected}
                    onChange={() => setMode(choice.mode)}
                  />
                  <span className="font-semibold">{choice.title}</span>
                </span>
                <span className="pl-7 text-sm text-muted-foreground">{choice.detail}</span>
              </label>
            );
          })}
        </fieldset>
        <div className="grid gap-4">
          <h2 className="text-lg font-semibold">{mode === "own" ? "Your Daraja API" : "Company payment settings"}</h2>
          <div className="grid gap-1">
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <span className={cn("h-2.5 w-2.5 rounded-full", statusDot)} aria-hidden="true" />
              {statusText}
            </p>
            {record?.updatedAt ? (
              <p className="text-xs text-muted-foreground">Last saved {record.updatedAt}</p>
            ) : null}
          </div>
          <div className="grid gap-4">
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
          <div className="grid gap-4 border-t border-border pt-4">
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
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" disabled={pending || !loaded}>
              {mode === "own" ? "Save my Daraja API" : "Save company payment settings"}
            </PrimaryButton>
            <SecondaryButton
              type="button"
              disabled={pending || check.state === "checking"}
              onClick={() => testConnection(mode, drafts[mode])}
            >
              Test connection
            </SecondaryButton>
          </div>
        </div>
      </form>
    </div>
  );
}
