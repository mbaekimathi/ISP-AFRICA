import { useEffect, useState } from "react";
import { Wifi } from "lucide-react";
import { Link } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type Offer = {
  id: string;
  name: string;
  price: string;
  downloadMbps: number;
  uploadMbps: number;
  status: string;
  serviceType?: string;
  validityAmount?: number;
  validityUnit?: string;
  imageDataUrl?: string;
  simultaneousDevices?: number;
  extraDevicePrice?: string | null;
  extraPeriodPrice?: string | null;
};

function validityText(offer: Offer) {
  if (!offer.validityAmount || !offer.validityUnit) return "";
  const unit = offer.validityAmount === 1 && offer.validityUnit.endsWith("s") ? offer.validityUnit.slice(0, -1) : offer.validityUnit;
  return ` · ${offer.validityAmount} ${unit}`;
}

function unitLabel(offer: Offer) {
  const unit = offer.validityUnit || "days";
  const amount = offer.validityAmount ?? 1;
  if (amount === 1 && unit.endsWith("s")) return unit.slice(0, -1);
  return `${amount} ${unit}`;
}

function cents(value?: string | null) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function deviceCount(offer: Offer) {
  return offer.simultaneousDevices ?? 1;
}

function offerDetail(offer: Offer) {
  const count = deviceCount(offer);
  if (count === 0) {
    return `1 device included · +KSh ${offer.extraDevicePrice ?? "0"} per extra device · +KSh ${offer.extraPeriodPrice ?? "0"} per extra ${unitLabel(offer)}`;
  }
  return count > 1 ? `Up to ${count} devices` : "1 device";
}

const copy = {
  pppoe: {
    title: "PPPoE-payment",
    description: "The page a PPPoE customer uses to pay for access.",
    lead: "Pay for this PPPoE connection. Access continues after the payment is confirmed.",
  },
  hotspot: {
    title: "Hotspot-payment",
    description: "The page a customer uses to pay after connecting to the Wi-Fi.",
    lead: "You are connected to the Wi-Fi. Choose a package and pay to get online.",
  },
} as const;

