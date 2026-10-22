import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type DarajaDraft = {
  environment: "" | "sandbox" | "live";
  accountType: "" | "paybill" | "till";
  shortCode: string;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  initiatorName: string;
  initiatorPassword: string;
  payoutShortcode: string;
};

type DarajaInfo = {
  callbackSecret: string;
  callbackBase: string;
  callbackUrls: Record<string, string>;
  updatedAt: string;
};

type CompanyPayments = {
  daraja:
    | (Omit<DarajaDraft, "environment" | "accountType"> & {
        environment: "sandbox" | "live";
        accountType: "paybill" | "till";
      } & Partial<DarajaInfo>)
    | null;
};

const CALLBACK_ENDPOINTS: { key: string; label: string; path: string }[] = [
  { key: "stk", label: "STK push result", path: "stk" },
  { key: "c2bValidation", label: "C2B validation", path: "c2b/validation" },
  { key: "c2bConfirmation", label: "C2B confirmation", path: "c2b/confirmation" },
  { key: "b2cResult", label: "B2C result", path: "b2c/result" },
  { key: "b2cTimeout", label: "B2C timeout", path: "b2c/timeout" },
  { key: "b2bResult", label: "B2B result", path: "b2b/result" },
  { key: "b2bTimeout", label: "B2B timeout", path: "b2b/timeout" },
  { key: "accountBalance", label: "Account balance", path: "account-balance" },
];

const emptyDaraja: DarajaDraft = {
  environment: "",
  accountType: "",
  shortCode: "",
  consumerKey: "",
  consumerSecret: "",
  passkey: "",
  initiatorName: "",
  initiatorPassword: "",
  payoutShortcode: "",
};

