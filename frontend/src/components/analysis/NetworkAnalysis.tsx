import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarX2,
  CloudOff,
  HeartPulse,
  Router,
  Unplug,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useSavedQuery } from "@/hooks/useSavedQuery";
import { clientPage } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type ClientCounts = {
  surfing: number;
  notSurfing: number;
  expired: number;
  disconnected: number;
  total: number;
};

type Usage = {
  bytesIn: number;
  bytesOut: number;
};

type RouterUsage = {
  id: string;
  name: string;
  site: string;
  tunnelStatus: string;
  subscribers: number;
  openSessions: number;
  hotspotGuests: number;
  hotspotSessions: number;
  pppoe: Usage;
  hotspot: Usage;
  bytesIn: number;
  bytesOut: number;
};

type Summary = {
  summary: {
    generatedAt: string;
    routers: {
      total: number;
      online: number;
      offline: number;
      healthy: number;
      unhealthy: number;
      tunnelDown: number;
      tunnelUnknown: number;
    };
    clients: {
      pppoe: ClientCounts;
      hotspot: ClientCounts;
    };
    usageToday: {
      pppoe: Usage;
      hotspot: Usage;
    };
    usageByRouter?: RouterUsage[];
  };
};

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function Metric({
  label,
  value,
  detail,
  to,
  tone,
  icon: Icon,
  live = false,
}: {
  label: string;
  value: string;
  detail: string;
  to?: string;
  tone: "good" | "warn" | "muted" | "info" | "critical";
  icon: LucideIcon;
  live?: boolean;
}) {
  const toneClass = {
    good: "border-success-border",
    warn: "border-warning-border",
    muted: "border-border",
    info: "border-info-border",
    critical: "border-destructive-border",
  }[tone];
  const chipClass = {
    good: "bg-success-soft text-success",
    warn: "bg-warning-soft text-warning",
    muted: "bg-surface-muted text-muted-foreground",
    info: "bg-info-soft text-info",
    critical: "bg-destructive-soft text-destructive",
  }[tone];
  const loading = value === "—";
  const active = live && !loading && value !== "0";
  const body = (
    <article className={cn("card flex h-full min-w-0 flex-col overflow-hidden px-2 py-2 sm:px-4 sm:py-4", toneClass)}>
      <div className="flex items-center gap-1.5 sm:gap-2.5">
        <span
          className={cn(
            "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8 sm:rounded-lg",
            chipClass,
          )}
          aria-hidden="true"
        >
          <Icon className={cn("h-3.5 w-3.5 sm:h-4 sm:w-4", active && "animate-pulse")} />
          {active ? (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-current ring-2 ring-surface" />
          ) : null}
        </span>
        <h3 className="min-w-0 flex-1 text-[9px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground sm:text-caption">
          {label}
        </h3>
      </div>
      {loading ? (
        <div className="skeleton mt-2 h-5 w-8 sm:mt-3 sm:h-8 sm:w-14" aria-hidden="true" />
      ) : (
        <p className="mt-1.5 text-lg font-semibold tabular tracking-tight sm:mt-2 sm:text-h2">{value}</p>
      )}
      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground sm:mt-1 sm:text-caption sm:leading-5">
        {detail}
      </p>
    </article>
  );
  if (!to) return body;
  return (
    <Link
      className="block h-full min-w-0 rounded-xl outline-none transition-transform duration-fast ease-out hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      to={to}
    >
      {body}
    </Link>
  );
}

function clientCards(counts: ClientCounts | undefined, home: (path: string) => string, base: string) {
  const ready = Boolean(counts);
  const show = (value: number | undefined) => (ready ? String(value ?? 0) : "—");
  const filtered = (status: string) => `${home(base)}?status=${status}`;
  return [
    {
      label: "Surfing",
      value: show(counts?.surfing),
      detail: "Open session now",
      to: filtered("surfing"),
      tone: "good" as const,
      icon: Wifi,
      live: true,
    },
    {
      label: "Not surfing",
      value: show(counts?.notSurfing),
      detail: "Active, no session",
      to: filtered("not_surfing"),
      tone: "muted" as const,
      icon: WifiOff,
    },
    {
      label: "Expired",
      value: show(counts?.expired),
      detail: "Package date passed",
      to: filtered("expired"),
      tone: "warn" as const,
      icon: CalendarX2,
    },
    {
      label: "Disconnected",
      value: show(counts?.disconnected),
      detail: "Suspended or offline",
      to: filtered("disconnected"),
      tone: "critical" as const,
      icon: Unplug,
    },
  ];
}