function money(price: string) {
  const amount = Number(price);
  if (!Number.isFinite(amount)) return price;
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

function normalizePhone(value: string) {
  const digits = value.replace(/[\s-]/g, "");
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return "";
}

export function WifiPaymentPage({ kind }: { kind: keyof typeof copy }) {
  const view = copy[kind];
  usePageMeta(`${view.title} — ISP CENTRIC`, view.description);
  const { user } = useAuth();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<"one" | "multi">("one");
  const [devices, setDevices] = useState(2);
  const [periods, setPeriods] = useState(1);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [formError, setFormError] = useState("");
  const [prompt, setPrompt] = useState<{ name: string; price: string; phone: string; detail?: string } | null>(null);

  useEffect(() => {
    let stopped = false;
    apiRequest<{ packages: Offer[] }>("/api/packages")
      .then((body) => {
        if (stopped) return;
        const active = body.packages.filter((item) => item.status === "active" && (item.serviceType || "pppoe") === kind);
        setOffers(active);
        if (kind === "hotspot") {
          const single = active.filter((item) => deviceCount(item) <= 1);
          const fallback = single.length ? single : active.filter((item) => deviceCount(item) !== 1);
          setMode(single.length ? "one" : "multi");
          setSelected(fallback[0]?.id ?? "");
        } else {
          setSelected(active[0]?.id ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) setLoadError(cause instanceof Error ? cause.message : "Packages could not be loaded.");
      })
      .finally(() => {
        if (!stopped) setLoaded(true);
      });
    return () => {
      stopped = true;
    };
  }, []);

  const isHotspot = kind === "hotspot";
  const singleOffers = offers.filter((item) => deviceCount(item) <= 1);
  const multiOffers = offers.filter((item) => deviceCount(item) !== 1);
  const visibleOffers = isHotspot ? (mode === "one" ? singleOffers : multiOffers) : offers;
  const chosen = visibleOffers.find((item) => item.id === selected) ?? null;
  const customising = isHotspot && mode === "multi" && chosen != null && deviceCount(chosen) === 0;
  const totalCents = chosen
    ? cents(chosen.price) +
      (customising ? (devices - 1) * cents(chosen.extraDevicePrice) + (periods - 1) * cents(chosen.extraPeriodPrice) : 0)
    : 0;
  const total = (totalCents / 100).toFixed(2);
  const home = (path: string) => (user ? clientPage(user, path) : path);

  function chooseMode(next: "one" | "multi") {
    setMode(next);
    const list = next === "one" ? singleOffers : multiOffers;
    setSelected((current) => (list.some((item) => item.id === current) ? current : (list[0]?.id ?? "")));
  }

  function pay() {
    if (!chosen) {
      setFormError("Choose a package.");
      setPhoneError("");
      return;
    }
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setFormError("");
      setPhoneError("Enter the M-Pesa number that should receive the payment prompt.");
      return;
    }
    setFormError("");
    setPhoneError("");
    setPrompt({
      name: chosen.name,
      price: total,
      phone: normalized,
      detail: customising ? `${devices} devices · ${periods} × ${unitLabel(chosen)}` : undefined,
    });
  }

  return (
    <div className="page-shell py-8">
      <div className="mx-auto grid w-full max-w-lg gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{view.title}</h1>
              <StatusBadge tone={kind === "pppoe" ? "active" : "neutral"}>{kind === "pppoe" ? "PPPoE" : "Hotspot"}</StatusBadge>
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{view.lead}</p>
          </div>
        </div>

        {prompt && chosen ? (
          <section className="rounded-2xl border border-border bg-surface p-5 shadow-card" aria-live="polite">
            <div className="flex items-center gap-3">
              {chosen.imageDataUrl ? (
                <img src={chosen.imageDataUrl} alt="" className="h-16 w-24 rounded-xl object-cover" />
              ) : (
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Wifi className="h-5 w-5" aria-hidden="true" />
                </span>
              )}
              <div>
                <h2 className="text-base font-semibold">Check the phone</h2>
                <p className="text-sm text-muted-foreground">Approve the M-Pesa prompt to start the connection.</p>
              </div>
            </div>
            <dl className="mt-5 grid gap-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Package</dt>
                <dd className="font-medium">{prompt.name}</dd>
              </div>
              {prompt.detail ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">Covers</dt>
                  <dd className="font-medium">{prompt.detail}</dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-medium">{money(prompt.price)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">M-Pesa number</dt>
                <dd className="font-medium">{prompt.phone}</dd>
              </div>
            </dl>
            <p className="mt-4 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-muted-foreground">
              This is a preview of the payment step, so nothing has been charged. Guests who connect to a hotspot port pay on the captive
              page the router shows them; once M-Pesa confirms, that device is allowed online.
            </p>
            <div className="mt-4">
              <SecondaryButton type="button" onClick={() => setPrompt(null)}>
                Choose another package
              </SecondaryButton>
            </div>
          </section>
        ) : (
          <form
            className="grid gap-4 rounded-2xl border border-border bg-surface p-5 shadow-card"
            onSubmit={(event) => {
              event.preventDefault();
              pay();
            }}
          >
            {isHotspot && singleOffers.length > 0 && multiOffers.length > 0 ? (
              <FormPicker
                label="How many devices"
                options={[
                  { id: "one", label: "One device" },
                  { id: "multi", label: "Multiple devices" },
                ]}
                value={mode}
                onChange={(id) => chooseMode(id as "one" | "multi")}
              />
            ) : null}
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Package</legend>
              {!loaded ? <p className="text-sm text-muted-foreground">Loading packages…</p> : null}
              {formError ? (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
              {loadError ? (
                <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
                  {loadError}
                </p>
              ) : null}
              {loaded && !loadError && offers.length === 0 ? (
                <p className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-muted-foreground">
                  No active packages are available yet. Add one under Packages before a customer can pay here.
                </p>
              ) : null}
              {visibleOffers.map((offer) => (
                <label
                  key={offer.id}
                  className={cn(
                    "grid cursor-pointer grid-cols-[auto_5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-4 py-3",
                    selected === offer.id ? "border-primary bg-primary/5" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="package"
                    className="h-4 w-4 accent-primary"
                    checked={selected === offer.id}
                    onChange={() => setSelected(offer.id)}
                  />
                  {offer.imageDataUrl ? (
                    <img src={offer.imageDataUrl} alt="" className="h-12 w-20 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-12 w-20 items-center justify-center rounded-lg border border-dashed border-border text-[10px] text-muted-foreground">
                      No image
                    </span>
                  )}
                  <span>
                    <span className="block text-sm font-medium">{offer.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {offer.downloadMbps} Mbps down · {offer.uploadMbps} Mbps up{validityText(offer)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {isHotspot
                        ? offerDetail(offer)
                        : deviceCount(offer) === 0
                          ? "Unlimited devices"
                          : deviceCount(offer) === 1
                            ? "1 device"
                            : `Up to ${deviceCount(offer)} devices`}
                    </span>
                  </span>
                  <span className="text-sm font-semibold">{money(offer.price)}</span>
                </label>
              ))}
              {customising && chosen ? (
                <div className="grid gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium" htmlFor="wifi-devices">
                      Devices
                      <input
                        id="wifi-devices"
                        type="number"
                        className="field"
                        min={1}
                        max={50}
                        inputMode="numeric"
                        value={devices}
                        onChange={(event) => setDevices(Math.min(50, Math.max(1, Number(event.target.value) || 1)))}
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium" htmlFor="wifi-periods">
                      Periods (1 = {unitLabel(chosen)})
                      <input
                        id="wifi-periods"
                        type="number"
                        className="field"
                        min={1}
                        max={60}
                        inputMode="numeric"
                        value={periods}
                        onChange={(event) => setPeriods(Math.min(60, Math.max(1, Number(event.target.value) || 1)))}
                      />
                    </label>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {devices} devices · {periods} × {unitLabel(chosen)} — total{" "}
                    <span className="font-semibold text-foreground">{money(total)}</span>
                  </p>
                </div>
              ) : null}
            </fieldset>
            <FormField id="wifi-phone" label="M-Pesa number" hint="Safaricom number that will approve the payment, such as 0712345678." error={phoneError}>
              <input
                id="wifi-phone"
                className="field"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="07XXXXXXXX"
              />
            </FormField>
            <PrimaryButton type="submit" disabled={!chosen}>
              {chosen ? `Pay ${money(total)}` : "Pay"}
            </PrimaryButton>
            <p className="text-xs leading-5 text-muted-foreground">
              Guests on a hotspot port see a similar page when they are redirected to pay.{" "}
              <Link className="font-medium text-primary underline-offset-2 hover:underline" to={home("/account/settings/isp-payments")}>
                Payment settings
              </Link>{" "}
              still decide which Paybill or Till receives the money.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
