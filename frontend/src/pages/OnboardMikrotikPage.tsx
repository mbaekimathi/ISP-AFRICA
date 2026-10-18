import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { buildWinboxScript, backupName } from "@/lib/winboxScript";

const roles = [
  { value: "hotspot", label: "Hotspot" },
  { value: "pppoe", label: "PPPoE" },
  { value: "static", label: "Static IP" },
  { value: "dhcp", label: "DHCP" },
] as const;

type DeviceRole = (typeof roles)[number]["value"];

type DeviceRecord = {
  id: string;
  name: string;
  site: string;
  role: string;
  routerosVersion: "" | "7" | "6";
  tunnelIp: string;
  publicKey: string;
  privateKey?: string;
  status: "identity" | "waiting" | "active";
  tunnelStatus: "unknown" | "down" | "up";
  lastSeen: string | null;
  lastApi: string | null;
  stageTested: boolean;
  serverTunnelIp: string;
  endpoint: string;
  endpointPort: number;
  serverPublicKey: string;
  checks: {
    handshake: boolean;
    privateIp: boolean;
    apiLogin: boolean;
    identity: boolean;
    ready: boolean;
  };
};

const observed = [
  { key: "handshake", label: "Handshake" },
  { key: "privateIp", label: "Tunnel address" },
  { key: "apiLogin", label: "API login" },
  { key: "identity", label: "Identity" },
] as const;

function localPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function OnboardMikrotikPage() {
  usePageMeta("Onboard Mikrotik — ISP CENTRIC", "Name the router, copy one WinBox script, and paste it once.");
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [role, setRole] = useState<DeviceRole[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [apiPassword, setApiPassword] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [backupSaved, setBackupSaved] = useState(false);
  const [winboxConnects, setWinboxConnects] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!device || !finished) return;
    let stopped = false;
    let controller = new AbortController();
    const refresh = () => {
      controller.abort();
      controller = new AbortController();
      apiRequest<{ device: DeviceRecord }>(`/api/mikrotiks/${device.id}`, { signal: controller.signal })
        .then((body) => {
          if (!stopped) setDevice((current) => (current ? { ...body.device, privateKey: current.privateKey } : body.device));
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [device?.id, finished]);

  async function createDevice() {
    setError("");
    if (!name.trim() || !site.trim() || role.length === 0) {
      setError("Enter the router name, site, and how customers connect.");
      return;
    }
    setPending(true);
    try {
      const body = await apiRequest<{ device: DeviceRecord }>("/api/mikrotiks", {
        method: "POST",
        body: JSON.stringify({
          name,
          site,
          role: roles.filter((item) => role.includes(item.value)).map((item) => item.value),
          routerosVersion: "",
        }),
      });
      setDevice(body.device);
      setApiPassword(localPassword());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The router record could not be created.");
    } finally {
      setPending(false);
    }
  }

  async function copyScript() {
    if (!device || !apiPassword) return;
    try {
      await navigator.clipboard.writeText(buildWinboxScript(device, apiPassword).script);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
      setError("The script could not be copied automatically. Select it in the box, copy it, then confirm below.");
    }
  }

  async function finish() {
    if (!device || !backupSaved || !winboxConnects || !authorized || !copied) return;
    setPending(true);
    setError("");
    try {
      const waiting = await apiRequest<{ device: DeviceRecord }>(`/api/mikrotiks/${device.id}/waiting`, {
        method: "POST",
        body: JSON.stringify({
          backupReference: backupName(device.name),
          previewAccepted: true,
          recoveryConfirmed: true,
          authorized: true,
          apiPassword,
        }),
      });
      const tested = await apiRequest<{ device: DeviceRecord }>(`/api/mikrotiks/${device.id}/stage-test`, {
        method: "POST",
        body: JSON.stringify({ localManagement: true }),
      });
      setDevice({ ...tested.device, privateKey: waiting.device.privateKey ?? device.privateKey });
      setFinished(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The router could not be saved.");
    } finally {
      setPending(false);
    }
  }

  const built = device && apiPassword ? buildWinboxScript(device, apiPassword) : null;
  const readyToFinish = Boolean(built?.applicable) && authorized && copied && backupSaved && winboxConnects;
  const localOnly = Boolean(device && !device.endpoint.trim() && !device.serverPublicKey.trim());

  return (
    <div className="page-shell py-8">
      <div className={`mx-auto grid gap-6 ${device ? "max-w-3xl" : "max-w-md"}`}>
        <PageHeader
          title="Onboard a router"
          description="Name the router, copy one script, and paste it into WinBox Terminal. The script reads that router and applies the matching setup. The router then connects out on its own."
        />

        <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
          {error ? (
            <p className="mb-5 notice" role="alert">
              {error}{" "}
              {error.includes("Sign in") ? (
                <Link className="font-semibold text-primary" to="/login">
                  ISP client login
                </Link>
              ) : null}
            </p>
          ) : null}

          {!device ? (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void createDevice();
              }}
            >
              <FormField id="device-name" label="Router name">
                <input id="device-name" className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
              </FormField>
              <FormField id="device-site" label="Site">
                <input id="device-site" className="field" value={site} maxLength={80} onChange={(event) => setSite(event.target.value)} />
              </FormField>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium text-foreground">How customers connect</legend>
                <p id="device-role-hint" className="text-sm text-muted-foreground">Select every method this router uses.</p>
                <div className="mt-1 grid gap-2">
                  {roles.map((item) => (
                    <label key={item.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
                      <input
                        type="checkbox"
                        name="device-role"
                        value={item.value}
                        checked={role.includes(item.value)}
                        onChange={(event) => {
                          const value = item.value;
                          setRole((current) => (event.target.checked ? [...current, value] : current.filter((entry) => entry !== value)));
                        }}
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <PrimaryButton type="submit" disabled={pending}>
                {pending ? "Preparing script…" : "Generate script"}
              </PrimaryButton>
            </form>
          ) : null}

          {device && built ? (
            <div className="grid gap-5">
              <div>
                <h2 className="text-xl font-semibold">{device.name}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Open WinBox, choose New Terminal, paste, and press Enter. Each step prints OK or FAIL. Pasting again replaces only the isp-centric tunnel. RouterOS 7 with WireGuard continues. RouterOS 6 stops before any change.
                </p>
              </div>
              <ul className="grid gap-2 text-sm leading-6 text-muted-foreground">
                <li>Saves a backup, then replaces the previous isp-centric tunnel.</li>
                <li>Leaves subscriber ports, bridges, and hotspot clients in place.</li>
                {built.local ? (
                  <li>Leaves the VPS peer out until that key is set. Paste the script again then to add it.</li>
                ) : (
                  <li>Allows only the VPS tunnel address through that peer.</li>
                )}
                <li>Creates an API user that can read, test, and use the API.</li>
              </ul>
              {!built.applicable ? (
                <p className="notice">
                  {built.reason} Copy stays closed so this script cannot be pasted onto the router.
                </p>
              ) : null}
              <pre className="overflow-x-auto rounded-xl bg-surface-muted p-4 text-xs leading-6">{built.script}</pre>
              <p className="text-sm leading-6 text-muted-foreground">
                Leave this page open until the script is pasted. The private key is not stored. If the paste fails, run <span className="font-mono text-xs">/system backup load name={backupName(device.name)}</span> in that terminal. This page has not run that restore on the router.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
                <span>I have read this script and I authorize running it on the live router.</span>
              </label>
              <PrimaryButton type="button" onClick={() => void copyScript()} disabled={!authorized || !built.applicable}>
                {copied ? "Copied" : "Copy script"}
              </PrimaryButton>
              {copyFailed && built.applicable ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={copied} onChange={(event) => setCopied(event.target.checked)} />
                  <span>I copied the script from the box above.</span>
                </label>
              ) : null}
              {copied ? (
                <div className="grid gap-3 border-t border-border pt-4 text-sm">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={backupSaved} onChange={(event) => setBackupSaved(event.target.checked)} />
                    <span>I copied {backupName(device.name)}.backup out of WinBox Files, and I can restore it with the command above.</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={winboxConnects} onChange={(event) => setWinboxConnects(event.target.checked)} />
                    <span>WinBox still connects to the router after the paste.</span>
                  </label>
                  <SecondaryButton type="button" onClick={() => void finish()} disabled={!readyToFinish || pending || finished}>
                    {finished ? "Waiting for the router" : pending ? "Saving…" : "Finish"}
                  </SecondaryButton>
                </div>
              ) : null}
              {finished && localOnly ? (
                <div className="grid gap-3">
                  <p className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm leading-6">
                    Saved for local testing. WinBox reported the backup, and this app will not mark a handshake, tunnel address, API login, or identity until the VPS peer is added. The router address {device.tunnelIp} is only reachable through that tunnel.
                  </p>
                  <PrimaryButton to={`/mikrotiks/${device.id}`}>Open router</PrimaryButton>
                </div>
              ) : null}
              {finished && !localOnly ? (
                <div className="grid gap-3">
                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div className="rounded-xl border border-border px-4 py-3">
                      <dt className="text-muted-foreground">Last seen</dt>
                      <dd>{device.lastSeen ?? "Not seen"}</dd>
                    </div>
                    <div className="rounded-xl border border-border px-4 py-3">
                      <dt className="text-muted-foreground">Last API connection</dt>
                      <dd>{device.lastApi ?? "None"}</dd>
                    </div>
                    <div className="rounded-xl border border-border px-4 py-3">
                      <dt className="text-muted-foreground">Tunnel</dt>
                      <dd>{device.tunnelStatus}</dd>
                    </div>
                  </dl>
                  <ul className="grid gap-2 text-sm">
                    {observed.map((item) => (
                      <li key={item.key} className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
                        <span>{item.label}</span>
                        <span className="text-muted-foreground">{device.checks[item.key] ? "Passed" : "Waiting"}</span>
                      </li>
                    ))}
                  </ul>
                  {device.checks.ready ? (
                    <PrimaryButton to={`/mikrotiks/${device.id}`}>Router active</PrimaryButton>
                  ) : (
                    <PrimaryButton type="button" disabled>
                      Not active yet
                    </PrimaryButton>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
