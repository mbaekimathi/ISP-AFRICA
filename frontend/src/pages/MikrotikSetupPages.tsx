import {
  Building2,
  Cable,
  Check,
  Globe2,
  Loader2,
  Network,
  PlugZap,
  RefreshCw,
  Router,
  Users,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { buildMikrotikSetupScript, buildRecoveryScripts, ensureCustomerServices, isPhysicalPort, loadPortUses, portUseLabels, type PortUse, type SetupWifi } from "@/lib/routerScripts";
import { backupName } from "@/lib/winboxScript";
import { WanUplinkPanel } from "@/components/mikrotik/WanUplinkPanel";

type RouterRecord = {
  name: string;
  site: string;
  role: string;
  tunnelIp: string;
  status: string;
  tunnelStatus: string;
  routerosVersion: string;
  apiReady: boolean;
  pppoeEnforced: boolean;
  hotspotEnabled: boolean;
  hotspotBlockSharing: boolean;
  portPlan?: Record<string, PortUse[]>;
};

type LivePort = {
  name: string;
  type: string;
  running: boolean;
  disabled: boolean;
  comment: string;
  slave?: boolean;
};

function useRouterRecord(deviceId: string, liveMode: false | "ports" = false) {
  const [device, setDevice] = useState<RouterRecord | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [liveInterfaces, setLiveInterfaces] = useState<LivePort[]>([]);
  const [liveMessage, setLiveMessage] = useState("");
  const [sample, setSample] = useState(false);
  const [reading, setReading] = useState(Boolean(liveMode));
  const [loaded, setLoaded] = useState(!liveMode);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    setError("");
    apiRequest<{ device: RouterRecord }>(`/api/mikrotiks/${deviceId}`, { signal: controller.signal })
      .then((body) => {
        if (!stopped) setDevice(body.device);
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "That router could not be opened.");
      });
    if (!liveMode) {
      setReading(false);
      setLoaded(true);
      return () => {
        stopped = true;
        controller.abort();
      };
    }
    setReading(true);
    const livePath = liveMode === "ports" ? `/api/mikrotiks/${deviceId}/live?view=ports` : `/api/mikrotiks/${deviceId}/live`;
    apiRequest<{ live: { message?: string; sample?: boolean; interfaces?: LivePort[] } }>(livePath, { signal: controller.signal })
      .then((body) => {
        if (stopped) return;
        const found = (body.live.interfaces ?? []).filter((item) => item.name);
        setLiveInterfaces(found);
        setInterfaces(found.map((item) => item.name));
        setSample(Boolean(body.live.sample));
        setLiveMessage(/development sample/i.test(body.live.message ?? "") ? "" : body.live.message ?? "");
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setLiveInterfaces([]);
        setInterfaces([]);
        setSample(false);
        setLiveMessage(cause instanceof Error ? cause.message : "Ports could not be read from this router.");
      })
      .finally(() => {
        if (!stopped) {
          setReading(false);
          setLoaded(true);
        }
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [deviceId, liveMode, reloadToken]);

  return { device, interfaces, liveInterfaces, liveMessage, sample, reading, loaded, error, reload: () => setReloadToken((value) => value + 1) };
}

function SetupFrame({
  title,
  description,
  wide = false,
  children,
}: {
  title: string;
  description: string;
  wide?: boolean;
  children: ReactNode;
}) {
  usePageMeta(`${title} — ISP CENTRIC`, description);
  return (
    <div className="page-shell py-8">
      <PageHeader title={title} description={description} />
      <div className={`mt-6 ${wide ? "" : "max-w-3xl"}`}>{children}</div>
    </div>
  );
}

const WRITE_GRANT = '/user group set [find where name="isp-centric-api"] policy=read,write,api,test,ftp,reboot';

function RouterWriteNotice({ note }: { note: string }) {
  const [copied, setCopied] = useState(false);
  if (!note.includes("cannot change them")) return null;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Paste this once into WinBox Terminal as admin, then try the switch again.</p>
      <pre className="overflow-x-auto rounded-xl bg-surface-muted p-4 text-xs leading-6">{WRITE_GRANT}</pre>
      <SecondaryButton
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(WRITE_GRANT).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy the update"}
      </SecondaryButton>
    </div>
  );
}

function purposeText(uses: PortUse[]) {
  return uses
    .map((use) => (use === "wan" ? "Uplink" : use === "dhcp" ? "Local network" : portUseLabels[use]))
    .join(", ");
}

type PortRoleKind = "wan" | "customer" | "dhcp";

function roleOf(uses: PortUse[]): PortRoleKind | null {
  if (uses.includes("wan")) return "wan";
  if (uses.some((use) => use === "hotspot" || use === "pppoe" || use === "static")) return "customer";
  if (uses.includes("dhcp") || uses.includes("lan")) return "dhcp";
  return null;
}

const portRoles: {
  value: PortRoleKind | "customer";
  label: string;
  hint: string;
  icon: typeof Globe2;
  selected: string;
  iconWrap: string;
}[] = [
  {
    value: "wan",
    label: "Uplink",
    hint: "Internet from the provider",
    icon: Globe2,
    selected: "border-info bg-info-soft/50 ring-2 ring-info/25 shadow-sm",
    iconWrap: "bg-info text-info-foreground",
  },
  {
    value: "customer",
    label: "Customer",
    hint: "Hotspot and PPPoE stay on; static is optional",
    icon: Users,
    selected: "border-primary bg-primary/10 ring-2 ring-primary/25 shadow-sm",
    iconWrap: "bg-primary text-primary-foreground",
  },
  {
    value: "dhcp",
    label: "Local network",
    hint: "DHCP for office devices",
    icon: Building2,
    selected: "border-success bg-success-soft/60 ring-2 ring-success/25 shadow-sm",
    iconWrap: "bg-success text-success-foreground",
  },
];

