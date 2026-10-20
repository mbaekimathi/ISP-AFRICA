import { useEffect, useMemo, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { apiRequest } from "@/lib/api";

const modes = [
  { id: "load-balance", label: "Load balancing" },
  { id: "failover", label: "Automatic failover" },
  { id: "hybrid", label: "Hybrid load balancing with failover" },
  { id: "manual-single", label: "Manual single-uplink" },
] as const;

type WanMode = (typeof modes)[number]["id"];
type AddressMethod = "dhcp" | "pppoe" | "static";

export type WanPort = {
  name: string;
  running: boolean;
  disabled: boolean;
};

type Uplink = {
  interface: string;
  provider: string;
  method: AddressMethod;
  gateway: string;
  downloadMbps: number;
  uploadMbps: number;
  active: boolean;
  accountNumber: string;
};

type AuditRow = {
  previous: string;
  requested: string;
  outcome: string;
  at: string;
};

type WanState = {
  mode: WanMode;
  uplinks: Uplink[];
  audit: AuditRow[];
  canOverride?: boolean;
};

type Job = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out";
  error: string | null;
  reused?: boolean;
  result: { needsManualRecovery?: boolean; warning?: string } | null;
};

function healthOf(port: WanPort | undefined, sample: boolean, reported?: string) {
  if (reported === "healthy" || reported === "unhealthy" || reported === "unreachable" || reported === "unknown") return reported;
  if (sample || !port) return "unknown";
  if (port.disabled || !port.running) return "unreachable";
  return "unknown";
}

function blank(name: string): Uplink {
  return { interface: name, provider: "", method: "dhcp", gateway: "", downloadMbps: 100, uploadMbps: 100, active: false, accountNumber: "" };
}

