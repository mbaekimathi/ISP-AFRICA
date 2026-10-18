import { Link } from "react-router-dom";
import { Activity, CheckCircle2, CircleAlert, CircleMinus } from "lucide-react";
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
}: {
  label: string;
  value: string;
  detail: string;
  to?: string;
  tone: "good" | "warn" | "muted" | "info";
}) {
  const toneClass = {
    good: "border-success-border",
    warn: "border-warning-border",
    muted: "border-border",
    info: "border-info-border",
  }[tone];
  const chipClass = {
    good: "bg-success-soft text-success",
    warn: "bg-warning-soft text-warning",
    muted: "bg-surface-muted text-muted-foreground",
    info: "bg-info-soft text-info",
  }[tone];
  const Icon = {
    good: CheckCircle2,
    warn: CircleAlert,
    muted: CircleMinus,
    info: Activity,
  }[tone];
  const loading = value === "—";
  const body = (
    <article className={cn("card h-full px-4 py-4", toneClass)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", chipClass)} aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
      </div>
      {loading ? (
        <div className="skeleton mt-2 h-7 w-16 sm:h-8" aria-hidden="true" />
      ) : (
        <p className="mt-1 text-h2 font-semibold tabular tracking-tight">{value}</p>
      )}
      <p className="mt-1 text-caption leading-5 text-muted-foreground">{detail}</p>
    </article>
  );
  if (!to) return body;
  return (
    <Link
      className="block h-full rounded-xl outline-none transition-transform duration-fast ease-out hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      to={to}
    >
      {body}
    </Link>
  );
}

function clientCards(counts: ClientCounts | undefined, home: (path: string) => string, base: string) {
  const ready = Boolean(counts);
  const show = (value: number | undefined) => (ready ? String(value ?? 0) : "—");
  return [
    {
      label: "Surfing",
      value: show(counts?.surfing),
      detail: "Clients with an open session",
      to: home(base),
      tone: "good" as const,
    },
    {
      label: "Not surfing",
      value: show(counts?.notSurfing),
      detail: "Active clients with no session",
      to: home(base),
      tone: "muted" as const,
    },
    {
      label: "Expired",
      value: show(counts?.expired),
      detail: "Package date has passed",
      to: home(base),
      tone: "warn" as const,
    },
    {
      label: "Disconnected",
      value: show(counts?.disconnected),
      detail: "Suspended or a disconnect in progress",
      to: home(base),
      tone: "warn" as const,
    },
  ];
}

export function NetworkAnalysis() {
  const { user } = useAuth();
  const { data, error, loading } = useSavedQuery<Summary>("/api/dashboard/summary");
  const summary = data?.summary;
  const home = (path: string) => (user ? clientPage(user, path) : path);
  const routers = summary?.routers;

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
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Metric
            label="Online"
            value={routers ? String(routers.online) : "—"}
            detail="Management tunnel is up"
            to={home("/mikrotiks")}
            tone="good"
          />
          <Metric
            label="Offline"
            value={routers ? String(routers.offline) : "—"}
            detail={routers ? `${routers.tunnelDown} down · ${routers.tunnelUnknown} not observed` : "Tunnel down or not observed"}
            to={home("/mikrotiks")}
            tone="warn"
          />
          <Metric
            label="Health"
            value={routers ? String(routers.healthy) : "—"}
            detail={routers ? `${routers.unhealthy} with an open health issue` : "Routers with no open health issue"}
            to={home("/mikrotiks")}
            tone="info"
          />
        </div>
      </section>
      <section>
        <h2 className="text-sm font-semibold">PPPoE clients</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {clientCards(summary?.clients.pppoe, home, "/clients").map((card) => (
            <Metric key={card.label} {...card} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-sm font-semibold">Hotspot clients</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="PPPoE download"
            value={summary ? bytes(summary.usageToday.pppoe.bytesIn) : "—"}
            detail="Download accounted today"
            to={home("/clients/usage")}
            tone="info"
          />
          <Metric
            label="PPPoE upload"
            value={summary ? bytes(summary.usageToday.pppoe.bytesOut) : "—"}
            detail="Upload accounted today"
            to={home("/clients/usage")}
            tone="info"
          />
          <Metric
            label="Hotspot download"
            value={summary ? bytes(summary.usageToday.hotspot.bytesIn) : "—"}
            detail="Download accounted today"
            to={home("/clients/hotspot/usage")}
            tone="info"
          />
          <Metric
            label="Hotspot upload"
            value={summary ? bytes(summary.usageToday.hotspot.bytesOut) : "—"}
            detail="Upload accounted today"
            to={home("/clients/hotspot/usage")}
            tone="info"
          />
        </div>
      </section>
    </div>
  );
}