function roleAccent(role: PortRoleKind | null) {
  if (role === "wan") return "from-info via-info/70 to-accent";
  if (role === "customer") return "from-primary via-primary/75 to-brand-400";
  if (role === "dhcp") return "from-success via-success/70 to-accent";
  return "from-border via-muted to-border";
}

function roleIconWrap(role: PortRoleKind | null) {
  if (role === "wan") return "bg-info-soft text-info";
  if (role === "customer") return "bg-primary/15 text-primary";
  if (role === "dhcp") return "bg-success-soft text-success";
  return "bg-surface-muted text-muted-foreground";
}

function PortHeroStat({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone?: "default" | "ok" | "down";
}) {
  const wrap =
    tone === "ok"
      ? "bg-success/20 text-success-foreground"
      : tone === "down"
        ? "bg-destructive/20 text-destructive-foreground"
        : "bg-primary-foreground/15";
  return (
    <div className="flex items-center gap-3">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", wrap)} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="text-xs text-primary-foreground/70">{label}</p>
      </div>
    </div>
  );
}

function ScriptBox({ script, reason }: { script: string; reason: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div className="mt-5 grid gap-3">
      {reason ? <p className="notice">{reason}</p> : null}
      <pre className="overflow-x-auto rounded-xl bg-surface-muted p-4 text-xs leading-6">{script}</pre>
      <PrimaryButton
        type="button"
        disabled={Boolean(reason)}
        onClick={() => {
          navigator.clipboard.writeText(script).then(
            () => {
              setCopied(true);
              setCopyFailed(false);
            },
            () => setCopyFailed(true),
          );
        }}
      >
        {copied ? "Copied" : "Copy script"}
      </PrimaryButton>
      {copyFailed ? <p className="text-sm text-muted-foreground">Select the script above and copy it into WinBox Terminal.</p> : null}
    </div>
  );
}

type PortChoice = {
  uses: PortUse[];
};

function choiceFor(port: LivePort): PortChoice {
  const uses = (port.comment ? loadPortUses([port], {}, "").uses[port.name] : []) ?? [];
  return { uses };
}

function portLink(port: LivePort) {
  if (port.disabled) return "Disabled";
  if (port.running) return "Up";
  return "Down";
}

