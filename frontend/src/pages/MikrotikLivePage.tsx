import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { TunnelNotification } from "@/components/ui/TunnelNotification";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type LiveInterface = {
  name: string;
  type: string;
  running: boolean;
  disabled: boolean;
  comment: string;
  rxByte: string;
  txByte: string;
};

type LiveState = {
  reachable: boolean;
  sample?: boolean;
  apiReady: boolean;
  name?: string;
  message: string;
  checkedAt: string;
  identity?: string;
  board?: string;
  version?: string;
  uptime?: string;
  cpuLoad?: string;
  cpu?: string;
  architecture?: string;
  platform?: string;
  freeMemory?: string | null;
  totalMemory?: string | null;
  interfaces: LiveInterface[];
  interfaceCount?: number;
  hotspotActive?: number | null;
  pppoeActive?: number | null;
  site?: string;
  health?: {
    drops: {
      subject: string;
      reason: string;
      startedAt: string;
      endedAt: string | null;
      duration: string;
      open: boolean;
    }[];
    trend?: TrendPoint[];
    trends?: Partial<Record<HealthRange, TrendPoint[]>>;
  };
};

type HealthRange = "live" | "days" | "weeks" | "month" | "year";

type TrendPoint = { label: string; date: string; minutes: number; drops: number };

const REBOOT_GRANT = '/user group set [find where name="isp-centric-api"] policy=read,write,api,test,ftp,reboot';

const healthRanges: { id: HealthRange; label: string; caption: string }[] = [
  { id: "live", label: "Live", caption: "Last hour" },
  { id: "days", label: "Days", caption: "Last 7 days" },
  { id: "weeks", label: "Weeks", caption: "Last 8 weeks" },
  { id: "month", label: "Month", caption: "Last 30 days" },
  { id: "year", label: "Year", caption: "Last 12 months" },
];

