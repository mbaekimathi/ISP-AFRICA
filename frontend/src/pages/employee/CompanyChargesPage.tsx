import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
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

const emptyBand: BandDraft = { min: "", max: "", fee: "" };

function nextStart(max: string): string {
  const value = Number(max);
  return Number.isFinite(value) && max !== "" ? (value + 0.01).toFixed(2) : "";
}

export function CompanyChargesPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta(
    "TRANSACTION CHARGES — ISP CENTRIC",
    "Set the fee deducted from each gateway payout for a range of amounts.",
  );
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

  function updateBand(index: number, field: keyof BandDraft, value: string) {
    setBands((current) =>
      current.map((band, at) => {
        if (at === index) return { ...band, [field]: value };
        // A band's end sets the next band's start — ranges can never repeat.
        if (field === "max" && at === index + 1) return { ...band, min: nextStart(value) };
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

  function save() {
    setError("");
    setNotice("");
    setPending(true);
    apiRequest<{ outcome: string; charges: Charges }>("/api/employee/company/gateway/charges", {
      method: "POST",
      body: JSON.stringify({
        enabled,
        bands: bands.map((band) => ({ min: band.min, max: band.max, fee: band.fee })),
      }),
    })
      .then((body) => {
        apply(body.charges);
        setNotice("Saved.");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Transaction charges could not be saved.");
      })
      .finally(() => setPending(false));
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
        title="Transaction charges"
        description="The fee the gateway deducts from each payout for a range of amounts. When enabled, the band fee is taken off the amount collected from the client’s account and the balance is what Daraja sends."
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
      <form
        className="form-card mt-6 max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Deduct transaction charges from payouts
        </label>
        <div className="grid gap-3">
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
        <div>
          <PrimaryButton type="submit" disabled={pending || !loaded}>
            Save transaction charges
          </PrimaryButton>
        </div>
      </form>
    </div>
  );
}
