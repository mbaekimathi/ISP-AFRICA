import { Cpu, MemoryStick, Network, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
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

type WanUplink = {
  interface: string;
  provider: string;
  method: string;
  gateway: string;
  downloadMbps: number;
  uploadMbps: number;
  active: boolean;
  accountNumber: string;
  eligible?: boolean;
};

type WanState = {
  mode: string;
  uplinks: WanUplink[];
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

function HeroStat({ label, value, icon, meter }: { label: string; value: string; icon: ReactNode; meter?: number }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-foreground/15"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="text-xs text-primary-foreground/70">{label}</p>
        {meter != null ? (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-primary-foreground/20">
            <div
              className="h-full rounded-full bg-primary-foreground/90 transition-[width] duration-500"
              style={{ width: `${Math.min(100, Math.max(0, meter))}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
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
  const [wan, setWan] = useState<WanState | null>(null);
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountDraft, setAccountDraft] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountNote, setAccountNote] = useState("");
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
    if (!deviceId) return;
    let stopped = false;
    const controller = new AbortController();
    apiRequest<WanState>(`/api/mikrotiks/${deviceId}/wan`, { signal: controller.signal })
      .then((body) => {
        if (!stopped) setWan(body);
      })
      .catch(() => undefined);
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

  async function saveAccount() {
    if (!wan) return;
    setSavingAccount(true);
    setError("");
    setAccountNote("");
    try {
      const body = await apiRequest<WanState>(`/api/mikrotiks/${deviceId}/wan`, {
        method: "POST",
        body: JSON.stringify({
          ...wan,
          uplinks: wan.uplinks.map((item) =>
            item === sourceUplink ? { ...item, accountNumber: accountDraft.trim() } : item,
          ),
        }),
      });
      setWan(body);
      setEditingAccount(false);
      setAccountNote("Internet account saved.");
    } catch (cause) {
      setAccountNote(cause instanceof Error ? cause.message : "The internet account could not be saved.");
    } finally {
      setSavingAccount(false);
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
  const statusLabel = live?.sample
    ? "Sample"
    : live?.reachable
      ? "Running"
      : apiReady === null
        ? "Checking…"
        : apiReady
          ? "Not answering"
          : "Access not saved";
  const statusTone = live?.sample
    ? "bg-warning"
    : live?.reachable
      ? "bg-success shadow-[0_0_8px_rgb(var(--success-rgb))]"
      : apiReady
        ? "bg-destructive"
        : "bg-primary-foreground/50";

  const notice = live?.message && !/development sample/i.test(live.message) ? live.message : "";
  const sourceUplink = wan?.uplinks.find((item) => item.active) ?? wan?.uplinks[0];

  return (
    <div className="page-shell py-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/85 to-primary/60 text-primary-foreground shadow-card">
        <div className="network-grid absolute inset-0 opacity-30" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center justify-between gap-4 px-5 pb-5 pt-6 sm:px-7">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/70">MikroTik live</p>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <p className="mt-1 text-sm text-primary-foreground/75">
              {live?.site ? `${live.site} — live running state.` : "Live running state read from the router."}
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3.5 py-2 text-sm font-semibold backdrop-blur-sm">
            <span className={`h-2 w-2 rounded-full ${statusTone}`} aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
        <div className="relative grid grid-cols-2 gap-x-6 gap-y-4 border-t border-primary-foreground/15 px-5 py-4 sm:grid-cols-4 sm:px-7">
          <HeroStat label="CPU load" value={live ? `${cpu}%` : "—"} icon={<Cpu className="h-4 w-4" />} meter={live ? cpu : undefined} />
          <HeroStat
            label="Memory used"
            value={live ? `${memory}%` : "—"}
            icon={<MemoryStick className="h-4 w-4" />}
            meter={live ? memory : undefined}
          />
          <HeroStat
            label="Hotspot sessions"
            value={live?.hotspotActive == null ? "—" : String(live.hotspotActive)}
            icon={<Wifi className="h-4 w-4" />}
          />
          <HeroStat
            label="Interfaces"
            value={live ? String(live.interfaceCount ?? live.interfaces.length) : "—"}
            icon={<Network className="h-4 w-4" />}
          />
        </div>
      </section>
      {tunnelStatus !== "unknown" ? (
        <TunnelNotification
          tunnelStatus={tunnelStatus}
          routerName={live?.name || live?.identity || "Router"}
          onRetry={() => void retryConnection()}
          polling={true}
        />
      ) : null}
      {error ? (
        <p className="mt-4 notice" role="alert">
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
      {wan ? (
        <section className="mt-6 max-w-md rounded-xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Internet account</h2>
          {sourceUplink ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {sourceUplink.provider || "Provider not set"} on {sourceUplink.interface}
                {sourceUplink.active ? " supplies this router's internet." : " is the only saved uplink."}
              </p>
              {editingAccount ? (
                <form
                  className="mt-3 grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveAccount();
                  }}
                >
                  <FormField
                    id="internet-account"
                    label="Account number"
                    hint="Optional — the account this uplink buys internet on."
                  >
                    <input
                      id="internet-account"
                      className="field"
                      value={accountDraft}
                      maxLength={64}
                      onChange={(event) => setAccountDraft(event.target.value)}
                    />
                  </FormField>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton type="submit" disabled={savingAccount}>
                      {savingAccount ? "Saving…" : "Save account"}
                    </PrimaryButton>
                    <SecondaryButton type="button" disabled={savingAccount} onClick={() => setEditingAccount(false)}>
                      Cancel
                    </SecondaryButton>
                  </div>
                </form>
              ) : (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium tabular-nums">{sourceUplink.accountNumber || "Not registered"}</p>
                  <SecondaryButton
                    type="button"
                    onClick={() => {
                      setAccountDraft(sourceUplink.accountNumber);
                      setAccountNote("");
                      setEditingAccount(true);
                    }}
                  >
                    {sourceUplink.accountNumber ? "Change" : "Register"}
                  </SecondaryButton>
                </div>
              )}
              {accountNote ? <p className="mt-2 text-xs text-muted-foreground">{accountNote}</p> : null}
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Save a WAN uplink on the ports page to register the account this router buys internet on.
            </p>
          )}
        </section>
      ) : null}
      {live?.reachable ? (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="order-2 grid min-w-0 gap-4 lg:order-1">
          <section className="live-panel overflow-x-auto">
            <div className="live-panel-header">
              <h2>
                <span className="live-dot" aria-hidden="true" />
                Interfaces
              </h2>
              <p className="text-caption tabular text-muted-foreground">{live.interfaces.length}</p>
            </div>
            <table className="data-table min-w-[36rem]">
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
            <div className="live-panel-header">
              <h2>
                <span className="live-dot" aria-hidden="true" />
                Health
              </h2>
              <p className="text-caption tabular text-muted-foreground">{live.health?.drops.length ?? 0} drops</p>
            </div>
            <HealthTrend
              range={healthRange}
              trend={(healthRange === "live" ? live.health?.trend : live.health?.trends?.[healthRange] ?? healthTrends[healthRange]) ?? []}
              onRange={setHealthRange}
            />
            <table className="data-table min-w-[36rem]">
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
