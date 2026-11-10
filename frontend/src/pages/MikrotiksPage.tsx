import { useEffect, useMemo, useRef, useState } from "react";
import { HeartPulse, MapPin, Router, Wifi, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useSavedQuery } from "@/hooks/useSavedQuery";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import { cn } from "@/lib/cn";

type PendingAction = {
  action: "suspend" | "delete";
  email: string;
  expiresAt: string | null;
  requestedAt: string | null;
};

type Device = {
  id: string;
  name: string;
  site: string;
  status: string;
  tunnelStatus: "up" | "down" | "unknown" | string;
  healthPercent?: number;
  pendingAction?: PendingAction | null;
  routerosVersion?: string;
  role?: string;
  latitude?: number | null;
  longitude?: number | null;
};

type DevicePage = {
  devices: Device[];
  total: number;
  limit: number;
  offset: number;
  generatedAt?: string;
};

type LocationGroup = {
  key: string;
  label: string;
  devices: Device[];
};

/** Nearby routers share one category: every 0.10° of lat/lon is one cell (~11 km). */
const LOCATION_STEP = 0.1;

function connectionState(tunnelStatus: Device["tunnelStatus"]) {
  if (tunnelStatus === "up") {
    return {
      label: "Online",
      Icon: Wifi,
      iconClass: "bg-success-soft text-success",
    };
  }
  if (tunnelStatus === "down") {
    return {
      label: "Offline",
      Icon: WifiOff,
      iconClass: "bg-destructive-soft text-destructive",
    };
  }
  return {
    label: "Unknown",
    Icon: WifiOff,
    iconClass: "bg-warning-soft text-warning",
  };
}

function healthTone(percent: number, liveDown?: boolean) {
  if (liveDown) return "text-destructive";
  if (percent >= 90) return "text-success";
  if (percent >= 70) return "text-warning";
  return "text-destructive";
}

function healthTrack(percent: number, liveDown?: boolean) {
  if (liveDown) return "stroke-destructive";
  if (percent >= 90) return "stroke-success";
  if (percent >= 70) return "stroke-warning";
  return "stroke-destructive";
}

