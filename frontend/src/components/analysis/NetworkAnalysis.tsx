import { Link } from "react-router-dom";
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
    good: "border-success/40",
    warn: "border-warning/40",
    muted: "border-border",
    info: "border-primary/40",
  }[tone];
  const body = (
    <article className={cn("h-full rounded-xl border bg-surface px-4 py-4", toneClass)}>
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </article>
  );
  if (!to) return body;
  return (
    <Link className="block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary" to={to}>
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
        <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
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
