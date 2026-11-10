import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clock, Search, Users, Wifi, WifiOff } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Subscriber = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  username: string;
  routerName: string;
  routerTunnelStatus: "up" | "down" | "unknown";
  packageName: string;
  status: string;
  connection: "online" | "connected" | "offline" | "unknown";
  routerStatus: "surfing" | "connected" | "not_surfing" | "expired" | "expired_online" | "suspended" | "suspended_online" | "disconnecting" | "disconnected" | "pending_activation";
  billingStatus: string;
  expiry: string | null;
  usedPercent: number | null;
  usedDetail: string;
  payments?: number;
  totalPaid?: string;
};

type ListPage = {
  subscribers: Subscriber[];
  total: number;
  routers: { id: string; name: string }[];
  packages: { id: string; name: string }[];
};

const routerStatusLabel = {
  surfing: "Surfing",
  connected: "Connected",
  not_surfing: "Not surfing",
  expired: "Expired",
  expired_online: "Expired",
  suspended: "Suspended",
  suspended_online: "Suspended",
  disconnecting: "Disconnecting",
  disconnected: "Disconnected",
  pending_activation: "Pending activation",
} as const;

const routerStatusTone = {
  surfing: "active",
  connected: "due",
  not_surfing: "paused",
  expired: "critical",
  expired_online: "due",
  suspended: "due",
  suspended_online: "due",
  disconnecting: "due",
  disconnected: "critical",
  pending_activation: "neutral",
} as const;

function routerHealth(tunnel: Subscriber["routerTunnelStatus"]) {
  if (tunnel === "up") return { dot: "bg-success", text: "Router on and healthy" };
  if (tunnel === "down") return { dot: "bg-destructive", text: "Router disconnected" };
  return { dot: "bg-warning", text: "Router health unknown" };
}