function HealthMeter({
  percent,
  tunnelStatus,
  checking,
  tick,
  checkedAt,
}: {
  percent: number;
  tunnelStatus: Device["tunnelStatus"];
  checking?: boolean;
  tick?: number;
  checkedAt?: string;
}) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const liveDown = tunnelStatus === "down";
  const liveUp = tunnelStatus === "up";
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const title = liveDown
    ? `Live check: tunnel down · ${value}% uptime over the last 24 hours`
    : liveUp
      ? `Live check: online · ${value}% uptime over the last 24 hours`
      : `Health ${value}% over the last 24 hours`;
  return (
    <div
      className="flex shrink-0 flex-col items-center gap-1"
      title={checkedAt ? `${title} · Checked ${checkedAt}` : title}
    >
      <div className="relative h-12 w-12">
        {liveUp ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-full bg-success/15 animate-badge-ping"
            aria-hidden="true"
          />
        ) : null}
        <svg
          key={tick}
          viewBox="0 0 44 44"
          className={cn("relative h-12 w-12 -rotate-90", checking && "opacity-80")}
          aria-hidden="true"
        >
          <circle cx="22" cy="22" r={radius} fill="none" className="stroke-border" strokeWidth="4" />
          <circle
            cx="22"
            cy="22"
            r={radius}
            fill="none"
            className={cn("transition-[stroke-dashoffset] duration-500 ease-out", healthTrack(value, liveDown))}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
          {checking ? (
            <circle
              cx="22"
              cy="22"
              r={radius}
              fill="none"
              className="stroke-primary/40"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${circumference * 0.22} ${circumference}`}
              style={{ animation: "spin 1.1s linear infinite" }}
            />
          ) : null}
        </svg>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center text-[0.7rem] font-bold tabular",
            healthTone(value, liveDown),
          )}
        >
          {value}%
        </span>
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide",
          liveDown ? "text-destructive" : liveUp ? "text-success" : "text-muted-foreground",
        )}
      >
        <HeartPulse className={cn("h-3 w-3", (liveUp || checking) && "animate-pulse")} aria-hidden="true" />
        {checking ? "Checking" : liveDown ? "Down" : liveUp ? "Live" : "Health"}
        {liveUp && !checking ? <span className="live-dot scale-75" aria-hidden="true" /> : null}
      </span>
      <span className="sr-only">
        {title}
        {checking ? " Checking now." : ""}
      </span>
    </div>
  );
}

function floorStep(value: number, step: number) {
  return Math.floor(value / step) * step;
}

function formatStep(value: number) {
  return value.toFixed(1);
}

function locationKey(device: Device) {
  const lat = device.latitude;
  const lon = device.longitude;
  if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
    return "unlocated";
  }
  const lat0 = floorStep(lat, LOCATION_STEP);
  const lon0 = floorStep(lon, LOCATION_STEP);
  return `${formatStep(lat0)}:${formatStep(lon0)}`;
}

function commonSite(devices: Device[]) {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const site = device.site.trim();
    if (!site) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [site, count] of counts) {
    if (count > bestCount || (count === bestCount && site.localeCompare(best) < 0)) {
      best = site;
      bestCount = count;
    }
  }
  return best;
}

function locationLabel(key: string, devices: Device[]) {
  const site = commonSite(devices);
  if (key === "unlocated") return site || "Unlocated";
  return site || `Area ${key.replace(":", ", ")}`;
}

function deviceHealth(device: Device) {
  return typeof device.healthPercent === "number" ? device.healthPercent : 100;
}

function groupByLocation(devices: Device[]): LocationGroup[] {
  const buckets = new Map<string, Device[]>();
  for (const device of devices) {
    const key = locationKey(device);
    const list = buckets.get(key) ?? [];
    list.push(device);
    buckets.set(key, list);
  }
  const groups: LocationGroup[] = [];
  for (const [key, items] of buckets) {
    const sorted = [...items].sort((a, b) => {
      const healthDelta = deviceHealth(a) - deviceHealth(b);
      if (healthDelta !== 0) return healthDelta;
      return a.name.localeCompare(b.name);
    });
    groups.push({
      key,
      label: locationLabel(key, sorted),
      devices: sorted,
    });
  }
  groups.sort((a, b) => {
    if (a.key === "unlocated") return 1;
    if (b.key === "unlocated") return -1;
    return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
  });
  return groups;
}

export function MikrotiksPage() {
  usePageMeta("Mikrotiks — ISP CENTRIC", "Saved MikroTik records.");
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [locationFilter, setLocationFilter] = useState("all");
  const saved = useSavedQuery<DevicePage>(`/api/mikrotiks?limit=50&offset=${offset}&reload=${reload}`);
  const page = saved.data;
  const [actionError, setActionError] = useState("");
  const [actionNote, setActionNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [healthTick, setHealthTick] = useState(0);
  const [healthChecking, setHealthChecking] = useState(false);
  const lastHealthAt = useRef("");
  const href = (path: string) => (user ? clientPage(user, path) : path);

  const groups = useMemo(() => groupByLocation(page?.devices ?? []), [page?.devices]);
  const visibleGroups = useMemo(
    () => (locationFilter === "all" ? groups : groups.filter((group) => group.key === locationFilter)),
    [groups, locationFilter],
  );

  useEffect(() => {
    if (locationFilter !== "all" && !groups.some((group) => group.key === locationFilter)) {
      setLocationFilter("all");
    }
  }, [groups, locationFilter]);

  useEffect(() => {
    const stamp = page?.generatedAt || "";
    if (!stamp || stamp === lastHealthAt.current) return;
    lastHealthAt.current = stamp;
    setHealthTick((current) => current + 1);
    setHealthChecking(false);
  }, [page?.generatedAt]);

  useEffect(() => {
    if (!page) return;
    // useSavedQuery refreshes every 10s; show the probe spinner shortly before each pass.
    const timer = window.setInterval(() => setHealthChecking(true), 9000);
    return () => window.clearInterval(timer);
  }, [page]);

  async function setSuspended(device: Device, suspended: boolean) {
    setActionError("");
    setActionNote("");
    setBusyId(device.id);
    try {
      if (!suspended) {
        await apiRequest(`/api/mikrotiks/${device.id}/unsuspend`, {
          method: "POST",
          body: "{}",
        });
        setActionNote(`${device.name} was unsuspended.`);
        setReload((current) => current + 1);
        return;
      }
      const body = await apiRequest<{ message?: string; email?: string }>(`/api/mikrotiks/${device.id}/suspend`, {
        method: "POST",
        body: "{}",
      });
      setActionNote(body.message || `A confirmation email was sent${body.email ? ` to ${body.email}` : ""}.`);
      setReload((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The router status could not be changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function requestDelete(device: Device) {
    setActionError("");
    setActionNote("");
    setBusyId(device.id);
    try {
      const body = await apiRequest<{ message?: string; email?: string }>(`/api/mikrotiks/${device.id}/delete`, {
        method: "POST",
        body: "{}",
      });
      setActionNote(body.message || `A confirmation email was sent${body.email ? ` to ${body.email}` : ""}.`);
      setReload((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The router could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelPending(device: Device) {
    setActionError("");
    setActionNote("");
    setBusyId(device.id);
    try {
      await apiRequest(`/api/mikrotiks/${device.id}/cancel-action`, { method: "POST", body: "{}" });
      setActionNote(`The pending ${device.pendingAction?.action || "action"} confirmation was cancelled.`);
      setReload((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The pending confirmation could not be cancelled.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Mikrotiks" description={page ? `${page.total} routers.` : "Loading routers."} />
      {saved.error || actionError ? (
        <p className="notice mt-4" role="alert">
          {saved.error || actionError}
        </p>
      ) : null}
      {actionNote ? (
        <p className="mt-4 rounded-xl border border-success-border/60 bg-success-soft/70 px-4 py-3 text-sm text-success" role="status">
          {actionNote}
        </p>
      ) : null}

      {page?.devices.length === 0 ? (
        <p className="panel mt-6 px-4 py-10 text-center text-sm text-muted-foreground">No routers are saved yet.</p>
      ) : null}

      {!page && !saved.error ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 gap-2">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-3 w-1/3" />
                </div>
                <div className="skeleton h-10 w-10 rounded-xl" />
              </div>
              <div className="mt-5 flex gap-2">
                <div className="skeleton h-9 w-24" />
                <div className="skeleton h-9 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {page && page.devices.length > 0 ? (
        <div className="mt-6 grid gap-6">
          {groups.length > 1 ? (
            <div className="flex flex-wrap gap-2" aria-label="Location categories">
              <button
                type="button"
                onClick={() => setLocationFilter("all")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out",
                  locationFilter === "all"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-surface text-muted-foreground hover:border-primary/50 hover:text-foreground",
                )}
              >
                All
                <span
                  className={cn(
                    "inline-flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold leading-none",
                    locationFilter === "all" ? "bg-primary text-white" : "bg-foreground/10 text-muted-foreground",
                  )}
                >
                  {page.devices.length}
                </span>
              </button>
              {groups.map((group) => {
                const active = locationFilter === group.key;
                return (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => setLocationFilter(group.key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition duration-fast ease-out",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-surface text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    {group.label}
                    <span
                      className={cn(
                        "inline-flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold leading-none",
                        active ? "bg-primary text-white" : "bg-foreground/10 text-muted-foreground",
                      )}
                    >
                      {group.devices.length}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {visibleGroups.map((group) => (
            <section key={group.key} className="grid gap-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{group.label}</span>
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {group.devices.length} router{group.devices.length === 1 ? "" : "s"}
                    {group.key !== "unlocated" ? " in this area" : ""}
                  </p>
                </div>
              </div>
              <ul className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2">
                {group.devices.map((device) => {
                  const suspended = device.status === "suspended";
                  const busy = busyId === device.id;
                  const connection = connectionState(device.tunnelStatus);
                  const StatusIcon = connection.Icon;
                  const healthPercent = typeof device.healthPercent === "number" ? device.healthPercent : 100;
                  return (
                    <li key={device.id} className="w-[min(100%,22rem)] shrink-0 snap-start">
                      <article className="card flex h-full flex-col p-5 transition-transform duration-fast ease-out hover:-translate-y-0.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-muted text-muted-foreground">
                                <Router className="h-4 w-4" aria-hidden="true" />
                              </span>
                              <div className="min-w-0">
                                <h3 className="truncate text-base font-semibold">{device.name}</h3>
                                {device.site ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{device.site}</p> : null}
                              </div>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {suspended ? <StatusBadge tone="suspended">Suspended</StatusBadge> : null}
                              {device.pendingAction ? (
                                <StatusBadge tone="pending">
                                  {device.pendingAction.action === "delete" ? "Delete emailed" : "Suspend emailed"}
                                </StatusBadge>
                              ) : null}
                              {device.routerosVersion ? (
                                <span className="text-xs text-muted-foreground">RouterOS {device.routerosVersion}</span>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-start gap-2">
                            <HealthMeter
                              percent={healthPercent}
                              tunnelStatus={device.tunnelStatus}
                              checking={healthChecking || saved.loading}
                              tick={healthTick}
                              checkedAt={page.generatedAt}
                            />
                            <div
                              className={cn(
                                "relative flex flex-col items-center gap-1 rounded-xl px-2.5 py-2 text-center",
                                connection.iconClass,
                              )}
                              title={
                                page.generatedAt
                                  ? `${connection.label} · Live check ${page.generatedAt}`
                                  : connection.label
                              }
                            >
                              {device.tunnelStatus === "up" ? (
                                <span className="live-dot absolute right-1.5 top-1.5 scale-75" aria-hidden="true" />
                              ) : null}
                              <StatusIcon
                                className={cn("h-5 w-5", healthChecking && device.tunnelStatus === "unknown" && "animate-pulse")}
                                aria-hidden="true"
                              />
                              <span className="text-[0.65rem] font-semibold uppercase tracking-wide">{connection.label}</span>
                              <span className="sr-only">
                                {device.name} is {connection.label.toLowerCase()}
                              </span>
                            </div>
                          </div>
                        </div>

                        {device.pendingAction ? (
                          <p className="mt-4 rounded-xl border border-info-border/60 bg-info-soft/70 px-3 py-2 text-xs text-info">
                            Confirm {device.pendingAction.action} in the email sent to {device.pendingAction.email}
                            {device.pendingAction.expiresAt ? ` · expires ${device.pendingAction.expiresAt}` : ""}.
                          </p>
                        ) : null}

                        <div className="mt-auto flex flex-wrap gap-2 pt-5">
                          <PrimaryButton to={href(`/mikrotiks/${device.id}`)}>View live</PrimaryButton>
                          {device.pendingAction ? (
                            <SecondaryButton type="button" disabled={busy} onClick={() => void cancelPending(device)}>
                              {busy ? "Cancelling…" : "Cancel email"}
                            </SecondaryButton>
                          ) : (
                            <>
                              <SecondaryButton type="button" disabled={busy} onClick={() => void setSuspended(device, !suspended)}>
                                {suspended ? "Unsuspend" : busy ? "Emailing…" : "Suspend"}
                              </SecondaryButton>
                              <SecondaryButton type="button" disabled={busy || busyId !== null} onClick={() => void requestDelete(device)}>
                                {busy ? "Emailing…" : "Delete"}
                              </SecondaryButton>
                            </>
                          )}
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}

      {page && page.total > page.limit ? (
        <div className="mt-4 flex gap-3">
          <PrimaryButton
            type="button"
            disabled={offset === 0}
            onClick={() => {
              setLocationFilter("all");
              setOffset(Math.max(0, offset - page.limit));
            }}
          >
            Previous
          </PrimaryButton>
          <PrimaryButton
            type="button"
            disabled={offset + page.limit >= page.total}
            onClick={() => {
              setLocationFilter("all");
              setOffset(offset + page.limit);
            }}
          >
            Next
          </PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}
