import { useEffect, useState } from "react";
import { Wifi } from "lucide-react";
import { Link } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
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
};

function validityText(offer: Offer) {
  if (!offer.validityAmount || !offer.validityUnit) return "";
  const unit = offer.validityAmount === 1 && offer.validityUnit.endsWith("s") ? offer.validityUnit.slice(0, -1) : offer.validityUnit;
  return ` · ${offer.validityAmount} ${unit}`;
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
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [formError, setFormError] = useState("");
  const [prompt, setPrompt] = useState<{ name: string; price: string; phone: string } | null>(null);

  useEffect(() => {
    let stopped = false;
    apiRequest<{ packages: Offer[] }>("/api/packages")
      .then((body) => {
        if (stopped) return;
        const active = body.packages.filter((item) => item.status === "active" && (item.serviceType || "pppoe") === kind);
        setOffers(active);
        setSelected(active[0]?.id ?? "");
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

  const chosen = offers.find((item) => item.id === selected) ?? null;
  const home = (path: string) => (user ? clientPage(user, path) : path);

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
    setPrompt({ name: chosen.name, price: chosen.price, phone: normalized });
  }

  return (
    <div className="page-shell py-8">
      <div className="mx-auto grid w-full max-w-lg gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
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
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Package</legend>
              {!loaded ? <p className="text-sm text-muted-foreground">Loading packages...</p> : null}
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
              {offers.map((offer) => (
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
                  </span>
                  <span className="text-sm font-semibold">{money(offer.price)}</span>
                </label>
              ))}
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
              {chosen ? `Pay ${money(chosen.price)}` : "Pay"}
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
