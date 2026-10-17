import { useEffect, useState } from "react";
import { Check, Smartphone, Wifi } from "lucide-react";
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
    <div className="page-shell py-8 sm:py-10">
      <div className="mx-auto grid w-full max-w-lg gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Wifi className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{view.title}</h1>
              <StatusBadge tone={kind === "pppoe" ? "active" : "neutral"}>{kind === "pppoe" ? "PPPoE" : "Hotspot"}</StatusBadge>
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{view.lead}</p>
          </div>
        </div>

        {prompt && chosen ? (
          <section
            className="grid justify-items-center gap-4 rounded-2xl border border-border bg-surface p-6 text-center shadow-card"
            aria-live="polite"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-7 w-7" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Check the phone</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Approve the M-Pesa prompt to start the connection.
              </p>
            </div>
            <dl className="w-full rounded-xl border border-border bg-surface-muted/50 px-4 text-left text-sm">
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2.5">
                <dt className="text-muted-foreground">Package</dt>
                <dd className="font-semibold">{prompt.name}</dd>
              </div>
              {prompt.detail ? (
                <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2.5">
                  <dt className="text-muted-foreground">Covers</dt>
                  <dd className="font-semibold">{prompt.detail}</dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2.5">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-semibold">{money(prompt.price)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-2.5">
                <dt className="text-muted-foreground">M-Pesa number</dt>
                <dd className="font-semibold">{prompt.phone}</dd>
              </div>
            </dl>
            <p className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-left text-xs leading-5 text-muted-foreground">
              This is a preview of the payment step, so nothing has been charged. Guests who connect to a hotspot port pay on the captive
              page the router shows them; once M-Pesa confirms, that device is allowed online.
            </p>
            <SecondaryButton type="button" className="w-full" onClick={() => setPrompt(null)}>
              Choose another package
            </SecondaryButton>
          </section>
        ) : (
          <form
            className="grid gap-5 rounded-2xl border border-border bg-surface p-5 shadow-card sm:p-6"
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
            <fieldset className="grid gap-3">
              <legend className="sr-only">Package</legend>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Choose a package</span>
                {chosen ? (
                  <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-sm font-bold text-primary">
                    {money(total)}
                  </span>
                ) : null}
              </div>
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
                    "relative grid cursor-pointer grid-cols-[auto_3.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3.5 py-3 transition duration-brand ease-brand",
                    selected === offer.id
                      ? "border-primary bg-primary/[0.06] shadow-sm ring-1 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-surface-muted/60",
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
                    <img src={offer.imageDataUrl} alt="" className="h-12 w-14 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-12 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Wifi className="h-5 w-5" aria-hidden="true" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{offer.name}</span>
                    <span className="block text-xs leading-5 text-muted-foreground">
                      {offer.downloadMbps} Mbps down · {offer.uploadMbps} Mbps up{validityText(offer)}
                    </span>
                    <span className="block text-xs leading-5 text-muted-foreground">
                      {isHotspot
                        ? offerDetail(offer)
                        : deviceCount(offer) === 0
                          ? "Unlimited devices"
                          : deviceCount(offer) === 1
                            ? "1 device"
                            : `Up to ${deviceCount(offer)} devices`}
                    </span>
                  </span>
                  <span className="text-sm font-bold">{money(offer.price)}</span>
                  {selected === offer.id ? (
                    <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                  ) : null}
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
            <PrimaryButton type="submit" className="w-full" disabled={!chosen}>
              <Smartphone className="h-4 w-4" aria-hidden="true" />
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