export function WanUplinkPanel({ deviceId, version, ports, sample = false }: { deviceId: string; version: string; ports: WanPort[]; sample?: boolean }) {
  const [state, setState] = useState<WanState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [reach, setReach] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    apiRequest<WanState>(`/api/mikrotiks/${deviceId}/wan`)
      .then((body) => {
        if (!stopped) setState(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "WAN settings could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    apiRequest<{ health: Record<string, string> }>(`/api/mikrotiks/${deviceId}/wan/reachability`)
      .then((body) => {
        if (!stopped) setReach(body.health || {});
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || !job || job.status === "queued" || job.status === "running") return;
    let stopped = false;
    apiRequest<WanState>(`/api/mikrotiks/${deviceId}/wan`)
      .then((body) => {
        if (!stopped) setState(body);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [deviceId, job]);

  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "timed_out") return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      apiRequest<{ job: Job }>(`/api/jobs/${job.id}`)
        .then((body) => {
          if (!stopped) setJob(body.job);
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  const available = useMemo(() => ports.map((port) => port.name).filter((name) => !state?.uplinks.some((item) => item.interface === name)), [ports, state]);

  if (!state) {
    return <p className="mt-4 text-sm text-muted-foreground">{error || "Loading WAN settings."}</p>;
  }

  const active = state.uplinks.find((item) => item.active);
  const mayOverride = state.canOverride === true;

  async function persist(next: WanState) {
    setError("");
    try {
      const body = await apiRequest<WanState>(`/api/mikrotiks/${deviceId}/wan`, {
        method: "POST",
        body: JSON.stringify(next),
      });
      setState(body);
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WAN settings could not be saved.");
      return null;
    }
  }

  async function chooseUplink(interfaceName: string) {
    if (!state || busy || job?.status === "queued" || job?.status === "running") return;
    const uplink = state.uplinks.find((item) => item.interface === interfaceName);
    if (!uplink || uplink.active) return;
    setBusy(interfaceName);
    setError("");
    try {
      const saved = await persist(state);
      if (!saved) return;
      const reported = reach[interfaceName] || "unknown";
      const body = await apiRequest<{ job: Job }>(`/api/mikrotiks/${deviceId}/wan/switch`, {
        method: "POST",
        body: JSON.stringify({ interface: interfaceName, confirm: true, override: reported !== "healthy" && mayOverride }),
      });
      if (body.job.reused) {
        setError("A switch is already running for this router.");
      }
      setJob(body.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That uplink could not be selected.");
    } finally {
      setBusy("");
    }
  }

  function update(interfaceName: string, patch: Partial<Uplink>) {
    setState((current) =>
      current
        ? {
            ...current,
            uplinks: current.uplinks.map((item) => (item.interface === interfaceName ? { ...item, ...patch } : item)),
          }
        : current,
    );
  }

  async function cancel() {
    if (!job) return;
    const body = await apiRequest<{ job: Job }>(`/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
    setJob(body.job);
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-5">
      <h2 className="font-semibold">WAN operating mode</h2>
      <p className="mt-1 text-sm text-muted-foreground">Manual single-uplink keeps every uplink configured and moves ordinary internet traffic only when you switch it.</p>
      <fieldset className="mt-4 grid gap-2">
        <legend className="text-sm font-medium">Operating mode</legend>
        {modes.map((mode) => (
          <label key={mode.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
            <input
              type="radio"
              name="wan-mode"
              value={mode.id}
              checked={state.mode === mode.id}
              onChange={() => {
                const next = { ...state, mode: mode.id };
                setState(next);
                void persist(next);
              }}
            />
            {mode.label}
          </label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        {available.map((name) => (
          <SecondaryButton key={name} type="button" onClick={() => {
            const next = { ...state, uplinks: [...state.uplinks, blank(name)] };
            setState(next);
            void persist(next);
          }}>
            Add {name}
          </SecondaryButton>
        ))}
      </div>
      <ul className="mt-4 grid gap-3">
        {state.uplinks.map((uplink) => {
          const port = ports.find((item) => item.name === uplink.interface);
          const health = healthOf(port, sample, reach[uplink.interface]);
          return (
            <li key={uplink.interface} className="rounded-xl border border-border px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {uplink.provider || "Provider not set"} · {uplink.interface}
                  {uplink.accountNumber ? <span className="text-muted-foreground"> · acct {uplink.accountNumber}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {uplink.active ? "Active uplink" : "Standby uplink"} · {health} · {uplink.downloadMbps}/{uplink.uploadMbps} Mbps
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <FormField id={`wan-provider-${uplink.interface}`} label="Provider">
                  <input id={`wan-provider-${uplink.interface}`} className="field" value={uplink.provider} maxLength={40} onChange={(event) => update(uplink.interface, { provider: event.target.value })} />
                </FormField>
                <FormField id={`wan-method-${uplink.interface}`} label="Addressing">
                  <select id={`wan-method-${uplink.interface}`} className="field" value={uplink.method} onChange={(event) => update(uplink.interface, { method: event.target.value as AddressMethod })}>
                    <option value="dhcp">DHCP</option>
                    <option value="pppoe">PPPoE</option>
                    <option value="static">Static</option>
                  </select>
                </FormField>
                <FormField id={`wan-gateway-${uplink.interface}`} label="Gateway">
                  <input id={`wan-gateway-${uplink.interface}`} className="field" value={uplink.gateway} onChange={(event) => update(uplink.interface, { gateway: event.target.value })} />
                </FormField>
                <FormField id={`wan-account-${uplink.interface}`} label="Account number" hint="Optional — the account this uplink buys internet on.">
                  <input id={`wan-account-${uplink.interface}`} className="field" value={uplink.accountNumber} maxLength={64} onChange={(event) => update(uplink.interface, { accountNumber: event.target.value })} />
                </FormField>
                <FormField id={`wan-down-${uplink.interface}`} label="Download Mbps">
                  <input id={`wan-down-${uplink.interface}`} className="field" type="number" min={1} value={uplink.downloadMbps} onChange={(event) => update(uplink.interface, { downloadMbps: Number(event.target.value) })} />
                </FormField>
                <FormField id={`wan-up-${uplink.interface}`} label="Upload Mbps">
                  <input id={`wan-up-${uplink.interface}`} className="field" type="number" min={1} value={uplink.uploadMbps} onChange={(event) => update(uplink.interface, { uploadMbps: Number(event.target.value) })} />
                </FormField>
              </div>
              {state.mode === "manual-single" ? (
                <div className="mt-3">
                  <PrimaryButton type="button" disabled={uplink.active || Boolean(busy) || job?.status === "queued" || job?.status === "running"} onClick={() => void chooseUplink(uplink.interface)}>
                    {uplink.active ? "In use" : busy === uplink.interface ? "Checking…" : "Use this uplink"}
                  </PrimaryButton>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">
        {state.mode === "manual-single"
          ? `Click Use this uplink. The router is checked first, then ordinary traffic moves to it. Open sessions may need to reconnect. ${active ? `${active.provider} on ${active.interface} is in use.` : "No uplink is in use yet."} RouterOS ${version || "unknown"}.`
          : state.mode === "failover"
            ? "Automatic failover is saved. It moves ordinary traffic when an uplink fails."
            : state.mode === "hybrid"
              ? "Hybrid mode is saved. It shares traffic and can fail over."
              : "Load balancing is saved. It shares ordinary traffic across the saved uplinks."}
      </p>
      {job?.status === "queued" ? (
        <SecondaryButton type="button" onClick={() => void cancel()}>
          Cancel switch
        </SecondaryButton>
      ) : null}
      {job ? <p className="mt-3 text-sm text-muted-foreground">{job.status === "running" || job.status === "queued" ? "Checking the router and updating the uplink…" : job.error || "The uplink was updated."}</p> : null}
      {state.audit.length > 0 ? (
        <ul className="mt-4 grid gap-2 text-sm text-muted-foreground">
          {state.audit.map((row) => (
            <li key={`${row.at}-${row.requested}`}>
              {row.at}: {row.previous || "none"} to {row.requested || "none"} · {row.outcome}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-3 notice" role="alert">{error}</p> : null}
    </section>
  );
}