export function MikrotikPortPage() {
  const { deviceId = "" } = useParams();
  const { device, error, liveInterfaces, liveMessage, sample, reading, loaded, reload } = useRouterRecord(deviceId, "ports");
  const [choices, setChoices] = useState<Record<string, PortChoice>>({});
  const [savedPlan, setSavedPlan] = useState<Record<string, PortUse[]>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [password, setPassword] = useState(import.meta.env.DEV ? "Itsispcentric@001" : "");
  const [saving, setSaving] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [applyNote, setApplyNote] = useState("");
  const [applying, setApplying] = useState(false);
  const [wanOpen, setWanOpen] = useState(false);
  usePageMeta("Port setup — ISP CENTRIC", "Each port is the internet uplink, a customer connection, or the local network.");
  const ports = useMemo(
    () => liveInterfaces.filter(isPhysicalPort).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
    [liveInterfaces],
  );
  const roleKey = device?.role ?? "";
  const planKey = JSON.stringify({ ...(device?.portPlan ?? {}), ...savedPlan });
  const resolved = useMemo(
    () => loadPortUses(ports, JSON.parse(planKey) as Record<string, PortUse[]>, roleKey),
    [ports, planKey, roleKey],
  );

  useEffect(() => {
    setChoices((current) => {
      const next: Record<string, PortChoice> = {};
      for (const port of ports) {
        if (touched[port.name] && current[port.name]) {
          next[port.name] = { uses: ensureCustomerServices(current[port.name].uses) };
          continue;
        }
        next[port.name] = { uses: ensureCustomerServices(resolved.uses[port.name] ?? []) };
      }
      return next;
    });
  }, [ports, touched, resolved]);

  const selection = ports.map((port) => `${port.name}:${(choices[port.name]?.uses ?? []).join("+")}`).join("|");
  const canPush = Boolean(device?.apiReady) && ports.length > 0;
  const appliedKey = useRef("");

  useEffect(() => {
    if (!canPush || !deviceId) return;
    const recorded = ports.map((port) => ({
      iface: port.name,
      uses: ensureCustomerServices(choices[port.name]?.uses ?? []),
    }));
    const key = `${deviceId}|${recorded.map((item) => `${item.iface}:${item.uses.join("+")}`).join("|")}`;
    // Seed the baseline from the saved plan — do not push until the user changes a role.
    if (!Object.keys(touched).length) {
      appliedKey.current = key;
      return;
    }
    if (!recorded.some((item) => item.uses.length > 0)) {
      setApplying(false);
      setApplyNote("Choose what at least one port will do.");
      return;
    }
    if (key === appliedKey.current) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      setApplying(true);
      setApplyNote("Saving your choice…");
      apiRequest<{ applied: boolean; message: string; portPlan?: Record<string, PortUse[]> }>(`/api/mikrotiks/${deviceId}/ports`, {
        method: "POST",
        body: JSON.stringify({ ports: recorded }),
      })
        .then((result) => {
          if (stopped) return;
          appliedKey.current = key;
          if (result.portPlan) setSavedPlan(result.portPlan);
          setApplyNote(result.applied ? "Saved on the router." : result.message);
        })
        .catch((cause: unknown) => {
          if (!stopped) setApplyNote(cause instanceof Error ? cause.message : "That choice could not be updated.");
        })
        .finally(() => {
          if (!stopped) setApplying(false);
        });
    }, 280);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [canPush, selection, deviceId, ports, choices, touched]);

  const customerOrder = ["hotspot", "pppoe", "static"] as const;

  function chooseRole(name: string, use: PortUse | "customer") {
    setTouched((current) => ({ ...current, [name]: true }));
    setChoices((current) => ({
      ...current,
      [name]: { uses: use === "customer" ? ensureCustomerServices(["hotspot", "pppoe"]) : [use] },
    }));
  }

  function toggleCustomer(name: string, use: "hotspot" | "pppoe" | "static", checked: boolean) {
    // Hotspot and PPPoE stay locked on for customer ports; only static is optional.
    if (use === "hotspot" || use === "pppoe") return;
    setTouched((current) => ({ ...current, [name]: true }));
    setChoices((current) => {
      const previous = current[name] ?? choiceFor({ name, type: "ether", running: false, disabled: false, comment: "" });
      const kept = previous.uses.filter((item) => item === "hotspot" || item === "pppoe" || item === "static");
      const uses = ensureCustomerServices(
        customerOrder.filter((item) => (item === use ? checked : kept.includes(item))),
      );
      return { ...current, [name]: { uses } };
    });
  }

  async function saveAccess() {
    setSaving(true);
    setAccessError("");
    try {
      await apiRequest(`/api/mikrotiks/${deviceId}/access`, {
        method: "POST",
        body: JSON.stringify({ apiPassword: password }),
      });
      setPassword("");
      reload();
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : "The API password could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const upPorts = ports.filter((port) => !port.disabled && port.running);
  const downPorts = ports.filter((port) => port.disabled || !port.running);
  const assignedPorts = ports.filter((port) => (choices[port.name]?.uses ?? []).length > 0);
  const title = device?.name ? `${device.name} ports` : "Port setup";
  const applyOk = /saved on the router|updated on the router/i.test(applyNote);
  const showPortSkeleton = !loaded || (reading && ports.length === 0);

  return (
    <div className="page-shell py-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/85 to-accent text-primary-foreground shadow-card">
        <div className="network-grid absolute inset-0 opacity-30" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-10 top-6 h-40 w-40 rounded-full bg-primary-foreground/10 blur-2xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -left-8 bottom-0 h-32 w-32 rounded-full bg-accent/40 blur-2xl" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center justify-between gap-4 px-5 pb-5 pt-6 sm:px-7">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/70">
              <Cable className="h-3.5 w-3.5" aria-hidden="true" />
              Port setup
            </p>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-1 max-w-xl text-sm text-primary-foreground/75">
              {device?.site
                ? `${device.site} — assign each port as uplink, customer, or local network.`
                : "Assign each port as the internet uplink, a customer connection, or the local network."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {applying ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3.5 py-2 text-sm font-semibold backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Updating…
              </span>
            ) : applyOk ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-success/25 px-3.5 py-2 text-sm font-semibold backdrop-blur-sm">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                On router
              </span>
            ) : reading || !loaded ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3.5 py-2 text-sm font-semibold backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Reading ports…
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3.5 py-2 text-sm font-semibold backdrop-blur-sm">
                <span className="live-dot" aria-hidden="true" />
                {device?.apiReady ? "Ready" : "Waiting for API"}
              </span>
            )}
            <button
              type="button"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-primary-foreground/25 bg-primary-foreground/10 px-4 text-sm font-semibold text-primary-foreground backdrop-blur-sm transition hover:bg-primary-foreground/20 disabled:pointer-events-none disabled:opacity-60"
              disabled={reading || !device?.apiReady}
              onClick={() => {
                setTouched({});
                setApplyNote("");
                setApplying(false);
                reload();
              }}
            >
              <RefreshCw className={cn("h-4 w-4", reading && "animate-spin")} aria-hidden="true" />
              {reading ? "Reading…" : "Detect again"}
            </button>
          </div>
        </div>
        <div className="relative grid grid-cols-2 gap-x-6 gap-y-4 border-t border-primary-foreground/15 px-5 py-4 sm:grid-cols-4 sm:px-7">
          <PortHeroStat label="Ports found" value={loaded ? String(ports.length) : "—"} icon={<Network className="h-4 w-4" />} />
          <PortHeroStat
            label="Link up"
            value={loaded ? String(upPorts.length) : "—"}
            icon={<PlugZap className="h-4 w-4" />}
            tone="ok"
          />
          <PortHeroStat
            label="Link down"
            value={loaded ? String(downPorts.length) : "—"}
            icon={<Cable className="h-4 w-4" />}
            tone="down"
          />
          <PortHeroStat
            label="Roles set"
            value={loaded ? String(assignedPorts.length) : "—"}
            icon={<Router className="h-4 w-4" />}
          />
        </div>
      </section>

      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}

      {device && !device.apiReady ? (
        <form
          className="mt-6 max-w-md rounded-2xl border border-border bg-surface p-5 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAccess();
          }}
        >
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
              <Router className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold">Connect the router API</p>
              <p className="text-sm text-muted-foreground">Save the isp-centric password to read and update ports.</p>
            </div>
          </div>
          <FormField
            id="port-api-password"
            label="API password"
            hint={
              import.meta.env.DEV
                ? "Development access uses Itsispcentric@001. The user name is isp-centric."
                : "The password is only in the WinBox script from onboarding. The user name is isp-centric."
            }
          >
            <input id="port-api-password" className="field" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </FormField>
          {accessError ? <p className="mt-3 notice" role="alert">{accessError}</p> : null}
          <div className="mt-4">
            <PrimaryButton type="submit" disabled={saving || password.length < 12}>
              {saving ? "Saving access…" : "Access router"}
            </PrimaryButton>
          </div>
        </form>
      ) : null}

      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="live-dot" aria-hidden="true" />
              Detected ports
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Tap a role to assign it. Changes save automatically — nothing is pushed until you choose.
            </p>
          </div>
          {liveMessage ? <p className="max-w-sm text-sm text-muted-foreground">{liveMessage}</p> : null}
        </div>

        {showPortSkeleton ? (
          <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2" aria-busy="true" aria-live="polite">
            <p className="sr-only">Reading ports from this router…</p>
            {[0, 1, 2, 3].map((slot) => (
              <div key={slot} className="overflow-hidden rounded-2xl border border-border bg-surface-muted/30 p-4">
                <div className="flex items-center gap-3">
                  <div className="skeleton h-12 w-12 rounded-2xl" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="skeleton h-4 w-24 rounded" />
                    <div className="skeleton h-3 w-40 rounded" />
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="skeleton h-11 w-full rounded-xl" />
                  <div className="skeleton h-11 w-full rounded-xl" />
                  <div className="skeleton h-11 w-full rounded-xl" />
                </div>
              </div>
            ))}
            <p className="col-span-full flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              Reading ports from the router…
            </p>
          </div>
        ) : ports.length === 0 ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">No ethernet or SFP ports were returned.</p>
        ) : (
          <>
            <div className="grid gap-3 border-b border-border bg-surface-muted/40 px-5 py-4 sm:grid-cols-2">
              <div className="relative overflow-hidden rounded-xl border border-success-border/50 bg-success-soft/40 px-4 py-3">
                {upPorts.length > 0 ? <div className="port-link-flow absolute inset-x-0 bottom-0 h-1" aria-hidden="true" /> : null}
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-success">
                  <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
                  Up
                </p>
                <p className="mt-1 text-sm font-medium">{upPorts.map((port) => port.name).join(", ") || "None"}</p>
              </div>
              <div className="rounded-xl border border-destructive-border/40 bg-destructive-soft/35 px-4 py-3">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-destructive">
                  <Cable className="h-3.5 w-3.5" aria-hidden="true" />
                  Down
                </p>
                <p className="mt-1 text-sm font-medium">{downPorts.map((port) => port.name).join(", ") || "None"}</p>
              </div>
            </div>

            <ul className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
              {ports.map((port, index) => {
                const choice = choices[port.name] ?? choiceFor(port);
                const link = portLink(port);
                const remembered = resolved.saved[port.name];
                const purpose = purposeText(choice.uses);
                const activeRole = roleOf(choice.uses);
                const RoleGlyph = activeRole === "wan" ? Globe2 : activeRole === "customer" ? Users : activeRole === "dhcp" ? Building2 : Cable;
                return (
                  <li
                    key={port.name}
                    className="port-rise relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-surface to-surface-muted/40 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-md"
                    style={{ animationDelay: `${Math.min(index, 10) * 55}ms` }}
                  >
                    <div className={cn("absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b", roleAccent(activeRole))} aria-hidden="true" />
                    {link === "Up" ? <div className="port-link-flow absolute inset-x-0 top-0 h-0.5" aria-hidden="true" /> : null}
                    <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className={cn(
                            "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition",
                            roleIconWrap(activeRole),
                          )}
                          aria-hidden="true"
                        >
                          <RoleGlyph className="h-5 w-5" />
                          {link === "Up" ? (
                            <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface">
                              <span className="live-dot" />
                            </span>
                          ) : null}
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold tracking-tight">{port.name}</p>
                          <p className="mt-0.5 text-sm text-foreground/90">{purpose || "Not set"}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {remembered && purpose ? "Saved use" : "Not saved yet"}
                            {port.slave ? " · In a bridge" : ""}
                            {port.type ? ` · ${port.type}` : ""}
                          </p>
                        </div>
                      </div>
                      <StatusBadge tone={link === "Up" ? "active" : link === "Down" ? "due" : "paused"}>{link}</StatusBadge>
                    </div>

                    <fieldset className="border-t border-border/80 px-4 py-4 sm:px-5" disabled={applying}>
                      <legend className="sr-only">What {port.name} does</legend>
                      <div className="grid gap-2">
                        {portRoles.map((role) => {
                          const customerUse = choice.uses.find((use) => use === "hotspot" || use === "pppoe" || use === "static");
                          const selected = role.value === "customer" ? Boolean(customerUse) : choice.uses.includes(role.value);
                          const Icon = role.icon;
                          return (
                            <div key={role.value}>
                              <label
                                className={cn(
                                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition duration-200",
                                  selected ? role.selected : "border-border bg-surface hover:border-primary/30 hover:bg-primary/5",
                                )}
                              >
                                <input
                                  type="radio"
                                  className="sr-only"
                                  name={`port-role-${port.name}`}
                                  checked={selected}
                                  onChange={() => chooseRole(port.name, role.value === "customer" ? "customer" : role.value)}
                                />
                                <span
                                  className={cn(
                                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition",
                                    selected ? role.iconWrap : "bg-surface-muted text-muted-foreground",
                                  )}
                                  aria-hidden="true"
                                >
                                  <Icon className="h-4 w-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="font-medium">{role.label}</span>
                                  <span className="mt-0.5 block text-xs text-muted-foreground">{role.hint}</span>
                                </span>
                                {selected ? (
                                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface text-primary shadow-sm" aria-hidden="true">
                                    <Check className="h-3.5 w-3.5" />
                                  </span>
                                ) : null}
                              </label>
                              {role.value === "customer" && selected ? (
                                <div className="mt-2 ml-1 flex flex-wrap gap-2">
                                  {customerOrder.map((use) => {
                                    const locked = use === "hotspot" || use === "pppoe";
                                    const ServiceIcon = use === "hotspot" ? Wifi : use === "pppoe" ? PlugZap : Network;
                                    return (
                                      <label
                                        key={use}
                                        className={cn(
                                          "flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm transition",
                                          choice.uses.includes(use) || locked
                                            ? "border-primary/40 bg-primary/5 text-foreground"
                                            : "border-border bg-surface text-muted-foreground",
                                          locked ? "cursor-default opacity-90" : "cursor-pointer hover:border-primary/30",
                                        )}
                                      >
                                        <input
                                          type="checkbox"
                                          className="sr-only"
                                          checked={choice.uses.includes(use) || locked}
                                          disabled={locked}
                                          onChange={(event) => toggleCustomer(port.name, use, event.target.checked)}
                                        />
                                        <ServiceIcon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                                        {portUseLabels[use]}
                                        {locked ? <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">on</span> : null}
                                      </label>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {applyNote ? (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground">
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
            ) : applyOk ? (
              <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            ) : (
              <Cable className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
            )}
            {applying ? "Updating the router…" : applyNote}
          </div>
        ) : null}
        {applyNote && !applying ? (
          <div className="border-t border-border px-5 py-4">
            <RouterWriteNotice note={applyNote} />
          </div>
        ) : null}
      </section>

      <div className="mt-6">
        {wanOpen ? (
          <WanUplinkPanel
            deviceId={deviceId}
            version={device?.routerosVersion || ""}
            ports={ports.map((port) => ({ name: port.name, running: port.running, disabled: port.disabled }))}
            sample={sample}
            deferReachability
          />
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left shadow-sm transition hover:border-primary/30 hover:bg-primary/5"
            onClick={() => setWanOpen(true)}
            disabled={!loaded || !device?.apiReady}
          >
            <span>
              <span className="flex items-center gap-2 font-semibold">
                <Globe2 className="h-4 w-4 text-info" aria-hidden="true" />
                WAN uplink settings
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Open when you need provider details, failover, or to switch the active uplink.
              </span>
            </span>
            <span className="text-sm font-semibold text-primary">Open</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function MikrotikPppoePage() {
  const { deviceId = "" } = useParams();
  const { device, error } = useRouterRecord(deviceId);
  const [enforced, setEnforced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const requestId = useRef(0);
  useEffect(() => {
    if (device) setEnforced(device.pppoeEnforced);
  }, [device]);

  function toggleEnforcement() {
    if (!device || saving) return;
    const next = !enforced;
    const previous = enforced;
    const mine = ++requestId.current;
    setEnforced(next);
    setSaving(true);
    setNote("Updating the router…");
    apiRequest<{ device: RouterRecord; applied: boolean; message: string }>(`/api/mikrotiks/${deviceId}/pppoe`, {
      method: "POST",
      body: JSON.stringify({ enforced: next, push: true }),
    })
      .then((body) => {
        if (requestId.current !== mine) return;
        if (!body.applied) {
          setEnforced(previous);
          setNote(body.message || "The router was not changed.");
          return;
        }
        setEnforced(body.device.pppoeEnforced);
        setNote("Updated on the router.");
      })
      .catch((cause: unknown) => {
        if (requestId.current !== mine) return;
        setEnforced(previous);
        setNote(cause instanceof Error ? cause.message : "PPPoE enforcement could not be updated.");
      })
      .finally(() => {
        if (requestId.current === mine) setSaving(false);
      });
  }

  return (
    <SetupFrame title="PPPoE setup" description="Turn PPPoE enforcement on to require a PPPoE login, or off to let clients use the internet with DHCP.">
      {error ? <p className="mb-4 notice" role="alert">{error}</p> : null}
      <div className="grid gap-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <div>
            <p id="pppoe-enforcement-label" className="text-sm font-medium">
              PPPoE enforcement
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {enforced
                ? "On. Only a PPPoE login that dialed successfully and still has an active subscription can use the internet."
                : "Off. Clients receive DHCP and can use the internet without a PPPoE login."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            id="pppoe-enforcement"
            aria-labelledby="pppoe-enforcement-label"
            aria-checked={enforced}
            disabled={saving || !device}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${enforced ? "bg-primary" : "bg-surface-muted"} border border-border disabled:opacity-60`}
            onClick={toggleEnforcement}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow ${enforced ? "left-6" : "left-0.5"}`} />
            <span className="sr-only">{enforced ? "On" : "Off"}</span>
          </button>
        </div>
        <p id="pppoe-apply-note" className="text-sm text-muted-foreground">
          {saving ? "Updating the router…" : note || "Click the switch to turn enforcement on or off. The router is updated to match."}
        </p>
        {note && !saving ? <RouterWriteNotice note={note} /> : null}
      </div>
      <PortalPagePreviews
        deviceId={deviceId}
        kind="pppoe"
        title="PPPoE pay pages"
        description="What a customer sees when the router sends their browsing to the portal — from the recharge page to the thank-you receipt. Packages, prices, and payment details are this account's real setup; the customer is a sample."
      />
    </SetupFrame>
  );
}

type PortalPagePreview = {
  id: string;
  name: string;
  title: string;
  description: string;
  html: string;
};

function PortalPagePreviews({
  deviceId,
  kind,
  title,
  description,
}: {
  deviceId: string;
  kind: "hotspot" | "pppoe";
  title: string;
  description: string;
}) {
  const [pages, setPages] = useState<PortalPagePreview[]>([]);
  const [activePage, setActivePage] = useState("");
  const [pagesNote, setPagesNote] = useState("Loading page previews…");

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    apiRequest<{ pages: PortalPagePreview[] }>(`/api/mikrotiks/${deviceId}/${kind}/pages`, { signal: controller.signal })
      .then((body) => {
        if (stopped) return;
        setPages(body.pages);
        setActivePage(body.pages[0]?.id ?? "");
        setPagesNote(body.pages.length ? "" : `No ${kind} pages are available for this router.`);
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setPages([]);
        setPagesNote(cause instanceof Error ? cause.message : `The ${kind} pages could not be loaded.`);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [deviceId, kind]);

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {pagesNote ? <p className="mt-3 text-sm text-muted-foreground">{pagesNote}</p> : null}
      {pages.length > 0 ? (
        <>
          <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label={`${title} previews`}>
            {pages.map((preview) => (
              <button
                key={preview.id}
                type="button"
                role="tab"
                aria-selected={activePage === preview.id}
                className={`min-h-11 rounded-lg border px-3 text-sm font-medium transition ${
                  activePage === preview.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-surface text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActivePage(preview.id)}
              >
                {preview.title}
              </button>
            ))}
          </div>
          {pages
            .filter((preview) => preview.id === activePage)
            .map((preview) => (
              <div key={preview.id} className="mt-4">
                <p className="text-sm text-muted-foreground">
                  {preview.description} <span className="text-xs">({preview.name})</span>
                </p>
                <div className="mt-3 flex justify-center rounded-xl border border-border bg-sidebar p-3">
                  <iframe
                    title={`${preview.title} preview`}
                    srcDoc={preview.html}
                    sandbox="allow-scripts"
                    className="h-[560px] w-full max-w-[430px] rounded-lg border-0 bg-sidebar"
                  />
                </div>
              </div>
            ))}
        </>
      ) : null}
    </section>
  );
}

export function MikrotikHotspotPage() {
  const { deviceId = "" } = useParams();
  const { device, error } = useRouterRecord(deviceId);
  const [enabled, setEnabled] = useState(false);
  const [blockSharing, setBlockSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const requestId = useRef(0);
  useEffect(() => {
    if (device) {
      setEnabled(device.hotspotEnabled);
      setBlockSharing(Boolean(device.hotspotBlockSharing));
    }
  }, [device]);

  function saveHotspot(nextEnabled: boolean, nextBlock: boolean) {
    if (!device || saving) return;
    const previous = enabled;
    const previousBlock = blockSharing;
    const mine = ++requestId.current;
    setEnabled(nextEnabled);
    setBlockSharing(nextBlock);
    setSaving(true);
    setNote("Updating the router…");
    apiRequest<{ device: RouterRecord; applied: boolean; message: string }>(`/api/mikrotiks/${deviceId}/hotspot`, {
      method: "POST",
      body: JSON.stringify({ enabled: nextEnabled, blockSharing: nextBlock, push: true }),
    })
      .then((body) => {
        if (requestId.current !== mine) return;
        if (!body.applied) {
          setEnabled(previous);
          setBlockSharing(previousBlock);
          setNote(body.message || "The router was not changed.");
          return;
        }
        setEnabled(body.device.hotspotEnabled);
        setBlockSharing(Boolean(body.device.hotspotBlockSharing));
        setNote(body.message || "Updated on the router.");
      })
      .catch((cause: unknown) => {
        if (requestId.current !== mine) return;
        setEnabled(previous);
        setBlockSharing(previousBlock);
        setNote(cause instanceof Error ? cause.message : "The hotspot setting could not be updated.");
      })
      .finally(() => {
        if (requestId.current === mine) setSaving(false);
      });
  }

  function toggleHotspot() {
    saveHotspot(!enabled, blockSharing);
  }

  function toggleSharing() {
    saveHotspot(enabled, !blockSharing);
  }

  return (
    <SetupFrame title="Hotspot setup" description="Turn the hotspot on so connected users can reach it, or off so they cannot reach the hotspot or the internet.">
      {error ? <p className="mb-4 notice" role="alert">{error}</p> : null}
      <div className="grid gap-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <div>
            <p id="hotspot-access-label" className="text-sm font-medium">
              Hotspot access
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {enabled
                ? "On. People who connect can open the hotspot."
                : "Off. People who connect cannot open the hotspot or use the internet."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            id="hotspot-access"
            aria-labelledby="hotspot-access-label"
            aria-checked={enabled}
            disabled={saving || !device}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${enabled ? "bg-primary" : "bg-surface-muted"} border border-border disabled:opacity-60`}
            onClick={toggleHotspot}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow ${enabled ? "left-6" : "left-0.5"}`} />
            <span className="sr-only">{enabled ? "On" : "Off"}</span>
          </button>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <div>
            <p id="hotspot-sharing-label" className="text-sm font-medium">
              Block sharing
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {blockSharing
                ? "On. A paid phone or laptop can surf, but it cannot pass the connection to another Wi-Fi router or a tethered device."
                : "Off. A paid device can share its connection through its own Wi-Fi router or phone hotspot."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            id="hotspot-sharing"
            aria-labelledby="hotspot-sharing-label"
            aria-checked={blockSharing}
            disabled={saving || !device || !enabled}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${blockSharing ? "bg-primary" : "bg-surface-muted"} border border-border disabled:opacity-60`}
            onClick={toggleSharing}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow ${blockSharing ? "left-6" : "left-0.5"}`} />
            <span className="sr-only">{blockSharing ? "On" : "Off"}</span>
          </button>
        </div>
        <p id="hotspot-apply-note" className="text-sm text-muted-foreground">
          {saving ? "Updating the router…" : note || "Click the switch to turn the hotspot on or off. The router is updated to match."}
        </p>
        {note && !saving ? <RouterWriteNotice note={note} /> : null}
      </div>
      <PortalPagePreviews
        deviceId={deviceId}
        kind="hotspot"
        title="Hotspot pages"
        description="What a guest sees on this router, from the sign-in screen to the thank-you receipt. Bundles, prices, and payment details are this account's real setup; the guest and vouchers are samples."
      />
    </SetupFrame>
  );
}

type SetupService = { name: string; port: string; disabled: boolean; address: string };
type SetupUser = { name: string; group: string; disabled: boolean };
type SetupRadio = {
  name: string;
  ssid: string;
  password: string;
  passwordVisible: boolean;
  disabled: boolean;
  security: string;
  kind: SetupWifi["kind"];
};

type RouterSetup = {
  reachable?: boolean;
  sample?: boolean;
  message?: string;
  identity?: string;
  dns?: string;
  ntpEnabled?: boolean | null;
  services?: SetupService[];
  users?: SetupUser[];
  wifi?: SetupRadio[];
  managementUser?: string;
  managementPassword?: string;
};

function SecretField({
  id,
  label,
  hint,
  value,
  onChange,
  maxLength,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <FormField id={id} label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          id={id}
          className="field"
          type={visible ? "text" : "password"}
          autoComplete="off"
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
        <SecondaryButton type="button" onClick={() => setVisible((current) => !current)}>
          {visible ? "Hide" : "Show"}
        </SecondaryButton>
      </div>
    </FormField>
  );
}

export function MikrotikRouterSetupPage() {
  const { deviceId = "" } = useParams();
  const { device, error, reload } = useRouterRecord(deviceId);
  const [seeded, setSeeded] = useState(false);
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [routerIdentity, setRouterIdentity] = useState("");
  const [dns, setDns] = useState("");
  const [setupMessage, setSetupMessage] = useState("");
  const [services, setServices] = useState<SetupService[]>([]);
  const [wifi, setWifi] = useState<SetupRadio[]>([]);
  const [wifiBaseline, setWifiBaseline] = useState<SetupRadio[]>([]);
  const [winboxPassword, setWinboxPassword] = useState("");
  const [savedPassword, setSavedPassword] = useState("");
  const [fetchedPassword, setFetchedPassword] = useState("");
  const [readingSetup, setReadingSetup] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState("");

  useEffect(() => {
    if (!device || seeded) return;
    setName(device.name);
    setSite(device.site);
    setSeeded(true);
  }, [device, seeded]);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    setReadingSetup(true);
    apiRequest<{ setup: RouterSetup }>(`/api/mikrotiks/${deviceId}/setup`, { signal: controller.signal })
      .then((body) => {
        if (stopped) return;
        const setup = body.setup;
        const radios = setup.wifi ?? [];
        const managementPassword = setup.managementPassword ?? "";
        setRouterIdentity(setup.identity || "");
        setDns(setup.dns || "");
        setServices(setup.services ?? []);
        setWifi(radios);
        setWifiBaseline(radios);
        setSavedPassword(managementPassword);
        setFetchedPassword(managementPassword);
        setWinboxPassword(managementPassword);
        setSetupMessage(/development sample/i.test(setup.message || "") ? "" : setup.message || "");
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setSetupMessage(cause instanceof Error ? cause.message : "This router could not be read.");
      })
      .finally(() => {
        if (!stopped) setReadingSetup(false);
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [deviceId]);

  const changedWifi = wifi
    .filter((radio) => {
      if (radio.disabled) return false;
      const original = wifiBaseline.find((item) => item.name === radio.name);
      if (!original || original.disabled) return false;
      return radio.ssid !== original.ssid || radio.password !== original.password;
    })
    .map((radio) => ({ ...radio, enabled: true, kind: radio.kind === "wireless" ? "wireless" as const : "wifi" as const }));
  const recordedName = routerIdentity || device?.name || "";
  const identity = name.trim() && name.trim() !== recordedName ? name.trim() : "";
  const passwordChanged = winboxPassword !== fetchedPassword;
  const built = buildMikrotikSetupScript({
    identity,
    wifi: changedWifi,
    winboxUser: passwordChanged ? { currentName: "isp-centric", name: "isp-centric", password: winboxPassword } : undefined,
  });
  const detailsChanged = seeded && (name.trim() !== (device?.name ?? "") || site.trim() !== (device?.site ?? ""));

  return (
    <SetupFrame title="MikroTik setup" description="Read from this router. You can change the registered name, location, Winbox password, and the name and password of WiFi that is already on.">
      {error ? <p className="mb-4 notice" role="alert">{error}</p> : null}
      {device ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Tunnel {device.tunnelIp} ({device.tunnelStatus}) · RouterOS {device.routerosVersion || "unknown"}
        </p>
      ) : null}
      {readingSetup ? <p className="mb-4 text-sm text-muted-foreground">Reading this router…</p> : null}
      {setupMessage ? <p className="mb-4 text-sm text-muted-foreground">{setupMessage}</p> : null}
      <div className="grid gap-4 rounded-xl border border-border bg-surface p-5">
        <FormField id="setup-name" label="Name" hint="This is the name recorded for this router. A change also updates the router identity when you paste the script.">
          <input id="setup-name" className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FormField id="setup-site" label="Location">
          <input id="setup-site" className="field" value={site} maxLength={80} onChange={(event) => setSite(event.target.value)} />
        </FormField>
        <div className="flex flex-wrap items-center gap-3">
          <SecondaryButton
            type="button"
            disabled={saving || !detailsChanged}
            onClick={() => {
              setSaving(true);
              setSaveNote("");
              apiRequest(`/api/mikrotiks/${deviceId}/details`, {
                method: "POST",
                body: JSON.stringify({ name: name.trim(), site: site.trim() }),
              })
                .then(() => {
                  setSaveNote("Name and location saved.");
                  reload();
                })
                .catch((cause: unknown) => {
                  setSaveNote(cause instanceof Error ? cause.message : "Those details could not be saved.");
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Saving…" : "Save name and location"}
          </SecondaryButton>
          {saveNote ? <p className="text-sm text-muted-foreground">{saveNote}</p> : null}
        </div>
        {dns ? (
          <p className="text-sm text-muted-foreground">DNS stays {dns}. It is not a registered detail, so it is left unchanged.</p>
        ) : null}
      </div>

      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">WiFi</h2>
        {wifi.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">This router did not report a WiFi interface.</p> : null}
        <div className="mt-4 grid gap-4">
          {wifi.map((radio, index) => (
            <div key={radio.name} className="rounded-xl border border-border p-4">
              <p className="text-sm font-medium">
                {radio.name} · {radio.disabled ? "Off" : "On"}
              </p>
              {radio.disabled ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {radio.ssid ? `${radio.ssid} is off, so its name and password stay as they are.` : "WiFi is off on this interface, so its name and password stay as they are."}
                </p>
              ) : (
                <div className="mt-4 grid gap-4">
                  <FormField id={`wifi-ssid-${radio.name}`} label="WiFi name">
                    <input
                      id={`wifi-ssid-${radio.name}`}
                      className="field"
                      value={radio.ssid}
                      maxLength={32}
                      onChange={(event) =>
                        setWifi((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ssid: event.target.value } : item)))
                      }
                    />
                  </FormField>
                  <SecretField
                    id={`wifi-password-${radio.name}`}
                    label="WiFi password"
                    hint={radio.passwordVisible ? "Shown as read from this router." : "The router did not return this password. Enter a new one to replace it."}
                    value={radio.password}
                    maxLength={63}
                    onChange={(value) => setWifi((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, password: value } : item)))}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Winbox password</h2>
        <p className="mt-2 text-sm text-muted-foreground">The registered Winbox user is isp-centric. Other router users stay as they are.</p>
        <div className="mt-4 grid gap-4">
          <FormField id="winbox-name" label="User name">
            <input id="winbox-name" className="field" value="isp-centric" readOnly />
          </FormField>
          <SecretField
            id="winbox-password"
            label="Password"
            hint="Saved for this router. Change it here, save it for this app, then paste the script so the router matches."
            value={winboxPassword}
            maxLength={64}
            onChange={setWinboxPassword}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SecondaryButton
              type="button"
              disabled={saving || winboxPassword === savedPassword}
              onClick={() => {
                setSaving(true);
                setSaveNote("");
                apiRequest(`/api/mikrotiks/${deviceId}/access`, {
                  method: "POST",
                  body: JSON.stringify({ apiPassword: winboxPassword }),
                })
                  .then(() => {
                    setSavedPassword(winboxPassword);
                    setSaveNote("Password saved for this app. Paste the script so the router uses it too.");
                  })
                  .catch((cause: unknown) => {
                    setSaveNote(cause instanceof Error ? cause.message : "That password could not be saved.");
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? "Saving…" : "Save password for this app"}
            </SecondaryButton>
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Services</h2>
        <p className="mt-2 text-sm text-muted-foreground">These stay as they are on the router.</p>
        {services.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No services were read from this router.</p> : null}
        {services.length > 0 ? (
          <ul className="mt-3 grid gap-2 text-sm">
            {services.map((service) => (
              <li key={service.name}>
                {service.name} · port {service.port || "unknown"} · {service.disabled ? "disabled" : "enabled"}
                {service.address ? ` · ${service.address}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Apply on the router</h2>
        <p className="mt-2 text-sm text-muted-foreground">The script includes only a changed name, a changed WiFi name or password on a radio that is on, and a changed isp-centric password.</p>
        <ScriptBox script={built.script} reason={built.applicable ? "" : built.reason} />
      </div>
    </SetupFrame>
  );
}

export function MikrotikRecoveryPage() {
  const { deviceId = "" } = useParams();
  const { device, error } = useRouterRecord(deviceId);
  const [password, setPassword] = useState("");
  const backup = device ? backupName(device.name) : "";
  const built = buildRecoveryScripts({ backup, password });
  return (
    <SetupFrame
      title="WinBox recovery"
      description="If WinBox still opens from the same LAN, use the MAC address, paste the script you need, and press Enter. The restore script reboots the router from the onboarding backup."
    >
      {error ? <p className="mb-4 notice" role="alert">{error}</p> : null}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Restore the onboarding backup</h2>
        <p className="mt-2 text-sm text-muted-foreground">This loads {backup || "the saved backup"} and restarts the router.</p>
        <ScriptBox script={built.restore.script} reason={built.restore.applicable ? "" : built.restore.reason} />
      </section>
      <section className="mt-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Restore API access and WinBox on the tunnel</h2>
        <p className="mt-2 text-sm text-muted-foreground">WinBox stays limited to the isp-centric management interface. It is not opened to the public internet.</p>
        <div className="mt-4">
          <FormField id="recovery-password" label="API password" hint="The same password from the onboarding script. The user name is isp-centric.">
            <input id="recovery-password" className="field" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </FormField>
        </div>
        <ScriptBox script={built.access.script} reason={built.access.applicable ? "" : built.access.reason} />
      </section>
    </SetupFrame>
  );
}
