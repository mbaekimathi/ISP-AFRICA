import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField, FormPicker } from "@/components/ui/FormField";
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
};

type OtherDraft = {
  provider: string;
  environment: "" | "sandbox" | "live";
  endpoint: string;
  publicKey: string;
  secretKey: string;
};

type CompanyPayments = {
  daraja: Omit<DarajaDraft, "environment" | "accountType"> & {
    environment: "sandbox" | "live";
    accountType: "paybill" | "till";
  } | null;
  other: Omit<OtherDraft, "environment"> & { environment: "sandbox" | "live" } | null;
};

const emptyDaraja: DarajaDraft = {
  environment: "",
  accountType: "",
  shortCode: "",
  consumerKey: "",
  consumerSecret: "",
  passkey: "",
};

const emptyOther: OtherDraft = {
  provider: "",
  environment: "",
  endpoint: "",
  publicKey: "",
  secretKey: "",
};

export function CompanyPaymentsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta(
    "COMPANY PAYMENTS — ISP CENTRIC",
    "Set up the company Daraja API credentials and the company payment gateway.",
  );
  const [daraja, setDaraja] = useState<DarajaDraft>(emptyDaraja);
  const [other, setOther] = useState<OtherDraft>(emptyOther);
  const [panel, setPanel] = useState<"daraja" | "gateway">("daraja");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"daraja" | "other" | null>(null);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: CompanyPayments) => {
    setDaraja(body.daraja ? { ...body.daraja } : emptyDaraja);
    setOther(body.other ? { ...body.other } : emptyOther);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
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
  }, [apply, employee]);

  function save(gateway: "daraja" | "other") {
    setError("");
    setPending(gateway);
    apiRequest<CompanyPayments>("/api/employee/company/payments", {
      method: "POST",
      body: JSON.stringify(gateway === "daraja" ? { gateway, daraja } : { gateway, other }),
    })
      .then((body) => {
        apply(body);
        setError("");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Company payment settings could not be saved.");
      })
      .finally(() => setPending(null));
  }

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
    <div className="page-shell py-10">
      <PageHeader
        title="Company payments"
        description="Set up the company Daraja API credentials and the company payment gateway. Saved secrets stay hidden and are kept when you leave those fields unchanged."
      />
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-stack mt-6">
        <FormPicker
          label="Company payment form"
          value={panel}
          onChange={(id) => setPanel(id as "daraja" | "gateway")}
          options={[
            { id: "daraja", label: "Daraja" },
            { id: "gateway", label: "Gateway" },
          ]}
        />
      </div>
      <form
        className="form-card mt-4"
        hidden={panel !== "daraja"}
        onSubmit={(event) => {
          event.preventDefault();
          save("daraja");
        }}
      >
        <h2 className="text-lg font-semibold">Company Daraja API</h2>
        <div className="grid gap-4">
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
          <FormField id="company-daraja-consumer-key" label="Consumer key">
            <input
              id="company-daraja-consumer-key"
              className="field"
              autoComplete="off"
              value={daraja.consumerKey}
              onChange={(event) => setDaraja((current) => ({ ...current, consumerKey: event.target.value }))}
            />
          </FormField>
          <FormField id="company-daraja-consumer-secret" label="Consumer secret">
            <input
              id="company-daraja-consumer-secret"
              type="password"
              className="field"
              autoComplete="new-password"
              value={daraja.consumerSecret}
              onChange={(event) => setDaraja((current) => ({ ...current, consumerSecret: event.target.value }))}
            />
          </FormField>
          <FormField id="company-daraja-passkey" label="Passkey">
            <input
              id="company-daraja-passkey"
              type="password"
              className="field"
              autoComplete="new-password"
              value={daraja.passkey}
              onChange={(event) => setDaraja((current) => ({ ...current, passkey: event.target.value }))}
            />
          </FormField>
        </div>
        <div>
          <PrimaryButton type="submit" disabled={pending !== null || !loaded}>
            Save company Daraja API
          </PrimaryButton>
        </div>
      </form>
      <form
        className="form-card mt-4"
        hidden={panel !== "gateway"}
        onSubmit={(event) => {
          event.preventDefault();
          save("other");
        }}
      >
        <h2 className="text-lg font-semibold">Company payment gateway</h2>
        <div className="grid gap-4">
          <FormField id="company-gateway-provider" label="Gateway name">
            <input
              id="company-gateway-provider"
              className="field"
              maxLength={80}
              value={other.provider}
              onChange={(event) => setOther((current) => ({ ...current, provider: event.target.value }))}
            />
          </FormField>
          <FormField id="company-gateway-environment" label="Environment">
            <select
              id="company-gateway-environment"
              className="field"
              value={other.environment}
              onChange={(event) => setOther((current) => ({ ...current, environment: event.target.value as OtherDraft["environment"] }))}
            >
              <option value="">Choose environment</option>
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
          </FormField>
          <FormField id="company-gateway-endpoint" label="API endpoint">
            <input
              id="company-gateway-endpoint"
              className="field"
              inputMode="url"
              value={other.endpoint}
              onChange={(event) => setOther((current) => ({ ...current, endpoint: event.target.value }))}
            />
          </FormField>
          <FormField id="company-gateway-public-key" label="Public key">
            <input
              id="company-gateway-public-key"
              className="field"
              autoComplete="off"
              value={other.publicKey}
              onChange={(event) => setOther((current) => ({ ...current, publicKey: event.target.value }))}
            />
          </FormField>
          <FormField id="company-gateway-secret-key" label="Secret key">
            <input
              id="company-gateway-secret-key"
              type="password"
              className="field"
              autoComplete="new-password"
              value={other.secretKey}
              onChange={(event) => setOther((current) => ({ ...current, secretKey: event.target.value }))}
            />
          </FormField>
        </div>
        <div>
          <PrimaryButton type="submit" disabled={pending !== null || !loaded}>
            Save company payment gateway
          </PrimaryButton>
        </div>
      </form>
    </div>
  );
}
