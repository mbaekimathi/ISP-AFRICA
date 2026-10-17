import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TunnelNotification } from "@/components/ui/TunnelNotification";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { buildMikrotikSetupScript, buildRecoveryScripts, isPhysicalPort, loadPortUses, portUseLabels, type PortUse, type SetupWifi } from "@/lib/routerScripts";
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

function useRouterRecord(deviceId: string) {
  const [device, setDevice] = useState<RouterRecord | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [liveInterfaces, setLiveInterfaces] = useState<LivePort[]>([]);
  const [liveMessage, setLiveMessage] = useState("");
  const [sample, setSample] = useState(false);
  const [reading, setReading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    setReading(true);
    apiRequest<{ device: RouterRecord }>(`/api/mikrotiks/${deviceId}`, { signal: controller.signal })
      .then((body) => {
        if (!stopped) setDevice(body.device);
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "That router could not be opened.");
      });
    apiRequest<{ live: { message?: string; sample?: boolean; interfaces?: LivePort[] } }>(`/api/mikrotiks/${deviceId}/live`, { signal: controller.signal })
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
  }, [deviceId, reloadToken]);

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
      <div className={wide ? "" : "max-w-3xl"}>{children}</div>
    </div>
  );
}

const WRITE_GRANT = '/user group set [find where name="isp-centric-api"] policy=read,write,api,test';

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

