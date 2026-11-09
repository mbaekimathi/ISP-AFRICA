import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, Radio, X } from "lucide-react";
import { Link } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DEFAULT_LOCATION, locationSearchSource, resolveLocation, searchLocations, type LocationSuggestion } from "@/lib/places";
import { buildWinboxScript, backupName } from "@/lib/winboxScript";

type DeviceRecord = {
  id: string;
  name: string;
  site: string;
  latitude: number | null;
  longitude: number | null;
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

type CheckKey = "handshake" | "privateIp" | "apiLogin" | "identity";
type StepState = "waiting" | "passed" | "failed";
type LinkState = "listening" | "online" | "failed";

const observed = [
  { key: "handshake", label: "Handshake", waiting: "Waiting for peer handshake" },
  { key: "privateIp", label: "Tunnel address", waiting: "Waiting for tunnel address" },
  { key: "apiLogin", label: "API login", waiting: "Waiting for API login" },
  { key: "identity", label: "Identity", waiting: "Waiting for router identity" },
] as const;

function stepState(device: DeviceRecord, key: CheckKey): StepState {
  if (device.checks[key]) return "passed";
  if (device.tunnelStatus === "down") return "failed";
  return "waiting";
}

function linkState(device: DeviceRecord): LinkState {
  if (device.checks.ready) return "online";
  if (device.tunnelStatus === "down") return "failed";
  return "listening";
}

function tunnelLabel(status: DeviceRecord["tunnelStatus"]) {
  if (status === "up") return "Up";
  if (status === "down") return "Down";
  return "Unknown";
}

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
  const [siteCoords, setSiteCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [siteSuggestions, setSiteSuggestions] = useState<LocationSuggestion[]>([]);
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [siteSearching, setSiteSearching] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const pickedSite = useRef("");
  const pickSequence = useRef(0);
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
    const ready = device.checks.ready;
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
    const timer = window.setInterval(refresh, ready ? 15000 : 4000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [device?.id, device?.checks.ready, finished]);

  useEffect(() => {
    const query = site.trim();
    if (query.length < 3 || site === pickedSite.current) {
      setSiteSuggestions([]);
      setSiteSearching(false);
      if (query.length < 3) setSiteMenuOpen(false);
      return;
    }
    const controller = new AbortController();
    setSiteSearching(true);
    const timer = window.setTimeout(() => {
      searchLocations(query, controller.signal)
        .then((results) => {
          setSiteSuggestions(results);
          setSiteMenuOpen(true);
          setActiveSuggestion(-1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSiteSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSiteSearching(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [site]);

  async function chooseSiteSuggestion(suggestion: LocationSuggestion) {
    const stamp = ++pickSequence.current;
    pickedSite.current = suggestion.label;
    setSite(suggestion.label.slice(0, 80));
    setSiteMenuOpen(false);
    setSiteSuggestions([]);
    try {
      const resolved = await resolveLocation(suggestion, new AbortController().signal);
      if (pickSequence.current !== stamp) return;
      const label = resolved.label.slice(0, 80);
      pickedSite.current = label;
      setSite(label);
      if (resolved.latitude !== null && resolved.longitude !== null) {
        setSiteCoords({ latitude: resolved.latitude, longitude: resolved.longitude });
      }
    } catch {
      if (pickSequence.current === stamp) setSiteCoords(null);
    }
  }

  function handleSiteKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (!siteMenuOpen || !siteSuggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion((index) => Math.min(siteSuggestions.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion((index) => Math.max(-1, index - 1));
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault();
      void chooseSiteSuggestion(siteSuggestions[activeSuggestion]);
    } else if (event.key === "Escape") {
      setSiteMenuOpen(false);
    }
  }

  async function createDevice() {
    setError("");
    if (!name.trim() || !site.trim()) {
      setError("Enter the router name and site.");
      return;
    }
    setPending(true);
    try {
      const body = await apiRequest<{ device: DeviceRecord }>("/api/mikrotiks", {
        method: "POST",
        body: JSON.stringify({
          name,
          site,
          routerosVersion: "",
          latitude: siteCoords?.latitude ?? DEFAULT_LOCATION.latitude,
          longitude: siteCoords?.longitude ?? DEFAULT_LOCATION.longitude,
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
  const connection = device && finished && !localOnly ? linkState(device) : null;
  const passedCount = device ? observed.filter((item) => device.checks[item.key]).length : 0;

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
              <FormField
                id="device-site"
                label="Site"
                hint={
                  siteCoords
                    ? `Coordinates ${siteCoords.latitude.toFixed(5)}, ${siteCoords.longitude.toFixed(5)}`
                    : `Type to search ${locationSearchSource} for the location. Without a pick, Nairobi, Kenya (${DEFAULT_LOCATION.latitude}, ${DEFAULT_LOCATION.longitude}) is used.`
                }
              >
                <div className="relative">
                  <input
                    id="device-site"
                    className="field"
                    value={site}
                    maxLength={80}
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={siteMenuOpen}
                    aria-controls="device-site-suggestions"
                    onChange={(event) => {
                      pickSequence.current += 1;
                      setSiteCoords(null);
                      setSite(event.target.value);
                    }}
                    onFocus={() => {
                      if (site.trim().length >= 3 && site !== pickedSite.current) setSiteMenuOpen(true);
                    }}
                    onBlur={() => window.setTimeout(() => setSiteMenuOpen(false), 150)}
                    onKeyDown={handleSiteKeys}
                  />
                  {siteMenuOpen && site.trim().length >= 3 ? (
                    <ul
                      id="device-site-suggestions"
                      role="listbox"
                      className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-surface shadow-card"
                    >
                      {siteSearching && !siteSuggestions.length ? (
                        <li className="px-4 py-2 text-sm text-muted-foreground">Searching {locationSearchSource}…</li>
                      ) : null}
                      {!siteSearching && !siteSuggestions.length ? (
                        <li className="px-4 py-2 text-sm text-muted-foreground">No matches — Nairobi coordinates are used.</li>
                      ) : null}
                      {siteSuggestions.map((suggestion, index) => {
                        const [main, ...rest] = suggestion.label.split(",");
                        return (
                          <li key={suggestion.id} role="option" aria-selected={index === activeSuggestion}>
                            <button
                              type="button"
                              className={cn("block w-full px-4 py-2 text-left text-sm", index === activeSuggestion && "bg-surface-muted")}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void chooseSiteSuggestion(suggestion)}
                            >
                              <span className="font-medium text-foreground">{main}</span>
                              {rest.length ? <span className="text-muted-foreground">,{rest.join(",")}</span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              </FormField>
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
                  <SecondaryButton type="button" onClick={() => void finish()} disabled={!readyToFinish || pending || finished} className="gap-2">
                    {finished && localOnly ? "Saved for local testing" : null}
                    {finished && !localOnly && device?.checks.ready ? (
                      <>
                        <Check className="h-4 w-4 text-success" aria-hidden="true" />
                        Router connected
                      </>
                    ) : null}
                    {finished && !localOnly && !device?.checks.ready && device?.tunnelStatus === "down" ? (
                      <>
                        <X className="h-4 w-4 text-destructive" aria-hidden="true" />
                        Connection failed
                      </>
                    ) : null}
                    {finished && !localOnly && !device?.checks.ready && device?.tunnelStatus !== "down" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Listening for the router…
                      </>
                    ) : null}
                    {!finished && pending ? "Saving…" : null}
                    {!finished && !pending ? "Finish" : null}
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
              {finished && !localOnly && connection ? (
                <div className="grid gap-3" aria-live="polite">
                  <div
                    className={cn(
                      "relative overflow-hidden rounded-xl border px-4 py-4",
                      connection === "online" && "border-success-border/60 bg-success-soft/40",
                      connection === "failed" && "border-destructive-border/60 bg-destructive-soft/40",
                      connection === "listening" && "border-info-border/60 bg-info-soft/30",
                    )}
                  >
                    {connection === "listening" ? (
                      <div className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-primary/5 to-transparent" aria-hidden="true" />
                    ) : null}
                    <div className="relative flex items-center gap-3">
                      <span
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                          connection === "online" && "bg-success-soft text-success",
                          connection === "failed" && "bg-destructive-soft text-destructive",
                          connection === "listening" && "bg-info-soft text-info",
                        )}
                      >
                        {connection === "online" ? <Check className="h-5 w-5" aria-hidden="true" /> : null}
                        {connection === "failed" ? <X className="h-5 w-5" aria-hidden="true" /> : null}
                        {connection === "listening" ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">
                          {connection === "online" ? "Router connected" : null}
                          {connection === "failed" ? "Router connection failed" : null}
                          {connection === "listening" ? "Listening for the router" : null}
                        </p>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {connection === "online" ? "All checks passed. The tunnel and API are live." : null}
                          {connection === "failed"
                            ? "The tunnel is down. Confirm the WinBox paste and that the VPS peer is online."
                            : null}
                          {connection === "listening"
                            ? `Checking every few seconds · ${passedCount} of ${observed.length} steps ready`
                            : null}
                        </p>
                      </div>
                      {connection === "listening" ? (
                        <span className="hidden items-center gap-1.5 rounded-full border border-info-border/50 bg-surface/80 px-2.5 py-1 text-xs font-semibold text-info sm:inline-flex">
                          <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" />
                          Live
                        </span>
                      ) : null}
                    </div>
                    {connection !== "online" ? (
                      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-surface/70">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500 ease-out",
                            connection === "failed" ? "bg-destructive" : "bg-primary",
                          )}
                          style={{ width: `${Math.max(8, (passedCount / observed.length) * 100)}%` }}
                        />
                        {connection === "listening" ? (
                          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-primary/20 to-transparent" aria-hidden="true" />
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <dl className="grid gap-2 text-sm sm:grid-cols-3">
                    <div className="rounded-xl border border-border bg-surface px-4 py-3">
                      <dt className="text-muted-foreground">Last seen</dt>
                      <dd className="mt-1 font-medium">{device.lastSeen ?? "Not seen"}</dd>
                    </div>
                    <div className="rounded-xl border border-border bg-surface px-4 py-3">
                      <dt className="text-muted-foreground">Last API connection</dt>
                      <dd className="mt-1 font-medium">{device.lastApi ?? "None"}</dd>
                    </div>
                    <div
                      className={cn(
                        "rounded-xl border px-4 py-3",
                        device.tunnelStatus === "up" && "border-success-border/60 bg-success-soft/30",
                        device.tunnelStatus === "down" && "border-destructive-border/60 bg-destructive-soft/30",
                        device.tunnelStatus === "unknown" && "border-border bg-surface",
                      )}
                    >
                      <dt className="text-muted-foreground">Tunnel</dt>
                      <dd className="mt-1 flex items-center gap-2 font-medium">
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            device.tunnelStatus === "up" && "bg-success",
                            device.tunnelStatus === "down" && "bg-destructive",
                            device.tunnelStatus === "unknown" && "animate-pulse bg-warning",
                          )}
                          aria-hidden="true"
                        />
                        {tunnelLabel(device.tunnelStatus)}
                      </dd>
                    </div>
                  </dl>

                  <ul className="grid gap-2 text-sm">
                    {observed.map((item) => {
                      const state = stepState(device, item.key);
                      return (
                        <li
                          key={item.key}
                          className={cn(
                            "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors duration-300",
                            state === "passed" && "border-success-border/50 bg-success-soft/25",
                            state === "failed" && "border-destructive-border/50 bg-destructive-soft/25",
                            state === "waiting" && "border-border bg-surface",
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                                state === "passed" && "bg-success text-success-foreground",
                                state === "failed" && "bg-destructive text-destructive-foreground",
                                state === "waiting" && "bg-surface-muted text-muted-foreground",
                              )}
                            >
                              {state === "passed" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                              {state === "failed" ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                              {state === "waiting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">{item.label}</p>
                              {state === "waiting" ? (
                                <p className="truncate text-xs text-muted-foreground">{item.waiting}</p>
                              ) : null}
                              {state === "failed" ? (
                                <p className="truncate text-xs text-destructive">Could not confirm this step</p>
                              ) : null}
                            </div>
                          </div>
                          <span
                            className={cn(
                              "shrink-0 text-xs font-semibold uppercase tracking-wide",
                              state === "passed" && "text-success",
                              state === "failed" && "text-destructive",
                              state === "waiting" && "text-muted-foreground",
                            )}
                          >
                            {state === "passed" ? "Passed" : null}
                            {state === "failed" ? "Failed" : null}
                            {state === "waiting" ? "Checking" : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  {device.checks.ready ? (
                    <PrimaryButton to={`/mikrotiks/${device.id}`} className="gap-2">
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Router active
                    </PrimaryButton>
                  ) : connection === "failed" ? (
                    <SecondaryButton type="button" disabled className="gap-2 border-destructive-border/60 text-destructive">
                      <X className="h-4 w-4" aria-hidden="true" />
                      Connection failed
                    </SecondaryButton>
                  ) : (
                    <PrimaryButton type="button" disabled className="gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Waiting for router…
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