export function CompanyPaymentsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta(
    "COMPANY PAYMENTS — ISP CENTRIC",
    "Set up the company payment gateway — collections, B2C/B2B transfers, and callbacks through the company Daraja API.",
  );
  const [daraja, setDaraja] = useState<DarajaDraft>(emptyDaraja);
  const [darajaInfo, setDarajaInfo] = useState<DarajaInfo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "failed"; reason: string }>({
    state: "idle",
    reason: "",
  });

  const testConnection = useCallback((form?: DarajaDraft) => {
    setCheck({ state: "checking", reason: "" });
    apiRequest<{ test: { connected: boolean; reason: string } }>(
      "/api/employee/company/payments/test",
      {
        method: "POST",
        body: JSON.stringify(
          form
            ? {
                daraja: {
                  environment: form.environment,
                  consumerKey: form.consumerKey,
                  consumerSecret: form.consumerSecret,
                },
              }
            : {},
        ),
      },
    )
      .then((body) =>
        setCheck(
          body.test.connected
            ? { state: "ok", reason: "" }
            : { state: "failed", reason: body.test.reason },
        ),
      )
      .catch((cause: unknown) =>
        setCheck({
          state: "failed",
          reason:
            cause instanceof Error ? cause.message : "The connection test could not be completed.",
        }),
      );
  }, []);

  const apply = useCallback(
    (body: CompanyPayments) => {
      if (body.daraja) {
        const { callbackSecret, callbackBase, callbackUrls, updatedAt, ...draft } = body.daraja;
        setDaraja(draft);
        setDarajaInfo({
          callbackSecret: callbackSecret ?? "",
          callbackBase: callbackBase ?? "",
          callbackUrls: callbackUrls ?? {},
          updatedAt: updatedAt ?? "",
        });
        testConnection();
      } else {
        setDaraja(emptyDaraja);
        setDarajaInfo(null);
        setCheck({ state: "idle", reason: "" });
      }
      setLoaded(true);
    },
    [testConnection],
  );

  const approvedId = employee?.status === "approved" ? employee.id : null;

  useEffect(() => {
    if (!approvedId) return;
    let stopped = false;
    apiRequest<CompanyPayments>("/api/employee/company/payments")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Company payment settings could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, approvedId]);

  function save() {
    setError("");
    setNotice("");
    setPending(true);
    apiRequest<CompanyPayments>("/api/employee/company/payments", {
      method: "POST",
      body: JSON.stringify({ gateway: "daraja", daraja }),
    })
      .then((body) => {
        apply(body);
        setError("");
        setNotice("Saved. Checking the connection with Daraja…");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Company payment settings could not be saved.");
      })
      .finally(() => setPending(false));
  }

  const statusDot =
    check.state === "ok"
      ? "bg-success"
      : check.state === "failed"
        ? "bg-destructive"
        : "bg-muted-foreground";
  const statusText =
    check.state === "checking"
      ? "Checking the connection…"
      : check.state === "ok"
        ? "Connected — Daraja accepted the credentials."
        : check.state === "failed"
          ? `Not connected — ${check.reason}`
          : darajaInfo
            ? "Connection not tested yet."
            : "Save the details, then test the connection.";

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.status !== "approved") {
    return <Navigate to="/employee/account" replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Company payments"
        description="Set up the company payment gateway — collections, B2C/B2B transfers, and callbacks all run through the company Daraja API. Saved secrets stay hidden and are kept when you leave those fields unchanged."
      />
      <form
        className="form-card mt-6 max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h2 className="text-lg font-semibold">Company payment gateway — Daraja</h2>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${statusDot}`} />
          {statusText}
        </p>
        <div className="grid gap-4">
          <h3 className="text-sm font-semibold">Collections — STK push &amp; C2B</h3>
          <p className="-mt-2 text-caption leading-5 text-muted-foreground">
            Copied from your Daraja app on the M-Pesa portal.
          </p>
          <FormField id="company-daraja-environment" label="Environment">
            <select
              id="company-daraja-environment"
              className="field"
              value={daraja.environment}
              onChange={(event) => setDaraja((current) => ({ ...current, environment: event.target.value as DarajaDraft["environment"] }))}
            >
              <option value="">Choose environment</option>
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
          </FormField>
          <FormField id="company-daraja-account-type" label="Account type">
            <select
              id="company-daraja-account-type"
              className="field"
              value={daraja.accountType}
              onChange={(event) => setDaraja((current) => ({ ...current, accountType: event.target.value as DarajaDraft["accountType"] }))}
            >
              <option value="">Choose account type</option>
              <option value="paybill">Paybill</option>
              <option value="till">Till</option>
            </select>
          </FormField>
          <FormField id="company-daraja-short-code" label="Business short code">
            <input
              id="company-daraja-short-code"
              className="field"
              inputMode="numeric"
              maxLength={10}
              value={daraja.shortCode}
              onChange={(event) =>
                setDaraja((current) => ({ ...current, shortCode: event.target.value.replace(/\D/g, "").slice(0, 10) }))
              }
            />
          </FormField>
          <FormField
            id="company-daraja-consumer-key"
            label="Consumer key"
            hint="Daraja portal → your app → consumer key."
          >
            <input
              id="company-daraja-consumer-key"
              className="field"
              autoComplete="off"
              value={daraja.consumerKey}
              onChange={(event) => setDaraja((current) => ({ ...current, consumerKey: event.target.value }))}
            />
          </FormField>
          <FormField
            id="company-daraja-consumer-secret"
            label="Consumer secret"
            hint="Daraja portal → your app → consumer secret."
          >
            <input
              id="company-daraja-consumer-secret"
              type="password"
              className="field"
              autoComplete="new-password"
              value={daraja.consumerSecret}
              onChange={(event) => setDaraja((current) => ({ ...current, consumerSecret: event.target.value }))}
            />
          </FormField>
          <FormField
            id="company-daraja-passkey"
            label="Passkey"
            hint="Lipa Na M-Pesa Online passkey — signs STK push prompts."
          >
            <input
              id="company-daraja-passkey"
              type="password"
              className="field"
              autoComplete="new-password"
              value={daraja.passkey}
              onChange={(event) => setDaraja((current) => ({ ...current, passkey: event.target.value }))}
            />
          </FormField>
          <h3 className="text-sm font-semibold">Transfers — B2C &amp; B2B</h3>
          <p className="-mt-2 text-caption leading-5 text-muted-foreground">
            The initiator operator created on the M-Pesa portal for payouts and business transfers.
          </p>
          <FormField
            id="company-daraja-initiator-name"
            label="Initiator name"
            hint="The operator username with B2C/B2B rights."
          >
            <input
              id="company-daraja-initiator-name"
              className="field"
              autoComplete="off"
              maxLength={60}
              value={daraja.initiatorName}
              onChange={(event) => setDaraja((current) => ({ ...current, initiatorName: event.target.value }))}
            />
          </FormField>
          <FormField
            id="company-daraja-initiator-password"
            label="Initiator password"
            hint="The system RSA-encrypts this into the security credential when sending — it is stored sealed."
          >
            <input
              id="company-daraja-initiator-password"
              type="password"
              className="field"
              autoComplete="new-password"
              value={daraja.initiatorPassword}
              onChange={(event) => setDaraja((current) => ({ ...current, initiatorPassword: event.target.value }))}
            />
          </FormField>
          <FormField
            id="company-daraja-payout-shortcode"
            label="Payout shortcode"
            hint="Optional — the shortcode transfers are sent from. Defaults to the collection short code."
          >
            <input
              id="company-daraja-payout-shortcode"
              className="field"
              inputMode="numeric"
              maxLength={10}
              placeholder="Same as business short code"
              value={daraja.payoutShortcode}
              onChange={(event) =>
                setDaraja((current) => ({ ...current, payoutShortcode: event.target.value.replace(/\D/g, "").slice(0, 10) }))
              }
            />
          </FormField>
        </div>
        {darajaInfo ? (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">Callback endpoints — generated automatically</h3>
            <p className="text-caption leading-5 text-muted-foreground">
              Nothing to type — the system builds these from the callback secret it issued. Register them on
              the M-Pesa portal; Daraja posts collection, payout, and balance results to them.
            </p>
            {darajaInfo.callbackBase ? null : (
              <p className="notice" role="status">
                Set ISP_GATEWAY_PUBLIC_URL to this server’s public https address — the paths below only work
                once Daraja can reach it.
              </p>
            )}
            <dl className="grid gap-2">
              {CALLBACK_ENDPOINTS.map((endpoint) => (
                <div key={endpoint.key} className="grid gap-0.5">
                  <dt className="text-caption text-muted-foreground">{endpoint.label}</dt>
                  <dd className="break-all rounded-md bg-surface-muted px-2.5 py-1.5 font-mono text-caption">
                    {darajaInfo.callbackUrls[endpoint.key] ||
                      `/api/daraja/${darajaInfo.callbackSecret}/${endpoint.path}`}
                  </dd>
                </div>
              ))}
            </dl>
            {darajaInfo.updatedAt ? (
              <p className="text-caption text-muted-foreground">Last saved {darajaInfo.updatedAt}</p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : notice ? (
          <p className="notice border-success-border bg-success-soft/60" role="status">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton type="submit" disabled={pending || !loaded}>
            {pending ? "Saving…" : "Save company gateway"}
          </PrimaryButton>
          <SecondaryButton
            type="button"
            disabled={pending || check.state === "checking"}
            onClick={() => {
              setNotice("");
              testConnection(daraja);
            }}
          >
            {check.state === "checking" ? "Testing…" : "Test connection"}
          </SecondaryButton>
        </div>
      </form>
    </div>
  );
}