export function NetworkAnalysis() {
  const { user } = useAuth();
  const { data, error, loading } = useSavedQuery<Summary>("/api/dashboard/summary");
  const summary = data?.summary;
  const home = (path: string) => (user ? clientPage(user, path) : path);
  const routers = summary?.routers;
  const healthPercent = routers && routers.total ? Math.round((routers.healthy / routers.total) * 100) : 0;

  return (
    <div className="mt-6 space-y-6">
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold">Mikrotiks</h2>
          <p className="text-xs text-muted-foreground">
            {summary ? `Saved at ${summary.generatedAt}. ${routers?.total ?? 0} routers.` : loading ? "Loading router analysis." : "Router analysis is unavailable."}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-3">
          <Metric
            label="Online"
            value={routers ? String(routers.online) : "—"}
            detail="Tunnel is up"
            to={home("/mikrotiks")}
            tone="good"
            icon={Router}
            live
          />
          <Metric
            label="Offline"
            value={routers ? String(routers.offline) : "—"}
            detail={
              routers
                ? `${routers.tunnelDown} down · ${routers.tunnelUnknown} unknown`
                : "Tunnel down"
            }
            to={home("/mikrotiks")}
            tone="critical"
            icon={CloudOff}
          />
          <Metric
            label="Health"
            value={routers ? `${healthPercent}%` : "—"}
            detail={
              routers
                ? routers.total
                  ? `${routers.healthy}/${routers.total} healthy`
                  : "No routers yet"
                : "No open issues"
            }
            to={home("/mikrotiks")}
            tone="info"
            icon={HeartPulse}
            live
          />
        </div>
      </section>
      <section>
        <h2 className="text-sm font-semibold">PPPoE clients</h2>
        <div className="mt-3 grid grid-cols-4 gap-1.5 sm:gap-3">
          {clientCards(summary?.clients.pppoe, home, "/clients").map((card) => (
            <Metric key={card.label} {...card} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-sm font-semibold">Hotspot clients</h2>
        <div className="mt-3 grid grid-cols-4 gap-1.5 sm:gap-3">
          {clientCards(summary?.clients.hotspot, home, "/clients/hotspot").map((card) => (
            <Metric key={card.label} {...card} />
          ))}
        </div>
      </section>
      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold">Today&apos;s usage</h2>
          <p className="text-xs text-muted-foreground">Sessions that started today</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-3">
          <Metric
            label="PPPoE down"
            value={summary ? bytes(summary.usageToday.pppoe.bytesIn) : "—"}
            detail="Download today"
            to={home("/clients/usage")}
            tone="info"
            icon={ArrowDownToLine}
          />
          <Metric
            label="PPPoE up"
            value={summary ? bytes(summary.usageToday.pppoe.bytesOut) : "—"}
            detail="Upload today"
            to={home("/clients/usage")}
            tone="info"
            icon={ArrowUpFromLine}
          />
          <Metric
            label="Hotspot down"
            value={summary ? bytes(summary.usageToday.hotspot.bytesIn) : "—"}
            detail="Download today"
            to={home("/clients/hotspot/usage")}
            tone="info"
            icon={ArrowDownToLine}
          />
          <Metric
            label="Hotspot up"
            value={summary ? bytes(summary.usageToday.hotspot.bytesOut) : "—"}
            detail="Upload today"
            to={home("/clients/hotspot/usage")}
            tone="info"
            icon={ArrowUpFromLine}
          />
        </div>
      </section>
      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold">Usage per MikroTik</h2>
          <p className="text-xs text-muted-foreground">Sessions that started today, grouped by router</p>
        </div>
        <RouterUsageList routers={summary?.usageByRouter} loading={loading && !summary} home={home} />
      </section>
    </div>
  );
}

function RouterUsageList({
  routers,
  loading,
  home,
}: {
  routers: RouterUsage[] | undefined;
  loading: boolean;
  home: (path: string) => string;
}) {
  if (loading) {
    return (
      <div className="mt-3 flex gap-3 overflow-x-auto pb-2" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="card w-64 shrink-0 px-4 py-4">
            <div className="grid gap-3">
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton h-3 w-3/4" />
              <div className="skeleton h-6 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!routers) return null;
  if (routers.length === 0) {
    return (
      <div className="panel mt-3 px-4 py-10 text-center text-sm text-muted-foreground">No routers are saved yet.</div>
    );
  }
  const peak = Math.max(1, ...routers.map((router) => router.bytesIn + router.bytesOut));
  return (
    <ol className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
      {routers.map((router) => {
        const total = router.bytesIn + router.bytesOut;
        const online = router.tunnelStatus === "up";
        return (
          <li key={router.id} className="w-64 shrink-0 snap-start">
            <Link
              to={home(`/mikrotiks/${router.id}`)}
              className="card flex h-full flex-col px-4 py-4 outline-none transition-transform duration-fast ease-out hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{router.name}</p>
                <StatusBadge tone={online ? "online" : "offline"}>{online ? "Online" : "Offline"}</StatusBadge>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {router.site ? `${router.site} · ` : ""}
                {router.subscribers} PPPoE {router.subscribers === 1 ? "client" : "clients"}
                {router.hotspotGuests
                  ? ` · ${router.hotspotGuests} hotspot ${router.hotspotGuests === 1 ? "guest" : "guests"}`
                  : ""}
                {" · "}
                {router.openSessions + router.hotspotSessions} surfing
              </p>
              <div className="mt-3">
                <p className="text-lg font-semibold tabular tracking-tight">{bytes(total)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular">
                  ↓ {bytes(router.bytesIn)} · ↑ {bytes(router.bytesOut)}
                </p>
              </div>
              <div className="mt-auto pt-4">
                <div
                  className="h-1.5 rounded-full bg-surface-muted"
                  role="img"
                  aria-label={`${bytes(total)} of ${bytes(peak)}`}
                >
                  <div
                    className="h-full rounded-full bg-gradient-brand"
                    style={{ width: `${Math.max(total > 0 ? 2 : 0, (total / peak) * 100)}%` }}
                  />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