function ScriptBox({ script, reason }: { script: string; reason: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div className="mt-5 grid gap-3">
      {reason ? <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">{reason}</p> : null}
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
  const { device, error, liveInterfaces, liveMessage, sample, reading, loaded, reload } = useRouterRecord(deviceId);
  const [choices, setChoices] = useState<Record<string, PortChoice>>({});
  const [savedPlan, setSavedPlan] = useState<Record<string, PortUse[]>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [password, setPassword] = useState(import.meta.env.DEV ? "Itsispcentric@001" : "");
  const [saving, setSaving] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [applyNote, setApplyNote] = useState("");
  const [applying, setApplying] = useState(false);
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
          next[port.name] = current[port.name];
          continue;
        }
        next[port.name] = { uses: resolved.uses[port.name] ?? [] };
      }
      return next;
    });
  }, [ports, touched, resolved]);

  const selection = ports.map((port) => `${port.name}:${(choices[port.name]?.uses ?? []).join("+")}`).join("|");
  const userChanged = Object.values(touched).some(Boolean);

  useEffect(() => {
    if (!userChanged || !deviceId || ports.length === 0) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      const recorded = ports.map((port) => ({
        iface: port.name,
        uses: choices[port.name]?.uses ?? [],
      }));
      if (!recorded.some((item) => item.uses.length > 0)) {
        setApplying(false);
        setApplyNote("Choose what at least one port will do.");
        return;
      }
      setApplying(true);
      setApplyNote("Updating the router...");
      apiRequest<{ applied: boolean; message: string; portPlan?: Record<string, PortUse[]> }>(`/api/mikrotiks/${deviceId}/ports`, {
        method: "POST",
        body: JSON.stringify({ ports: recorded }),
      })
        .then((result) => {
          if (stopped) return;
          if (result.applied && result.portPlan) setSavedPlan(result.portPlan);
          setApplyNote(result.applied ? "Updated on the router." : result.message);
        })
        .catch((cause: unknown) => {
          if (!stopped) setApplyNote(cause instanceof Error ? cause.message : "That choice could not be updated.");
        })
        .finally(() => {
          if (!stopped) setApplying(false);
        });
    }, 400);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [userChanged, selection, deviceId]);

  const customerOrder = ["hotspot", "pppoe", "static"] as const;

  function chooseRole(name: string, use: PortUse) {
    setTouched((current) => ({ ...current, [name]: true }));
    setChoices((current) => ({ ...current, [name]: { uses: [use] } }));
  }

  function toggleCustomer(name: string, use: "hotspot" | "pppoe" | "static", checked: boolean) {
    setTouched((current) => ({ ...current, [name]: true }));
    setChoices((current) => {
      const previous = current[name] ?? choiceFor({ name, type: "ether", running: false, disabled: false, comment: "" });
      const kept = previous.uses.filter((item) => item === "hotspot" || item === "pppoe" || item === "static");
      const uses = customerOrder.filter((item) => (item === use ? checked : kept.includes(item)));
      if (uses.length === 0) return current;
      return { ...current, [name]: { uses: [...uses] } };
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

  return (
    <SetupFrame wide title="Port setup" description="Each port is the internet uplink, a customer connection, or the local network.">
      {error ? <p className="mb-4 text-sm text-warning">{error}</p> : null}
      {device && !device.apiReady ? (
        <form
          className="mb-4 max-w-md rounded-xl border border-border bg-surface p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAccess();
          }}
        >
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
          {accessError ? <p className="mt-3 text-sm text-warning">{accessError}</p> : null}
          <div className="mt-4">
            <PrimaryButton type="submit" disabled={saving || password.length < 12}>
              {saving ? "Saving access..." : "Access router"}
            </PrimaryButton>
          </div>
        </form>
      ) : null}
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Detected ports</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose what each port does. Addresses and services are filled in and sent to the router.
            </p>
          </div>
          <SecondaryButton type="button" disabled={reading || !device?.apiReady} onClick={reload}>
            {reading ? "Reading ports..." : "Detect again"}
          </SecondaryButton>
        </div>
        {liveMessage ? <p className="mt-3 text-sm text-muted-foreground">{liveMessage}</p> : null}
        {!loaded || (reading && ports.length === 0) ? (
          <p className="mt-4 text-sm text-muted-foreground">Reading ports from this router.</p>
        ) : ports.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No ethernet or SFP ports were returned.</p>
        ) : (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-border px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">Up</p>
                <p className="mt-1 text-sm">{ports.filter((port) => !port.disabled && port.running).map((port) => port.name).join(", ") || "None"}</p>
              </div>
              <div className="rounded-xl border border-border px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">Down</p>
                <p className="mt-1 text-sm">{ports.filter((port) => port.disabled || !port.running).map((port) => port.name).join(", ") || "None"}</p>
              </div>
            </div>
            <ul className="mt-4 grid gap-3">
            {ports.map((port) => {
              const choice = choices[port.name] ?? choiceFor(port);
              const link = portLink(port);
              const remembered = resolved.saved[port.name];
              const purpose = purposeText(choice.uses);
              return (
                <li key={port.name} className="rounded-xl border border-border px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{port.name}</p>
                      <p className="mt-1 text-sm">{purpose || "Not set"}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {remembered && purpose ? "Saved use" : "Not saved yet"}
                        {port.slave ? " · In a bridge" : ""}
                      </p>
                    </div>
                    <StatusBadge tone={link === "Up" ? "active" : link === "Down" ? "due" : "paused"}>{link}</StatusBadge>
                  </div>
                  <fieldset className="mt-3" disabled={applying}>
                    <legend className="text-xs font-medium text-muted-foreground">What this port does</legend>
                    <div className="mt-2 grid gap-2">
                      {(
                        [
                          ["wan", "Uplink", "Internet"],
                          ["customer", "Customer", "Hotspot, PPPoE, and static can be combined"],
                          ["dhcp", "Local network", "DHCP for office devices"],
                        ] as const
                      ).map(([value, label, hint]) => {
                        const customerUse = choice.uses.find((use) => use === "hotspot" || use === "pppoe" || use === "static");
                        const selected = value === "customer" ? Boolean(customerUse) : choice.uses.includes(value);
                        return (
                          <div key={value} className="rounded-lg border border-border px-3 py-2">
                            <label className="flex min-h-11 items-center gap-2 text-sm">
                              <input
                                type="radio"
                                name={`port-role-${port.name}`}
                                checked={selected}
                                onChange={() => chooseRole(port.name, value === "customer" ? customerUse ?? "hotspot" : value)}
                              />
                              <span>
                                <span className="font-medium">{label}</span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                              </span>
                            </label>
                            {value === "customer" && selected ? (
                              <div className="mb-2 ml-6 flex flex-wrap gap-2">
                                {customerOrder.map((use) => (
                                  <label key={use} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={choice.uses.includes(use)}
                                      onChange={(event) => toggleCustomer(port.name, use, event.target.checked)}
                                    />
                                    {portUseLabels[use]}
                                  </label>
                                ))}
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
        {applyNote ? <p className="mt-4 text-sm text-muted-foreground">{applying ? "Updating the router..." : applyNote}</p> : null}
        {applyNote && !applying ? <RouterWriteNotice note={applyNote} /> : null}
      </div>
      <WanUplinkPanel
        deviceId={deviceId}
        version={device?.routerosVersion || ""}
        ports={ports.map((port) => ({ name: port.name, running: port.running, disabled: port.disabled }))}
        sample={sample}
      />
    </SetupFrame>
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
    setNote("Updating the router...");
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
      {error ? <p className="mb-4 text-sm text-warning">{error}</p> : null}
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
          {saving ? "Updating the router..." : note || "Click the switch to turn enforcement on or off. The router is updated to match."}
        </p>
        {note && !saving ? <RouterWriteNotice note={note} /> : null}
      </div>
    </SetupFrame>
  );
}

export function MikrotikHotspotPage() {
  const { deviceId = "" } = useParams();
  const { device, error } = useRouterRecord(deviceId);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const requestId = useRef(0);
  useEffect(() => {
    if (device) setEnabled(device.hotspotEnabled);
  }, [device]);

  function toggleHotspot() {
    if (!device || saving) return;
    const next = !enabled;
    const previous = enabled;
    const mine = ++requestId.current;
    setEnabled(next);
    setSaving(true);
    setNote("Updating the router...");
    apiRequest<{ device: RouterRecord; applied: boolean; message: string }>(`/api/mikrotiks/${deviceId}/hotspot`, {
      method: "POST",
      body: JSON.stringify({ enabled: next, push: true }),
    })
      .then((body) => {
        if (requestId.current !== mine) return;
        if (!body.applied) {
          setEnabled(previous);
          setNote(body.message || "The router was not changed.");
          return;
        }
        setEnabled(body.device.hotspotEnabled);
        setNote("Updated on the router.");
      })
      .catch((cause: unknown) => {
        if (requestId.current !== mine) return;
        setEnabled(previous);
        setNote(cause instanceof Error ? cause.message : "The hotspot setting could not be updated.");
      })
      .finally(() => {
        if (requestId.current === mine) setSaving(false);
      });
  }

  return (
    <SetupFrame title="Hotspot setup" description="Turn the hotspot on so connected users can reach it, or off so they cannot reach the hotspot or the internet.">
      {error ? <p className="mb-4 text-sm text-warning">{error}</p> : null}
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
        <p id="hotspot-apply-note" className="text-sm text-muted-foreground">
          {saving ? "Updating the router..." : note || "Click the switch to turn the hotspot on or off. The router is updated to match."}
        </p>
        {note && !saving ? <RouterWriteNotice note={note} /> : null}
      </div>
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
  const tunnelStatus = device?.tunnelStatus === "up" ? "up" : device?.tunnelStatus === "down" ? "down" : "unknown";

  return (
    <SetupFrame title="MikroTik setup" description="Read from this router. You can change the registered name, location, Winbox password, and the name and password of WiFi that is already on.">
      {device ? (
        <TunnelNotification
          tunnelStatus={tunnelStatus}
          routerName={device?.name || "Router"}
          polling={false}
        />
      ) : null}
      {error ? <p className="mb-4 text-sm text-warning">{error}</p> : null}
      {device ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {device.role || "No access method"} · tunnel {device.tunnelIp} ({device.tunnelStatus}) · RouterOS {device.routerosVersion || "unknown"}
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
      {error ? <p className="mb-4 text-sm text-warning">{error}</p> : null}
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
