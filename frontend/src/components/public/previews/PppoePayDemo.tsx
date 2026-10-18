import { useState } from "react";
import { Check, Smartphone, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";

/* Interactive replica of the expired-subscription pay page — sample data only.
   Mirrors the real flow: pick a package, enter an M-Pesa number, get a prompt
   on the phone, page confirms itself when the payment lands. */
const SAMPLE = {
  brand: "ISP CENTRIC",
  portal: "Secure payment portal",
  headline: "Hi Amina Wanjiku, let's get you back online",
  hint: "Pick a package and pay — your internet comes back on its own, no call needed.",
  packages: [
    { id: "simba", name: "SIMBA · 10 MBPS", detail: "10 Mbps down · 15 Mbps up · 1 month", meta: "Up to 1 device", price: "1" },
    { id: "fibre", name: "FIBRE · 20 MBPS", detail: "20 Mbps down · 20 Mbps up · 1 month", meta: "Up to 3 devices", price: "1500" },
  ],
};

type PayState = "idle" | "prompt" | "paid";

function normalizePhone(value: string) {
  const digits = value.replace(/[\s-]/g, "");
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return "";
}

export function PppoePayDemo() {
  const [packageId, setPackageId] = useState(SAMPLE.packages[0].id);
  const [phone, setPhone] = useState("");
  const [state, setState] = useState<PayState>("idle");
  const [error, setError] = useState("");
  const selected = SAMPLE.packages.find((p) => p.id === packageId) ?? SAMPLE.packages[0];

  function pay(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("Enter the M-Pesa number that should receive the payment prompt.");
      return;
    }
    setError("");
    setState("prompt");
    window.setTimeout(() => setState("paid"), 2600);
  }

  return (
    <div className="h-full overflow-auto bg-surface-muted p-5 text-left">
      <div className="mx-auto max-w-[26rem] rounded-2xl border border-border bg-surface p-5 shadow-card">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Wifi className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{SAMPLE.brand}</p>
            <p className="text-[11px] text-muted-foreground">{SAMPLE.portal}</p>
          </div>
        </div>

        {state === "paid" ? (
          <div className="mt-6 grid justify-items-center gap-2 py-6 text-center" role="status">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check className="h-6 w-6" aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-foreground">Payment confirmed</p>
            <p className="text-sm text-muted-foreground">Amina is back online on {selected.name}.</p>
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-primary underline-offset-4 hover:underline"
              onClick={() => {
                setState("idle");
                setPhone("");
              }}
            >
              Try the demo again
            </button>
          </div>
        ) : state === "prompt" ? (
          <div className="mt-6 grid justify-items-center gap-3 py-4 text-center" aria-live="polite">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <p className="text-base font-semibold text-foreground">Check the phone</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Approve the M-Pesa prompt to get back online.
              </p>
            </div>
            <dl className="w-full rounded-xl border border-border bg-surface-muted/50 px-4 text-left text-xs">
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2">
                <dt className="text-muted-foreground">Package</dt>
                <dd className="font-semibold text-foreground">{selected.name}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-semibold text-foreground">KSh {selected.price}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-2">
                <dt className="text-muted-foreground">M-Pesa number</dt>
                <dd className="font-semibold text-foreground">{normalizePhone(phone)}</dd>
              </div>
            </dl>
            <p className="rounded-xl border border-border bg-surface-muted px-3 py-2 text-left text-[11px] leading-4 text-muted-foreground">
              Demo — nothing is charged. In the live page the payment lands on its own and the customer is back online.
            </p>
            <button
              type="button"
              className="w-full rounded-xl border border-border bg-surface py-2.5 text-xs font-semibold text-foreground hover:bg-surface-muted"
              onClick={() => setState("idle")}
            >
              Choose another package
            </button>
          </div>
        ) : (
          <form onSubmit={pay}>
            <div className="mt-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-destructive-soft text-destructive">
                <WifiOff className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive-soft px-2.5 py-1 text-[10px] font-bold tracking-wide text-destructive">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
                OFFLINE
              </span>
            </div>
            <p className="mt-3 text-lg font-bold leading-snug tracking-tight text-foreground">
              {SAMPLE.headline}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{SAMPLE.hint}</p>

            <fieldset className="mt-4">
              <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Choose a package
              </legend>
              <div className="mt-2 grid gap-2">
                {SAMPLE.packages.map((pkg) => (
                  <label
                    key={pkg.id}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition",
                      pkg.id === packageId
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border bg-surface hover:border-primary/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="pppoe-package"
                      value={pkg.id}
                      checked={pkg.id === packageId}
                      onChange={() => setPackageId(pkg.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"
                      aria-hidden="true"
                    >
                      <Wifi className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold text-foreground">{pkg.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{pkg.detail}</span>
                      <span className="block text-[11px] text-muted-foreground">{pkg.meta}</span>
                    </span>
                    <span className="text-sm font-bold text-foreground">KSh {pkg.price}</span>
                    {pkg.id === packageId ? (
                      <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-4">
              <label className="block text-xs font-medium text-foreground" htmlFor="pppoe-demo-phone">
                M-Pesa phone number
              </label>
              <input
                id="pppoe-demo-phone"
                className="field mt-1"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0712 345 678"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              {error ? (
                <p className="mt-1.5 text-[11px] font-medium text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition"
            >
              <Smartphone className="h-4 w-4" aria-hidden="true" />
              Pay KSh {selected.price} with M-Pesa
            </button>
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
              You will get a prompt on the phone to approve. The page updates itself when the payment lands.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
