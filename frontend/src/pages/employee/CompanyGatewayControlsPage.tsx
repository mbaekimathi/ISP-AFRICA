import { ReceiptText, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type BandDraft = {
  min: string;
  max: string;
  fee: string;
};

type Charges = {
  enabled: boolean;
  bands: { id: string; min: string; max: string | null; fee: string }[];
};

type GatewaySettings = {
  configured: boolean;
  status?: string | null;
  killSwitch?: boolean;
  commissionPercent?: string;
  commissionFlat?: string;
  defaultHoldHours?: number | null;
  minPayout?: string;
  maxPayoutPerTx?: string;
  payoutFeeEstimate?: string;
};

const emptyBand: BandDraft = { min: "", max: "", fee: "" };

function nextStart(max: string): string {
  const value = Number(max);
  return Number.isFinite(value) && max !== "" ? (value + 0.01).toFixed(2) : "";
}

export function CompanyGatewayControlsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta(
    "GATEWAY CONTROLS — ISP CENTRIC",
    "Run the pooled M-Pesa gateway — pause it, set settlement limits and commission, and price the fee deducted from each payout.",
  );
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [controlsBusy, setControlsBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [bands, setBands] = useState<BandDraft[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: Charges) => {
    setEnabled(body.enabled);
    setBands(body.bands.map((band) => ({ min: band.min, max: band.max ?? "", fee: band.fee })));
    setLoaded(true);
  }, []);

  const approvedId = employee?.status === "approved" ? employee.id : null;

  useEffect(() => {
    if (!approvedId) return;
    let stopped = false;
    apiRequest<GatewaySettings>("/api/employee/company/gateway/settings")
      .then((body) => {
        if (!stopped) setSettings(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setSettings({ configured: false });
          setError(cause instanceof Error ? cause.message : "Gateway controls could not be loaded.");
        }
      });
    apiRequest<Charges>("/api/employee/company/gateway/charges")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Transaction charges could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, approvedId]);

  const value = (key: string, fallback: string | number | null | undefined) =>
    draft[key] ?? (fallback == null ? "" : String(fallback));

  function quickSave(updates: Record<string, unknown>) {
    setControlsBusy(true);
    setError("");
    setNotice("");
    apiRequest<{ outcome: string; settings: GatewaySettings }>(
      "/api/employee/company/gateway/settings",
      { method: "POST", body: JSON.stringify(updates) },
    )
      .then((body) => setSettings(body.settings))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Gateway settings could not be saved."))
      .finally(() => setControlsBusy(false));
  }

  function updateBand(index: number, field: keyof BandDraft, next: string) {
    setBands((current) =>
      current.map((band, at) => {
        if (at === index) return { ...band, [field]: next };
        // A band's end sets the next band's start — ranges can never repeat.
        if (field === "max" && at === index + 1) return { ...band, min: nextStart(next) };
        return band;
      }),
    );
  }

  function removeBand(index: number) {
    setBands((current) => {
      const next = current.filter((_, at) => at !== index);
      return next.map((band, at) =>
        at === 0 ? band : { ...band, min: nextStart(next[at - 1].max) },
      );
    });
  }

  async function save() {
    setError("");
    setNotice("");
    setPending(true);
    try {
      const updates: Record<string, unknown> = {};
      if (draft.defaultHoldHours !== undefined) updates.defaultHoldHours = draft.defaultHoldHours;
      if (draft.commissionPercent !== undefined) updates.commissionPercent = draft.commissionPercent;
      if (draft.commissionFlat !== undefined) updates.commissionFlat = draft.commissionFlat;
      if (draft.minPayout !== undefined) updates.minPayout = draft.minPayout;
      if (draft.maxPayoutPerTx !== undefined) updates.maxPayoutPerTx = draft.maxPayoutPerTx;
      if (draft.payoutFeeEstimate !== undefined) updates.payoutFeeEstimate = draft.payoutFeeEstimate;
      if (Object.keys(updates).length > 0) {
        const body = await apiRequest<{ outcome: string; settings: GatewaySettings }>(
          "/api/employee/company/gateway/settings",
          { method: "POST", body: JSON.stringify(updates) },
        );
        setSettings(body.settings);
        setDraft({});
      }
      const body = await apiRequest<{ outcome: string; charges: Charges }>(
        "/api/employee/company/gateway/charges",
        {
          method: "POST",
          body: JSON.stringify({
            enabled,
            bands: bands.map((band) => ({ min: band.min, max: band.max, fee: band.fee })),
          }),
        },
      );
      apply(body.charges);
      setNotice("Saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gateway controls could not be saved.");
    } finally {
      setPending(false);
    }
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
    <div className="page-shell py-8">
      <PageHeader
        title="Gateway controls"
        description="Run the pooled M-Pesa gateway — pause it, set settlement limits and commission, and price the fee deducted from each payout."
      />
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 notice border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}

      <section className="card mt-6">
        <header className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck className="h-4 w-4" /></span>
          <h2 className="text-sm font-semibold">Gateway controls</h2>
          {settings?.configured ? (
            <div className="ml-auto flex items-center gap-2">
              <StatusBadge tone={settings.killSwitch ? "critical" : settings.status === "active" ? "active" : "paused"}>
                {settings.killSwitch ? "kill switch on" : (settings.status ?? "unknown")}
              </StatusBadge>
              <SecondaryButton
                type="button"
                disabled={controlsBusy}
                onClick={() => quickSave({ killSwitch: !settings.killSwitch })}
              >
                {settings.killSwitch ? "Release kill switch" : "Engage kill switch"}
              </SecondaryButton>
              <SecondaryButton
                type="button"
                disabled={controlsBusy}
                onClick={() => quickSave({ status: settings.status === "active" ? "suspended" : "active" })}
              >
                {settings.status === "active" ? "Suspend" : "Activate"}
              </SecondaryButton>
            </div>
          ) : null}
        </header>

        {settings === null ? (
          <p className="px-5 py-5 text-sm text-muted-foreground">Loading…</p>
        ) : !settings.configured ? (
          <p className="notice mx-5 my-5" role="status">
            Save the company Daraja credentials under Payments first — the
            gateway controls appear here afterwards.
          </p>
        ) : (
          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Default hold hours
              <input
                className="field"
                inputMode="numeric"
                value={value("defaultHoldHours", settings.defaultHoldHours)}
                onChange={(e) => setDraft((d) => ({ ...d, defaultHoldHours: e.target.value }))}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Commission %
              <input
                className="field"
                inputMode="decimal"
                value={value("commissionPercent", settings.commissionPercent)}
                onChange={(e) => setDraft((d) => ({ ...d, commissionPercent: e.target.value }))}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Commission flat (KES)
              <input
                className="field"
                inputMode="decimal"
                value={value("commissionFlat", settings.commissionFlat)}
                onChange={(e) => setDraft((d) => ({ ...d, commissionFlat: e.target.value }))}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Minimum payout (KES)
              <input
                className="field"
                inputMode="decimal"
                value={value("minPayout", settings.minPayout)}
                onChange={(e) => setDraft((d) => ({ ...d, minPayout: e.target.value }))}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Max per payout (KES)
              <input
                className="field"
                inputMode="decimal"
                placeholder="0 = no split cap"
                value={value("maxPayoutPerTx", settings.maxPayoutPerTx)}
                onChange={(e) => setDraft((d) => ({ ...d, maxPayoutPerTx: e.target.value }))}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Payout fee estimate (KES)
              <input
                className="field"
                inputMode="decimal"
                value={value("payoutFeeEstimate", settings.payoutFeeEstimate)}
                onChange={(e) => setDraft((d) => ({ ...d, payoutFeeEstimate: e.target.value }))}
              />
            </label>
          </div>
        )}

        <div className="border-t border-border px-5 py-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ReceiptText className="h-4 w-4 text-primary" aria-hidden="true" />
            Transaction charges
          </h3>
          <p className="mt-1 text-caption leading-5 text-muted-foreground">
            The fee the gateway deducts from each payout for a range of amounts. When enabled, the
            band fee is taken off the amount collected from the client’s account and the balance is
            what Daraja sends.
          </p>
          <div className="mt-4 grid gap-3">
            <label className="flex items-center gap-2.5 text-sm font-medium">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Deduct transaction charges from payouts
            </label>
            <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3 text-caption font-medium text-muted-foreground max-sm:grid-cols-3">
              <span>From (KES)</span>
              <span>To (KES)</span>
              <span>Fee (KES)</span>
              <span className="max-sm:hidden" />
            </div>
            {bands.map((band, index) => {
              const last = index === bands.length - 1;
              return (
                <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3 max-sm:grid-cols-3">
                  <input
                    className="field"
                    inputMode="decimal"
                    aria-label={`Band ${index + 1} start amount`}
                    placeholder="0"
                    value={band.min}
                    readOnly={index > 0 && bands[index - 1].max !== ""}
                    onChange={(event) => updateBand(index, "min", event.target.value)}
                  />
                  {last ? (
                    <span className="flex min-h-11 items-center rounded-lg border border-dashed border-border px-3 text-caption text-muted-foreground sm:min-h-10">
                      and above
                    </span>
                  ) : (
                    <input
                      className="field"
                      inputMode="decimal"
                      aria-label={`Band ${index + 1} end amount`}
                      placeholder="End"
                      value={band.max}
                      onChange={(event) => updateBand(index, "max", event.target.value)}
                    />
                  )}
                  <input
                    className="field"
                    inputMode="decimal"
                    aria-label={`Band ${index + 1} fee`}
                    placeholder="0.00"
                    value={band.fee}
                    onChange={(event) => updateBand(index, "fee", event.target.value)}
                  />
                  <SecondaryButton
                    type="button"
                    className="max-sm:col-span-3"
                    onClick={() => removeBand(index)}
                  >
                    Remove
                  </SecondaryButton>
                </div>
              );
            })}
            {bands.length === 0 ? (
              <p className="text-caption leading-5 text-muted-foreground">
                No charge bands yet — add one for each amount range.
              </p>
            ) : null}
            <div>
              <SecondaryButton
                type="button"
                onClick={() =>
                  setBands((current) => [
                    ...current,
                    {
                      ...emptyBand,
                      min: current.length ? nextStart(current[current.length - 1].max) : "",
                    },
                  ])
                }
              >
                Add band
              </SecondaryButton>
            </div>
            <p className="text-caption leading-5 text-muted-foreground">
              Bands are inclusive and may not overlap — each start follows the previous end automatically,
              and the last band runs from its start to any amount with a constant fee.
            </p>
          </div>
        </div>

        <div className="border-t border-border px-5 py-4">
          <PrimaryButton type="button" disabled={pending || !loaded} onClick={save}>
            {pending ? "Saving…" : "Save gateway controls"}
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
