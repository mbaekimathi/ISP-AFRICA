import { useState } from "react";
import { Check, Smartphone, Ticket, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";

type DeviceTab = "one" | "multi";

type Bundle = {
  id: string;
  name: string;
  detail: string;
  meta: string;
  price: number;
  flexible?: boolean;
  extraDevice?: number;
  extraPeriod?: number;
  unit?: string;
};

/* Interactive replica of the hotspot bundle portal — sample data only.
   Mirrors the real flow: pick devices, pick a bundle, enter an M-Pesa number,
   approve the prompt on the phone, the page turns you online. */
const SAMPLE: {
  eyebrow: string;
  headline: string;
  hint: string;
  bundles: Record<DeviceTab, Bundle[]>;
} = {
  eyebrow: "Wi-Fi hotspot",
  headline: "Choose a bundle to get online",
  hint: "You're connected to ABS - ONGATA RONGAI. Pick a bundle and pay — your internet switches on as soon as M-Pesa confirms.",
  bundles: {
    one: [
      { id: "night", name: "NIGHT PACKAGE", detail: "10 Mbps down · 10 Mbps up · 1 hour", meta: "1 device", price: 1 },
      { id: "day", name: "DAY PACKAGE", detail: "15 Mbps down · 15 Mbps up · 1 day", meta: "1 device", price: 50 },
    ],
    multi: [
      {
        id: "family",
        name: "FAMILY PACKAGE",
        detail: "10 Mbps down · 10 Mbps up · 1 day",
        meta: "1 device included · +KSh 30 per extra device · +KSh 100 per extra day",
        price: 120,
        flexible: true,
        extraDevice: 30,
        extraPeriod: 100,
        unit: "day",
      },
      {
        id: "flex",
        name: "FLEX PACKAGE",
        detail: "10 Mbps down · 10 Mbps up · 1 day",
        meta: "1 device included · +KSh 20 per extra device · +KSh 30 per extra day",
        price: 60,
        flexible: true,
        extraDevice: 20,
        extraPeriod: 30,
        unit: "day",
      },
    ],
  },
};

type PayState = "idle" | "prompt" | "paid";

function normalizePhone(value: string) {
  const digits = value.replace(/[\s-]/g, "");
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return "";
}

export function HotspotPortalDemo() {
  const [tab, setTab] = useState<DeviceTab>("one");
  const [bundleId, setBundleId] = useState(SAMPLE.bundles.one[0].id);
  const [devices, setDevices] = useState(2);
  const [periods, setPeriods] = useState(1);
  const [phone, setPhone] = useState("");
  const [voucher, setVoucher] = useState("");
  const [voucherError, setVoucherError] = useState("");
  const [state, setState] = useState<PayState>("idle");
  const [viaVoucher, setViaVoucher] = useState(false);
  const [error, setError] = useState("");
  const bundles = SAMPLE.bundles[tab];
  const selected = bundles.find((b) => b.id === bundleId) ?? bundles[0];
  const customising = tab === "multi" && selected.flexible === true;
  const total =
    selected.price +
    (customising
      ? (devices - 1) * (selected.extraDevice ?? 0) + (periods - 1) * (selected.extraPeriod ?? 0)
      : 0);

  function pickTab(next: DeviceTab) {
    setTab(next);
    setBundleId(SAMPLE.bundles[next][0].id);
    setDevices(2);
    setPeriods(1);
    setState("idle");
    setError("");
  }

  function pay(event: React.FormEvent) {
    event.preventDefault();
    if (!normalizePhone(phone)) {
      setError("Enter the M-Pesa number that should receive the payment prompt.");
      return;
    }
    setError("");
    setViaVoucher(false);
    setState("prompt");
    window.setTimeout(() => setState("paid"), 2600);
  }

  function redeem() {
    if (!voucher.trim()) {
      setVoucherError("Enter the voucher code from the seller.");
      return;
    }
    setVoucherError("");
    setViaVoucher(true);
    setState("paid");
  }

  return (
    <div className="h-full overflow-auto bg-surface-muted p-5 text-left">
      <div className="mx-auto max-w-[22rem] rounded-2xl border border-border bg-surface p-5 shadow-card">
        {state === "paid" ? (
          <div className="grid justify-items-center gap-2 py-10 text-center" role="status">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check className="h-6 w-6" aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-foreground">You're online</p>
            <p className="text-sm text-muted-foreground">
              {viaVoucher
                ? `Voucher ${voucher.trim().toUpperCase()} connected you on ABS - ONGATA RONGAI.`
                : `${selected.name} is active on ABS - ONGATA RONGAI.`}
            </p>
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-primary underline-offset-4 hover:underline"
              onClick={() => {
                setState("idle");
                setPhone("");
                setVoucher("");
                setViaVoucher(false);
              }}
            >
              Try the demo again
            </button>
          </div>
        ) : state === "prompt" ? (
          <div className="grid justify-items-center gap-3 py-6 text-center" aria-live="polite">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Smartphone className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <p className="text-base font-semibold text-foreground">Check the phone</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Approve the M-Pesa prompt to start the connection.
              </p>
            </div>
            <dl className="w-full rounded-xl border border-border bg-surface-muted/50 px-4 text-left text-xs">
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2">
                <dt className="text-muted-foreground">Bundle</dt>
                <dd className="font-semibold text-foreground">{selected.name}</dd>
              </div>
              {customising ? (
                <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2">
                  <dt className="text-muted-foreground">Covers</dt>
                  <dd className="font-semibold text-foreground">
                    {devices} devices · {periods} × {selected.unit}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-semibold text-foreground">KSh {total}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-2">
                <dt className="text-muted-foreground">M-Pesa number</dt>
                <dd className="font-semibold text-foreground">{normalizePhone(phone)}</dd>
              </div>
            </dl>
            <p className="rounded-xl border border-border bg-surface-muted px-3 py-2 text-left text-[11px] leading-4 text-muted-foreground">
              Demo — nothing is charged. On the real portal the payment lands on its own and the device is allowed online.
            </p>
            <button
              type="button"
              className="w-full rounded-xl border border-border bg-surface py-2.5 text-xs font-semibold text-foreground hover:bg-surface-muted"
              onClick={() => setState("idle")}
            >
              Choose another bundle
            </button>
          </div>
        ) : (
          <form onSubmit={pay}>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
              {SAMPLE.eyebrow}
            </p>
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
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{SAMPLE.hint}</p>

            <fieldset className="mt-4">
              <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Wi-Fi bundles
              </legend>
              <div
                role="tablist"
                aria-label="Devices"
                className="mt-2 grid grid-cols-2 rounded-xl border border-border bg-surface-muted p-1"
              >
                {(
                  [
                    ["one", "One device"],
                    ["multi", "Multiple devices"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={cn(
                      "rounded-lg py-1.5 text-xs font-semibold transition",
                      tab === id ? "bg-surface text-foreground shadow-xs" : "text-muted-foreground",
                    )}
                    onClick={() => pickTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-2 grid gap-2">
                {bundles.map((bundle) => (
                  <label
                    key={bundle.id}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition",
                      bundle.id === bundleId
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border bg-surface hover:border-primary/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="hotspot-bundle"
                      value={bundle.id}
                      checked={bundle.id === bundleId}
                      onChange={() => setBundleId(bundle.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"
                      aria-hidden="true"
                    >
                      <Wifi className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold text-foreground">{bundle.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{bundle.detail}</span>
                      <span className="block text-[11px] text-muted-foreground">{bundle.meta}</span>
                    </span>
                    <span className="text-sm font-bold text-foreground">KSh {bundle.price}</span>
                    {bundle.id === bundleId ? (
                      <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" aria-hidden="true" />
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
              {customising ? (
                <div className="mt-2 grid gap-3 rounded-xl border border-primary/40 bg-primary/5 px-3 py-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="grid gap-1.5 text-xs font-medium text-foreground" htmlFor="hotspot-demo-devices">
                      Devices
                      <input
                        id="hotspot-demo-devices"
                        type="number"
                        className="field"
                        min={1}
                        max={50}
                        inputMode="numeric"
                        value={devices}
                        onChange={(event) =>
                          setDevices(Math.min(50, Math.max(1, Number(event.target.value) || 1)))
                        }
                      />
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium text-foreground" htmlFor="hotspot-demo-periods">
                      Periods (1 = {selected.unit})
                      <input
                        id="hotspot-demo-periods"
                        type="number"
                        className="field"
                        min={1}
                        max={60}
                        inputMode="numeric"
                        value={periods}
                        onChange={(event) =>
                          setPeriods(Math.min(60, Math.max(1, Number(event.target.value) || 1)))
                        }
                      />
                    </label>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {devices} devices · {periods} × {selected.unit} — total{" "}
                    <span className="font-semibold text-foreground">KSh {total}</span>
                  </p>
                </div>
              ) : null}
            </fieldset>

            <div className="mt-4">
              <label className="block text-xs font-medium text-foreground" htmlFor="hotspot-demo-phone">
                M-Pesa phone number
              </label>
              <input
                id="hotspot-demo-phone"
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
              Pay KSh {total} with M-Pesa
            </button>
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
              You will get a prompt on the phone to approve. The page updates itself when the payment lands and your internet turns on.
            </p>

            <div className="mt-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="mt-3">
              <label className="block text-xs font-medium text-foreground" htmlFor="hotspot-demo-voucher">
                Have a voucher? Enter the code
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="hotspot-demo-voucher"
                  className="field flex-1"
                  placeholder="e.g. ABS-4821"
                  value={voucher}
                  onChange={(event) => setVoucher(event.target.value)}
                />
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-xs font-semibold text-foreground hover:bg-surface-muted"
                  onClick={redeem}
                >
                  <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                  Redeem
                </button>
              </div>
              {voucherError ? (
                <p className="mt-1.5 text-[11px] font-medium text-destructive" role="alert">
                  {voucherError}
                </p>
              ) : null}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