function RouterCell({ client }: { client: Subscriber }) {
  if (!client.routerName) return <span className="text-muted-foreground">—</span>;
  const health = routerHealth(client.routerTunnelStatus);
  return (
    <span className="inline-flex items-center gap-2" title={health.text}>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${health.dot}`} aria-hidden="true" />
      {client.routerName}
    </span>
  );
}

function connectionDot(connection: Subscriber["connection"]) {
  if (connection === "online") return "bg-success";
  if (connection === "connected") return "bg-warning";
  if (connection === "offline") return "bg-destructive";
  return "bg-warning";
}

function initials(client: Subscriber) {
  return `${client.firstName.trim().charAt(0)}${client.lastName.trim().charAt(0)}`.toUpperCase() || "?";
}

function UsedMeter({ percent, detail }: { percent: number | null; detail: string }) {
  if (percent == null) return <span className="text-muted-foreground">—</span>;
  return (
    <div title={detail || undefined} className="grid w-full max-w-[7rem] gap-1">
      <span className="text-xs font-medium tabular sm:text-sm">{percent}%</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-success"}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      {detail ? <span className="truncate text-[11px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function HeroStat({ label, value, icon, tint }: { label: string; value: number | string; icon: ReactNode; tint: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-9 sm:w-9 sm:rounded-xl ${tint}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-base font-semibold leading-tight tracking-tight sm:text-xl">{value}</p>
        <p className="truncate text-[10px] font-medium uppercase tracking-wide text-primary-foreground/70 sm:text-[11px]">
          {label}
        </p>
      </div>
    </div>
  );
}

type Filters = { router: string; package: string; status: string; billing: string; search: string };

const EMPTY_FILTERS: Filters = { router: "", package: "", status: "", billing: "", search: "" };

const STATUS_FILTERS = new Set([
  "surfing",
  "connected",
  "not_surfing",
  "expired",
  "suspended",
  "disconnecting",
  "disconnected",
  "pending_activation",
]);

function filtersFromSearch(params: URLSearchParams): Filters {
  const status = params.get("status")?.trim() || "";
  return {
    router: params.get("router")?.trim() || "",
    package: params.get("package")?.trim() || "",
    status: STATUS_FILTERS.has(status) ? status : "",
    billing: params.get("billing")?.trim() || "",
    search: params.get("q")?.trim() || "",
  };
}

function sameFilters(left: Filters, right: Filters) {
  return (
    left.router === right.router &&
    left.package === right.package &&
    left.status === right.status &&
    left.billing === right.billing &&
    left.search === right.search
  );
}

function writeFilterParams(active: Filters) {
  const params = new URLSearchParams();
  if (active.router) params.set("router", active.router);
  if (active.package) params.set("package", active.package);
  if (active.status) params.set("status", active.status);
  if (active.billing) params.set("billing", active.billing);
  if (active.search.trim()) params.set("q", active.search.trim());
  return params;
}

const desktopRowClass =
  "hidden items-center gap-x-4 px-5 py-3.5 md:grid md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(7.5rem,0.85fr)_minmax(8rem,1fr)_7.75rem_5.75rem] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(5.5rem,0.7fr)_minmax(7.5rem,0.8fr)_minmax(8rem,1fr)_7.75rem_5.75rem]";

export function ClientsPage({ kind }: { kind: "pppoe" | "hotspot" }) {
  usePageMeta(kind === "pppoe" ? "PPPoE-clients — ISP CENTRIC" : "Hotspot-clients — ISP CENTRIC", "ISP subscriber records.");
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState<ListPage | null>(null);
  const [options, setOptions] = useState<Pick<ListPage, "routers" | "packages">>({ routers: [], packages: [] });
  const [message, setMessage] = useState("");
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(searchParams));
  const [applied, setApplied] = useState<Filters>(() => filtersFromSearch(searchParams));
  const label = kind === "pppoe" ? "PPPoE" : "Hotspot";

  const setField = (key: keyof Filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const applyFilters = (next: Filters) => {
    setFilters(next);
    setSearchParams(writeFilterParams(next), { replace: true });
  };
  const resetFilters = () => applyFilters(EMPTY_FILTERS);
  const filtered = Boolean(applied.router || applied.package || applied.status || applied.billing || applied.search.trim());

  function load(active: Filters) {
    const params = writeFilterParams(active);
    params.set("limit", "1000");
    const path = kind === "pppoe" ? "/api/pppoe/subscribers" : "/api/hotspot/subscribers";
    apiRequest<ListPage>(`${path}?${params.toString()}`)
      .then((body) => {
        setPage(body);
        setOptions({ routers: body.routers, packages: body.packages });
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : `${label} clients could not be loaded.`);
      });
  }

  useEffect(() => {
    const next = filtersFromSearch(searchParams);
    setFilters((current) => (sameFilters(current, next) ? current : next));
    setApplied((current) => (sameFilters(current, next) ? current : next));
  }, [kind, searchParams]);

  useEffect(() => {
    setPage(null);
    load(applied);
    // Poll while the tab is visible — paused in the background and cleaned
    // up when the page unmounts.
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") load(applied);
    };
    const timer = window.setInterval(refreshIfVisible, 8000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [kind, applied]);

  const home = (path: string) => (user ? clientPage(user, path) : path);
  const viewPath = (client: Subscriber) => home(kind === "hotspot" ? `/hotspot/${client.id}` : `/pppoe/${client.id}`);

  const clients = page?.subscribers ?? [];
  const surfing = clients.filter((client) => client.routerStatus === "surfing").length;
  const idle = clients.filter((client) => client.routerStatus === "connected" || client.routerStatus === "not_surfing").length;
  const lapsed = clients.filter((client) =>
    ["expired", "expired_online", "suspended", "suspended_online", "disconnecting", "disconnected"].includes(client.routerStatus),
  ).length;

  return (
    <div className="page-shell py-6 sm:py-8">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/85 to-primary/60 text-primary-foreground shadow-card sm:rounded-3xl">
        <div className="flex flex-col gap-4 px-4 pb-4 pt-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4 sm:px-7 sm:pb-5 sm:pt-6">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-foreground/70 sm:text-xs">
              {label} network
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-3xl">{label} clients</h1>
            <p className="mt-1 text-xs text-primary-foreground/75 sm:text-sm">
              {kind === "pppoe" ? "Subscribers who connect with a PPPoE login." : "Subscribers who connect through the hotspot."}
            </p>
          </div>
          {kind === "pppoe" ? (
            <Link
              to={home("/pppoe/register")}
              className="inline-flex min-h-10 w-full items-center justify-center rounded-xl bg-primary-foreground px-4 text-sm font-semibold text-primary shadow-sm transition duration-fast ease-out hover:bg-primary-foreground/90 sm:w-auto"
            >
              + Register PPPoE client
            </Link>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-primary-foreground/15 px-4 py-3 sm:grid-cols-4 sm:gap-x-6 sm:gap-y-4 sm:px-7 sm:py-4">
          <HeroStat label={kind === "hotspot" ? "Devices" : "Clients"} value={page?.total ?? "…"} icon={<Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} tint="bg-primary-foreground/15" />
          <HeroStat label="Surfing" value={surfing} icon={<Wifi className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} tint="bg-success/80" />
          <HeroStat label="Idle" value={idle} icon={<WifiOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} tint="bg-warning/80" />
          <HeroStat label="Expired / off" value={lapsed} icon={<Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} tint="bg-destructive/70" />
        </div>
      </section>

      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      <form
        className="toolbar mt-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(12rem,1.4fr)_repeat(4,minmax(0,1fr))_auto] xl:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters(filters);
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2 lg:col-span-3 xl:col-span-1">
          Search
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input className="field pl-9" value={filters.search} onChange={(event) => setField("search", event.target.value)} placeholder="Name, phone, username, serial" />
          </div>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Router
          <select className="field" value={filters.router} onChange={(event) => setField("router", event.target.value)}>
            <option value="">All routers</option>
            {options.routers.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Package
          <select className="field" value={filters.package} onChange={(event) => setField("package", event.target.value)}>
            <option value="">All packages</option>
            {options.packages.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Status
          <select className="field" value={filters.status} onChange={(event) => setField("status", event.target.value)}>
            <option value="">Any router status</option>
            <option value="surfing">Surfing</option>
            {kind === "hotspot" ? <option value="connected">Connected</option> : null}
            <option value="not_surfing">Not surfing</option>
            <option value="expired">Expired</option>
            {kind === "pppoe" ? <option value="suspended">Suspended</option> : null}
            {kind === "pppoe" ? <option value="disconnecting">Disconnecting</option> : null}
            <option value="disconnected">Disconnected</option>
            <option value="pending_activation">Pending activation</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Billing
          <select className="field" value={filters.billing} onChange={(event) => setField("billing", event.target.value)}>
            <option value="">Any billing</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            {kind === "hotspot" ? <option value="failed">Failed</option> : null}
            {kind === "pppoe" ? <option value="overdue">Overdue</option> : null}
            {kind === "pppoe" ? <option value="suspended">Suspended</option> : null}
            {kind === "pppoe" ? <option value="cancelled">Cancelled</option> : null}
          </select>
        </label>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-1">
          <PrimaryButton type="submit" className="flex-1 xl:flex-none">Filter</PrimaryButton>
          <SecondaryButton type="button" className="flex-1 xl:flex-none" onClick={resetFilters}>Reset</SecondaryButton>
        </div>
      </form>

      <div className="panel mt-4 overflow-hidden">
        <div className={`${desktopRowClass} border-b border-border py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground`}>
          <span>Client</span>
          <span>Phone / username</span>
          <span className="hidden lg:block">Router</span>
          <span>Status</span>
          <span>Package</span>
          <span>Expiry</span>
          <span className="text-right">View</span>
        </div>
        <ul className="divide-y divide-border">
          {!page && !message ? (
            <li className="px-4 py-6 sm:px-5" aria-hidden="true">
              <div className="grid gap-2.5">
                <div className="skeleton h-4 w-2/5" />
                <div className="skeleton h-4 w-3/5" />
                <div className="skeleton h-4 w-1/3" />
              </div>
              <span className="sr-only">Loading {label} clients…</span>
            </li>
          ) : null}
          {page && clients.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground sm:px-5">
              No {label} clients match these filters.
            </li>
          ) : null}
          {clients.map((client) => (
            <li key={client.id} className="transition-colors duration-fast ease-out hover:bg-surface-muted/50">
              <article className="grid gap-3 px-3 py-3.5 sm:px-4 md:hidden">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-xs font-bold text-primary-foreground">
                      {initials(client)}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface ${connectionDot(client.connection)}`}
                      />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold tracking-tight">
                        {client.firstName} {client.lastName}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        <RouterCell client={client} />
                      </p>
                    </div>
                  </div>
                  <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
                </div>

                <dl className="grid grid-cols-2 gap-2 rounded-xl bg-surface-muted/60 px-3 py-2.5 text-xs">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Phone</dt>
                    <dd className="mt-0.5 truncate font-medium">{client.phone || "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Username</dt>
                    <dd className="mt-0.5 truncate font-medium">{client.username || "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Package</dt>
                    <dd className="mt-0.5 truncate font-medium">{client.packageName || "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Expiry</dt>
                    <dd className="mt-0.5 truncate font-semibold tabular text-foreground">{client.expiry ?? "—"}</dd>
                  </div>
                </dl>

                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <UsedMeter percent={client.usedPercent} detail={client.usedDetail} />
                  </div>
                  <SecondaryButton to={viewPath(client)} className="min-h-9 shrink-0 px-3 text-xs">
                    View
                  </SecondaryButton>
                </div>
              </article>

              <div className={desktopRowClass}>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-xs font-bold text-primary-foreground">
                    {initials(client)}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface ${connectionDot(client.connection)}`}
                    />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {client.firstName} {client.lastName}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground lg:hidden">
                      <RouterCell client={client} />
                    </p>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm tabular">{client.phone || "—"}</p>
                  <p className="truncate text-xs text-muted-foreground">{client.username || "—"}</p>
                </div>
                <div className="hidden min-w-0 truncate lg:block">
                  <RouterCell client={client} />
                </div>
                <div className="min-w-0">
                  <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{client.packageName || "—"}</p>
                  <UsedMeter percent={client.usedPercent} detail={client.usedDetail} />
                </div>
                <p className="whitespace-nowrap text-sm font-medium tabular">{client.expiry ?? "—"}</p>
                <div className="flex justify-end">
                  <SecondaryButton to={viewPath(client)} className="min-h-9 w-full justify-center px-3 text-sm">
                    View
                  </SecondaryButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {page ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {page.total} {kind === "hotspot" ? "devices" : "clients"}
          {filtered ? " · filtered" : ""} · {kind === "hotspot" ? "latest payment first" : "sorted by usage"}
        </p>
      ) : null}
    </div>
  );
}
