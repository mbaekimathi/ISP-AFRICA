import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FormField } from "@/components/ui/FormField";
import { PageHeader } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TunnelNotification } from "@/components/ui/TunnelNotification";
import { usePageMeta } from "@/hooks/usePageMeta";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";

type RouterOption = { id: string; name: string; tunnelStatus: string };
type PackageOption = { id: string; name: string; price: string; downloadMbps: number; uploadMbps: number };

function generatePassword() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

const empty = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  buildingName: "",
  houseNumber: "",
  username: "",
  password: generatePassword(),
  routerId: "",
  packageId: "",
  serial: "",
  startDate: "",
  price: "",
  billingCycle: "monthly",
  cycleDays: "30",
  initialPayment: "0",
  discount: "0",
  discountReason: "",
  graceDays: "3",
  autoRenew: true,
  staticIp: "",
  sessionLimit: "1",
  accessInterface: "",
  mtu: "1492",
};

export function PppoeRegisterPage() {
  usePageMeta("Register PPPoE client — ISP CENTRIC", "Create a PPPoE subscriber and RADIUS login.");
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState(empty);
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [routers, setRouters] = useState<RouterOption[]>([]);
  const [packages, setPackages] = useState<PackageOption[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [usernameNote, setUsernameNote] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState<"up" | "down" | "unknown">("unknown");

  useEffect(() => {
    apiRequest<{ routers: RouterOption[] }>("/api/routers")
      .then((body) => setRouters(body.routers))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Routers could not be loaded."));
  }, []);

  useEffect(() => {
    if (!form.routerId) {
      setPackages([]);
      setTunnelStatus("unknown");
      return;
    }
    const selectedRouter = routers.find((item) => item.id === form.routerId);
    setTunnelStatus(selectedRouter?.tunnelStatus === "up" ? "up" : selectedRouter?.tunnelStatus === "down" ? "down" : "unknown");
    apiRequest<{ packages: PackageOption[] }>(`/api/routers/${form.routerId}/packages`)
      .then((body) => setPackages(body.packages))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Packages could not be loaded."));
  }, [form.routerId, routers]);

  useEffect(() => {
    const digits = form.phone.replace(/\D/g, "");
    if (!usernameEdited && digits.length >= 3) setForm((current) => ({ ...current, username: digits }));
  }, [form.phone, usernameEdited]);

  useEffect(() => {
    const selected = packages.find((item) => item.id === form.packageId);
    if (selected) setForm((current) => ({ ...current, price: selected.price }));
  }, [form.packageId, packages]);

  useEffect(() => {
    if (form.username.trim().length < 3) {
      setUsernameNote("");
      return;
    }
    const timer = window.setTimeout(() => {
      apiRequest<{ available: boolean }>(`/api/pppoe/check-username?u=${encodeURIComponent(form.username.trim())}`)
        .then((body) => setUsernameNote(body.available ? "Username is available." : "That username is already used."))
        .catch(() => setUsernameNote(""));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [form.username]);

  const selectedPackage = packages.find((item) => item.id === form.packageId);
  const preview = useMemo(() => {
    if (!form.startDate) return "No start date. The account stays pending and RADIUS will not grant access.";
    return `Access starts ${form.startDate}. Due dates are calculated from that date and the ${form.billingCycle} cycle.`;
  }, [form.startDate, form.billingCycle]);

  function setField(name: keyof typeof empty, value: string | boolean) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(another: boolean) {
    setSaving(true);
    setNotice("");
    setErrors({});
    try {
      const body = await apiRequest<{ subscriber: { id: string; password?: string; radiusSecret?: string; warnings?: { message: string }[] } }>(
        "/api/pppoe/subscribers",
        { method: "POST", body: JSON.stringify({ ...form, autoRenew: form.autoRenew }) },
      );
      const warningText = (body.subscriber.warnings ?? []).map((item) => item.message).join(" ");
      if (another) {
        setWarnings(warningText ? [warningText] : []);
        setNotice(`Saved. Password: ${body.subscriber.password ?? ""}${body.subscriber.radiusSecret ? ` RADIUS secret: ${body.subscriber.radiusSecret}` : ""}`);
        setUsernameEdited(false);
        setForm({ ...empty, password: generatePassword(), routerId: form.routerId });
      } else {
        navigate(user ? clientPage(user, `/pppoe/${body.subscriber.id}`) : `/pppoe/${body.subscriber.id}`);
      }
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const next: Record<string, string> = {};
        for (const item of error.errors) next[item.field] = item.message;
        setErrors(next);
        setNotice(error.message);
      } else {
        setNotice(error instanceof Error ? error.message : "The client could not be registered.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(form.password);
      setNotice("Password copied.");
    } catch {
      setNotice("The password could not be copied.");
    }
  }

  return (
    <div className="page-shell py-8">
      {form.routerId && routers.some((item) => item.id === form.routerId) ? (
        <TunnelNotification
          tunnelStatus={tunnelStatus}
          routerName={routers.find((item) => item.id === form.routerId)?.name || "Router"}
          polling={false}
        />
      ) : null}
      <PageHeader title="Register PPPoE client" description="Saving checks the username, package, router, and address, then writes the RADIUS login." />
      {notice ? <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="status">{notice}</p> : null}
      {warnings.map((item) => (
        <p key={item} className="mt-3 text-sm text-muted-foreground">{item}</p>
      ))}
      <form
        className="mt-6 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <section className="grid gap-4 rounded-xl border border-border bg-surface p-5 md:grid-cols-2">
          <h2 className="md:col-span-2 text-base font-semibold">Customer</h2>
          <FormField id="first-name" label="First name" error={errors.firstName}>
            <input id="first-name" className="field" value={form.firstName} onChange={(event) => setField("firstName", event.target.value)} required />
          </FormField>
          <FormField id="last-name" label="Last name" error={errors.lastName}>
            <input id="last-name" className="field" value={form.lastName} onChange={(event) => setField("lastName", event.target.value)} required />
          </FormField>
          <FormField id="phone" label="Phone number" error={errors.phone} hint="07…, 01…, or +254…">
            <input id="phone" className="field" value={form.phone} onChange={(event) => setField("phone", event.target.value)} required />
          </FormField>
          <FormField id="email" label="Email" error={errors.email}>
            <input id="email" className="field" type="email" value={form.email} onChange={(event) => setField("email", event.target.value)} />
          </FormField>
          <FormField id="building" label="Building name">
            <input id="building" className="field" value={form.buildingName} onChange={(event) => setField("buildingName", event.target.value)} />
          </FormField>
          <FormField id="house" label="House number">
            <input id="house" className="field" value={form.houseNumber} onChange={(event) => setField("houseNumber", event.target.value)} />
          </FormField>
        </section>
        <section className="grid gap-4 rounded-xl border border-border bg-surface p-5 md:grid-cols-2">
          <h2 className="md:col-span-2 text-base font-semibold">PPPoE credentials</h2>
          <FormField id="username" label="PPPoE username" error={errors.username} hint={usernameNote}>
            <input
              id="username"
              className="field"
              value={form.username}
              onChange={(event) => {
                setUsernameEdited(true);
                setField("username", event.target.value);
              }}
              required
            />
          </FormField>
          <FormField id="password" label="PPPoE password" error={errors.password} hint="Use 8 to 12 characters without O or l. A phone number like 0723864156 works.">
            <div className="flex flex-wrap gap-2">
              <input id="password" className="field" type={showPassword ? "text" : "password"} value={form.password} onChange={(event) => setField("password", event.target.value)} required />
              <SecondaryButton type="button" onClick={() => setShowPassword((current) => !current)}>{showPassword ? "Hide" : "Show"}</SecondaryButton>
              <SecondaryButton type="button" onClick={() => setField("password", generatePassword())}>Regenerate</SecondaryButton>
              <SecondaryButton type="button" onClick={() => void copyPassword()}>Copy</SecondaryButton>
            </div>
          </FormField>
        </section>
        <section className="grid gap-4 rounded-xl border border-border bg-surface p-5 md:grid-cols-2">
          <h2 className="md:col-span-2 text-base font-semibold">Service</h2>
          <FormField id="router" label="MikroTik router" error={errors.routerId}>
            <select
              id="router"
              className="field"
              value={form.routerId}
              onChange={(event) => {
                setField("routerId", event.target.value);
                setField("packageId", "");
              }}
              required
            >
              <option value="">Choose a router</option>
              {routers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.tunnelStatus})
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="package" label="Package" error={errors.packageId} hint={selectedPackage ? `${selectedPackage.downloadMbps}/${selectedPackage.uploadMbps} Mbps · KSh ${selectedPackage.price}` : "Choose a router first."}>
            <select id="package" className="field" value={form.packageId} disabled={!form.routerId} onChange={(event) => setField("packageId", event.target.value)} required>
              <option value="">Choose a package</option>
              {packages.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.downloadMbps}/{item.uploadMbps} Mbps · KSh {item.price}</option>
              ))}
            </select>
          </FormField>
          {form.routerId ? <StatusBadge tone={routers.find((item) => item.id === form.routerId)?.tunnelStatus === "up" ? "active" : "due"}>{routers.find((item) => item.id === form.routerId)?.tunnelStatus === "up" ? "Router online" : "Router not confirmed"}</StatusBadge> : null}
          <FormField id="serial" label="Router / ONU serial" error={errors.serial}>
            <input id="serial" className="field" value={form.serial} onChange={(event) => setField("serial", event.target.value)} />
          </FormField>
          <FormField id="start" label="Package start date" error={errors.startDate} hint="Leave empty to keep the account pending.">
            <input id="start" className="field" type="date" value={form.startDate} onChange={(event) => setField("startDate", event.target.value)} />
          </FormField>
        </section>
        <details className="rounded-xl border border-border bg-surface p-5">
          <summary className="cursor-pointer text-base font-semibold">Billing details</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <FormField id="price" label="Price (KSh)" error={errors.price}>
              <input id="price" className="field" value={form.price} onChange={(event) => setField("price", event.target.value)} />
            </FormField>
            <FormField id="cycle" label="Billing cycle" error={errors.billingCycle}>
              <select id="cycle" className="field" value={form.billingCycle} onChange={(event) => setField("billingCycle", event.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="custom">Custom</option>
              </select>
            </FormField>
            {form.billingCycle === "custom" ? (
              <FormField id="cycle-days" label="Custom cycle days" error={errors.cycleDays}>
                <input id="cycle-days" className="field" value={form.cycleDays} onChange={(event) => setField("cycleDays", event.target.value)} />
              </FormField>
            ) : null}
            <FormField id="initial" label="Initial payment" error={errors.initialPayment}>
              <input id="initial" className="field" value={form.initialPayment} onChange={(event) => setField("initialPayment", event.target.value)} />
            </FormField>
            <FormField id="discount" label="Discount" error={errors.discount}>
              <input id="discount" className="field" value={form.discount} onChange={(event) => setField("discount", event.target.value)} />
            </FormField>
            <FormField id="discount-reason" label="Discount reason" error={errors.discountReason}>
              <input id="discount-reason" className="field" value={form.discountReason} onChange={(event) => setField("discountReason", event.target.value)} />
            </FormField>
            <FormField id="grace" label="Grace period (days)" error={errors.graceDays}>
              <input id="grace" className="field" value={form.graceDays} onChange={(event) => setField("graceDays", event.target.value)} />
            </FormField>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.autoRenew} onChange={(event) => setField("autoRenew", event.target.checked)} />
              Auto-renewal
            </label>
            <p className="text-sm text-muted-foreground md:col-span-2">{preview}</p>
          </div>
        </details>
        <details className="rounded-xl border border-border bg-surface p-5">
          <summary className="cursor-pointer text-base font-semibold">Advanced</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <FormField id="static-ip" label="Static IP" error={errors.staticIp}>
              <input id="static-ip" className="field" value={form.staticIp} onChange={(event) => setField("staticIp", event.target.value)} />
            </FormField>
            <FormField id="sessions" label="Simultaneous sessions" error={errors.sessionLimit}>
              <input id="sessions" className="field" value={form.sessionLimit} onChange={(event) => setField("sessionLimit", event.target.value)} />
            </FormField>
            <FormField id="interface" label="VLAN / access interface" error={errors.accessInterface}>
              <input id="interface" className="field" value={form.accessInterface} onChange={(event) => setField("accessInterface", event.target.value)} />
            </FormField>
            <FormField id="mtu" label="MTU" error={errors.mtu}>
              <input id="mtu" className="field" value={form.mtu} onChange={(event) => setField("mtu", event.target.value)} />
            </FormField>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton type="submit" disabled={saving}>{saving ? "Saving..." : "Save & Register"}</PrimaryButton>
          <SecondaryButton type="button" disabled={saving} onClick={() => void submit(true)}>Save & Add Another</SecondaryButton>
          <SecondaryButton to={user ? clientPage(user, "/clients") : "/clients"}>Cancel</SecondaryButton>
        </div>
      </form>
    </div>
  );
}