function HealthTrend({
  range,
  trend,
  onRange,
}: {
  range: HealthRange;
  trend: TrendPoint[];
  onRange: (range: HealthRange) => void;
}) {
  const caption = healthRanges.find((item) => item.id === range)?.caption ?? "Last hour";
  const width = 640;
  const height = 128;
  const max = Math.max(10, ...trend.map((point) => point.minutes), 1);
  const slot = width / Math.max(trend.length, 1);
  const bar = Math.min(28, slot * 0.42);
  const points = trend.map((point, index) => {
    const barHeight = point.minutes > 0 ? Math.max(4, (point.minutes / max) * (height - 20)) : 0;
    const x = index * slot + slot / 2;
    return { ...point, x, y: height - barHeight, barHeight };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const total = trend.reduce((sum, point) => sum + point.minutes, 0);
  return (
    <div className="border-b border-border px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{caption}</p>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{total} min down</p>
        </div>
        <div className="grid grid-cols-5 gap-1 rounded-lg bg-surface-muted p-1" role="tablist" aria-label="Health range">
          {healthRanges.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={range === item.id}
              className={`min-h-8 rounded-md px-2 text-xs font-medium ${range === item.id ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground"}`}
              onClick={() => onRange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height + 22}`} className="mt-3 h-40 w-full" role="img" aria-label={`Health downtime, ${caption}`}>
        {points.length > 1 ? <polyline fill="none" stroke="rgb(var(--primary-rgb))" strokeWidth="2" points={line} /> : null}
        {points.map((point, index) => (
          <g key={point.date}>
            <rect x={point.x - bar / 2} y={point.y} width={bar} height={point.barHeight} rx="3" fill="rgb(var(--primary-rgb) / 0.22)" />
            <circle cx={point.x} cy={point.y} r="3" fill="rgb(var(--primary-rgb))" />
            {trend.length <= 12 || index % 5 === 0 ? (
              <text x={point.x} y={height + 16} textAnchor="middle" fontSize="11" fill="rgb(var(--muted-foreground-rgb))">
                {point.label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

function formatBytes(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value || "0 B";
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KB`;
  if (amount < 1024 * 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`;
  return `${(amount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function amountOf(value?: string | null) {
  const amount = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function usedPercent(free?: string | null, total?: string | null) {
  const freeAmount = amountOf(free);
  const totalAmount = amountOf(total);
  if (!totalAmount) return 0;
  return Math.max(0, Math.min(100, Math.round(((totalAmount - freeAmount) / totalAmount) * 100)));
}

function StatCard({ label, value, detail, meter }: { label: string; value: string; detail: string; meter?: number }) {
  return (
    <article className="px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      {meter != null ? (
        <div className="live-meter mt-3">
          <span style={{ ["--meter" as string]: `${meter}%` }} />
        </div>
      ) : null}
    </article>
  );
}

export function MikrotikLivePage() {
  const { deviceId = "" } = useParams();
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState(import.meta.env.DEV ? "Itsispcentric@001" : "");
  const [saving, setSaving] = useState(false);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [healthRange, setHealthRange] = useState<HealthRange>("live");
  const [healthTrends, setHealthTrends] = useState<Partial<Record<HealthRange, TrendPoint[]>>>({});
  const [tunnelStatus, setTunnelStatus] = useState<"up" | "down" | "unknown">("unknown");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartNote, setRestartNote] = useState("");
  const [grantCopied, setGrantCopied] = useState(false);
  usePageMeta("MikroTik live — ISP CENTRIC", "Live running state read from the router.");

  useEffect(() => {
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    apiRequest<{ device: { name: string; apiReady: boolean } }>(`/api/mikrotiks/${deviceId}`, { signal: controller.signal })
      .then((body) => {
        if (stopped) return;
        setApiReady(Boolean(body.device.apiReady));
        setLive((current) => current ?? { reachable: false, apiReady: Boolean(body.device.apiReady), name: body.device.name, message: "", checkedAt: "", interfaces: [] });
      })
      .catch((cause: unknown) => {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "That router could not be opened.");
      });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || apiReady !== true) return;
    let stopped = false;
    let timer = 0;
    let controller = new AbortController();

    const load = () => {
      controller.abort();
      controller = new AbortController();
      apiRequest<{ live: LiveState }>(`/api/mikrotiks/${deviceId}/live`, { signal: controller.signal })
        .then((body) => {
          if (stopped) return;
          setLive(body.live);
          setError("");
          setTunnelStatus(body.live.reachable ? "up" : "down");
          timer = window.setTimeout(load, 4000);
        })
        .catch((cause: unknown) => {
          if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
          setError(cause instanceof Error ? cause.message : "The live router read failed.");
          setTunnelStatus("down");
          timer = window.setTimeout(load, 8000);
        });
    };

    load();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [deviceId, apiReady]);

  useEffect(() => {
    if (!deviceId || apiReady !== true || healthRange === "live" || live?.health?.trends?.[healthRange] || healthTrends[healthRange]) return;
    let stopped = false;
    const controller = new AbortController();
    apiRequest<{ trend: TrendPoint[] }>(`/api/mikrotiks/${deviceId}/health?range=${healthRange}`, { signal: controller.signal })
      .then((body) => {
        if (!stopped) setHealthTrends((current) => ({ ...current, [healthRange]: body.trend }));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [deviceId, apiReady, healthRange, live?.health?.trends, healthTrends]);

  async function saveAccess() {
    setSaving(true);
    setError("");
    try {
      const body = await apiRequest<{ device: { apiReady: boolean; name: string } }>(`/api/mikrotiks/${deviceId}/access`, {
        method: "POST",
        body: JSON.stringify({ apiPassword: password }),
      });
      setPassword("");
      setApiReady(body.device.apiReady);
      setLive((current) => ({
        reachable: false,
        apiReady: true,
        name: body.device.name,
        message: "Reading the router.",
        checkedAt: "",
        interfaces: current?.interfaces ?? [],
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The API password could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function restartRouter() {
    setRestarting(true);
    setError("");
    setRestartNote("");
    setGrantCopied(false);
    try {
      const body = await apiRequest<{ rebooting: boolean; message: string }>(`/api/mikrotiks/${deviceId}/reboot`, {
        method: "POST",
        body: "{}",
      });
      setRestartNote(body.message || "The router is restarting.");
      setTunnelStatus("down");
    } catch (cause) {
      setRestartNote(cause instanceof Error ? cause.message : "The router could not be restarted.");
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
    }
  }

  async function retryConnection() {
    setSaving(true);
    setError("");
    try {
      const body = await apiRequest<{ live: LiveState }>(`/api/mikrotiks/${deviceId}/live`);
      setLive(body.live);
      setTunnelStatus(body.live.reachable ? "up" : "down");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The router could not be reached.");
      setTunnelStatus("down");
    } finally {
      setSaving(false);
    }
  }

  const title = live?.name || live?.identity || "MikroTik";
  const needsPassword = apiReady === false || /could not be read|Save the API password/i.test(live?.message || "");
  const cpu = Math.max(0, Math.min(100, Number(live?.cpuLoad) || 0));
  const memory = usedPercent(live?.freeMemory, live?.totalMemory);
  const statusLabel = live?.sample ? "Sample" : live?.reachable ? "Running" : apiReady ? "Not answering" : "Access not saved";
  const statusTone = live?.sample ? "bg-warning" : live?.reachable ? "bg-success" : "bg-muted-foreground";

  const notice = live?.message && !/development sample/i.test(live.message) ? live.message : "";

  return (
    <div className="page-shell py-8">
      <PageHeader title={title} description="Live running state read from the router." />
      {tunnelStatus !== "unknown" ? (
        <TunnelNotification
          tunnelStatus={tunnelStatus}
          routerName={live?.name || live?.identity || "Router"}
          onRetry={() => void retryConnection()}
          polling={true}
        />
      ) : null}
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {needsPassword ? (
        <form
          className="mt-6 max-w-md rounded-xl border border-border bg-surface p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAccess();
          }}
        >
          <FormField
            id="api-password"
            label="API password"
            hint={
              import.meta.env.DEV
                ? "Development access uses Itsispcentric@001. The user name is isp-centric."
                : "The password is only in the WinBox script from onboarding. The user name is isp-centric."
            }
          >
            <input
              id="api-password"
              className="field"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormField>
          <div className="mt-4">
            <PrimaryButton type="submit" disabled={saving || password.length < 12}>
              {saving ? "Saving access…" : "Access router"}
            </PrimaryButton>
          </div>
        </form>
      ) : null}
      {notice ? <p className="mt-4 text-sm text-muted-foreground">{notice}</p> : null}
      {live?.reachable ? (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="order-2 grid min-w-0 gap-4 lg:order-1">
          <section className="live-panel grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
            <StatCard label="CPU" value={`${cpu}%`} detail={live.cpu || "Processor load"} meter={cpu} />
            <StatCard label="Memory free" value={live.freeMemory || "Unknown"} detail={live.totalMemory ? `${memory}% used of ${live.totalMemory}` : "Memory in use"} meter={memory} />
            <StatCard label="Hotspot" value={live.hotspotActive == null ? "—" : String(live.hotspotActive)} detail={live.hotspotActive == null ? "Not installed" : "Active sessions"} />
            <StatCard label="PPPoE" value={live.pppoeActive == null ? "—" : String(live.pppoeActive)} detail={live.pppoeActive == null ? "Not installed" : "Active sessions"} />
          </section>
          <section className="live-panel overflow-x-auto">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">Interfaces</h2>
              <p className="text-xs text-muted-foreground">{live.interfaces.length}</p>
            </div>
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-5 py-2.5 font-medium">Type</th>
                  <th className="px-5 py-2.5 font-medium">State</th>
                  <th className="px-5 py-2.5 font-medium">Received</th>
                  <th className="px-5 py-2.5 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {live.interfaces.length === 0 ? (
                  <tr>
                    <td className="px-5 py-4 text-muted-foreground" colSpan={5}>
                      No interfaces were returned.
                    </td>
                  </tr>
                ) : (
                  live.interfaces.map((item) => (
                    <tr key={item.name} className="border-t border-border">
                      <td className="px-5 py-3">
                        <span className="font-medium">{item.name}</span>
                        {item.comment ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.comment}</span> : null}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{item.type || "—"}</td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${item.disabled ? "bg-muted-foreground" : item.running ? "bg-success" : "bg-destructive"}`} />
                          {item.disabled ? "Disabled" : item.running ? "Running" : "Down"}
                        </span>
                      </td>
                      <td className="px-5 py-3 tabular-nums">{formatBytes(item.rxByte)}</td>
                      <td className="px-5 py-3 tabular-nums">{formatBytes(item.txByte)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
          <section className="live-panel overflow-x-auto">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">Health</h2>
              <p className="text-xs text-muted-foreground">{live.health?.drops.length ?? 0} drops</p>
            </div>
            <HealthTrend
              range={healthRange}
              trend={(healthRange === "live" ? live.health?.trend : live.health?.trends?.[healthRange] ?? healthTrends[healthRange]) ?? []}
              onRange={setHealthRange}
            />
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Where</th>
                  <th className="px-5 py-2.5 font-medium">Reason</th>
                  <th className="px-5 py-2.5 font-medium">Time</th>
                  <th className="px-5 py-2.5 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {(live.health?.drops.length ?? 0) === 0 ? (
                  <tr>
                    <td className="px-5 py-4 text-muted-foreground" colSpan={4}>
                      No drops are recorded.
                    </td>
                  </tr>
                ) : (
                  live.health?.drops.map((drop) => (
                    <tr key={`${drop.subject}-${drop.startedAt}`} className="border-t border-border">
                      <td className="px-5 py-3 font-medium">{drop.subject}</td>
                      <td className="px-5 py-3">{drop.reason}</td>
                      <td className="px-5 py-3 tabular-nums">{drop.startedAt}</td>
                      <td className="px-5 py-3 tabular-nums">{drop.open ? `${drop.duration} and ongoing` : drop.duration}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
          </div>
          <aside className="live-panel order-1 h-fit p-5 lg:sticky lg:top-24 lg:order-2">
            <p className="text-xs font-medium text-muted-foreground">MikroTik profile</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{title}</h2>
            <p className="mt-2 inline-flex items-center gap-2 text-sm font-medium">
              <span className={`h-2 w-2 rounded-full ${statusTone}`} />
              {statusLabel}
            </p>
            <dl className="mt-5 grid gap-3 text-sm">
              {[
                ["Site", live.site || ""],
                ["Identity", live.identity && live.identity !== title ? live.identity : ""],
                ["Board", live.board || "Unknown"],
                ["RouterOS", live.version || "Unknown"],
                ["Platform", [live.architecture, live.cpu].filter(Boolean).join(" · ") || "Unknown"],
                ["Uptime", live.uptime || "Unknown"],
                ["Memory", live.freeMemory && live.totalMemory ? `${live.freeMemory} free of ${live.totalMemory}` : live.freeMemory || "Unknown"],
                ["Checked", live.checkedAt || "Waiting"],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                <div key={label} className="grid gap-0.5 border-t border-border pt-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 border-t border-border pt-4">
              {confirmRestart ? (
                <div className="grid gap-2">
                  <p className="text-xs text-muted-foreground">Restarting drops every connected session for a minute or two.</p>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton type="button" disabled={restarting} onClick={() => void restartRouter()}>
                      {restarting ? "Restarting…" : "Confirm restart"}
                    </SecondaryButton>
                    <SecondaryButton type="button" disabled={restarting} onClick={() => setConfirmRestart(false)}>
                      Keep running
                    </SecondaryButton>
                  </div>
                </div>
              ) : (
                <SecondaryButton
                  type="button"
                  onClick={() => {
                    setConfirmRestart(true);
                    setRestartNote("");
                  }}
                >
                  Restart router
                </SecondaryButton>
              )}
              {restartNote ? (
                <div className="mt-3 grid gap-2" role="alert">
                  <p className="text-xs leading-5 text-muted-foreground">{restartNote}</p>
                  {/cannot restart this router/i.test(restartNote) ? (
                    <div className="grid gap-2">
                      <p className="text-xs text-muted-foreground">Paste this once into WinBox Terminal as admin, then restart again.</p>
                      <pre className="overflow-x-auto rounded-lg bg-surface-muted p-3 text-xs leading-5">{REBOOT_GRANT}</pre>
                      <SecondaryButton
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(REBOOT_GRANT).then(
                            () => setGrantCopied(true),
                            () => setGrantCopied(false),
                          );
                        }}
                      >
                        {grantCopied ? "Copied" : "Copy the update"}
                      </SecondaryButton>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
