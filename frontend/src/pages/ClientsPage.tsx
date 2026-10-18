import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
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
  packageName: string;
  status: string;
  connection: "online" | "offline" | "unknown";
  routerStatus: "surfing" | "connected" | "not_surfing" | "expired" | "expired_online" | "suspended" | "suspended_online" | "disconnecting" | "disconnected" | "pending_activation";
  billingStatus: string;
  expiry: string | null;
  usedPercent: number | null;
  usedDetail: string;
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
  disconnected: "paused",
  pending_activation: "neutral",
} as const;

const billingLabel = {
  pending: "Pending",
  paid: "Paid",
  overdue: "Overdue",
  suspended: "Suspended",
  cancelled: "Cancelled",
  failed: "Failed",
} as const;

const billingTone = {
  pending: "due",
  paid: "active",
  overdue: "critical",
  suspended: "paused",
  cancelled: "paused",
  failed: "critical",
} as const;

function billingBadge(status: string) {
  const key = status as keyof typeof billingLabel;
  if (!(key in billingLabel)) return null;
  return <StatusBadge tone={billingTone[key]}>{billingLabel[key]}</StatusBadge>;
}

function connectionDot(connection: Subscriber["connection"]) {
  return connection === "online" ? "bg-success" : connection === "offline" ? "bg-destructive" : "bg-warning";
}

function initials(client: Subscriber) {
  return `${client.firstName.trim().charAt(0)}${client.lastName.trim().charAt(0)}`.toUpperCase() || "?";
}

function UsedMeter({ percent, detail }: { percent: number | null; detail: string }) {
  if (percent == null) return <span className="text-muted-foreground">—</span>;
  return (
    <div title={detail || undefined} className="grid w-28 gap-1">
      <span className="font-medium">{percent}%</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-success"}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      {detail ? <span className="text-[11px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}

function HeroStat({ label, value, icon, tint }: { label: string; value: number | string; icon: ReactNode; tint: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tint}`} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-tight tracking-tight sm:text-xl">{value}</p>
        <p className="text-[11px] font-medium uppercase tracking-wide text-primary-foreground/70">{label}</p>
      </div>
    </div>
  );
}

export function ClientsPage({ kind }: { kind: "pppoe" | "hotspot" }) {
  usePageMeta(kind === "pppoe" ? "PPPoE-clients — ISP CENTRIC" : "Hotspot-clients — ISP CENTRIC", "ISP subscriber records.");
  const { user } = useAuth();
  const [page, setPage] = useState<ListPage | null>(null);
  const [message, setMessage] = useState("");
  const [router, setRouter] = useState("");
  const [pkg, setPkg] = useState("");
  const [status, setStatus] = useState("");
  const [billing, setBilling] = useState("");
  const [search, setSearch] = useState("");
  const label = kind === "pppoe" ? "PPPoE" : "Hotspot";

  function load() {
    const params = new URLSearchParams();
    if (router) params.set("router", router);
    if (pkg) params.set("package", pkg);
    if (status) params.set("status", status);
    if (billing) params.set("billing", billing);
    if (search.trim()) params.set("q", search.trim());
    params.set("limit", "1000");
    const path = kind === "pppoe" ? "/api/pppoe/subscribers" : "/api/hotspot/subscribers";
    apiRequest<ListPage>(`${path}?${params.toString()}`)
      .then((body) => {
        setPage(body);
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : `${label} clients could not be loaded.`);
      });
  }

  useEffect(() => {
    setPage(null);
    load();
  }, [kind, router, pkg, status, billing]);

  const home = (path: string) => (user ? clientPage(user, path) : path);
  const viewPath = (client: Subscriber) => home(kind === "hotspot" ? `/hotspot/${client.id}` : `/pppoe/${client.id}`);

  const clients = page?.subscribers ?? [];
  const surfing = clients.filter((client) => client.routerStatus === "surfing").length;
  const idle = clients.filter((client) => client.routerStatus === "connected" || client.routerStatus === "not_surfing").length;
  const lapsed = clients.filter((client) =>
    ["expired", "expired_online", "suspended", "suspended_online", "disconnecting", "disconnected"].includes(client.routerStatus),
  ).length;

  return (
    <div className="page-shell py-8">
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/85 to-primary/60 text-primary-foreground shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 pb-5 pt-6 sm:px-7">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/70">{label} network</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{label} clients</h1>
            <p className="mt-1 text-sm text-primary-foreground/75">
              {kind === "pppoe" ? "Subscribers who connect with a PPPoE login." : "Subscribers who connect through the hotspot."}
            </p>
          </div>
          {kind === "pppoe" ? (
            <Link
              to={home("/pppoe/register")}
              className="inline-flex min-h-10 items-center justify-center rounded-xl bg-primary-foreground px-4 text-sm font-semibold text-primary shadow-sm transition duration-fast ease-out hover:bg-primary-foreground/90"
            >
              + Register PPPoE client
            </Link>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-primary-foreground/15 px-5 py-4 sm:grid-cols-4 sm:px-7">
          <HeroStat label="Clients" value={page?.total ?? "…"} icon={<Users className="h-4 w-4" />} tint="bg-primary-foreground/15" />
          <HeroStat label="Surfing" value={surfing} icon={<Wifi className="h-4 w-4" />} tint="bg-success/80" />
          <HeroStat label="Idle" value={idle} icon={<WifiOff className="h-4 w-4" />} tint="bg-warning/80" />
          <HeroStat label="Expired / off" value={lapsed} icon={<Clock className="h-4 w-4" />} tint="bg-destructive/70" />
        </div>
      </section>

      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      <form
        className="toolbar mt-4 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1fr_auto] lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          load();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          Search
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, phone, username, serial" />
          </div>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Router
          <select className="field" value={router} onChange={(event) => setRouter(event.target.value)}>
            <option value="">All routers</option>
            {page?.routers.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Package
          <select className="field" value={pkg} onChange={(event) => setPkg(event.target.value)}>
            <option value="">All packages</option>
            {page?.packages.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Status
          <select className="field" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Any router status</option>
            <option value="surfing">Surfing</option>
            <option value="connected">Connected</option>
            <option value="not_surfing">Not surfing</option>
            <option value="expired">Expired</option>
            <option value="suspended">Suspended</option>
            <option value="disconnecting">Disconnecting</option>
            <option value="disconnected">Disconnected</option>
            <option value="pending_activation">Pending activation</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Billing
          <select className="field" value={billing} onChange={(event) => setBilling(event.target.value)}>
            <option value="">Any billing</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            {kind === "hotspot" ? <option value="failed">Failed</option> : null}
            {kind === "pppoe" ? <option value="overdue">Overdue</option> : null}
            {kind === "pppoe" ? <option value="suspended">Suspended</option> : null}
            {kind === "pppoe" ? <option value="cancelled">Cancelled</option> : null}
          </select>
        </label>
        <PrimaryButton type="submit">Filter</PrimaryButton>
      </form>

      <div className="table-wrap mt-4 hidden md:block">
        <table className="data-table min-w-[56rem]">
          <thead className="uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Phone / username</th>
              <th className="px-4 py-3 font-medium">Router</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Package / used</th>
              <th className="px-4 py-3 font-medium">Billing / expiry</th>
              <th className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {!page && !message ? (
              <tr>
                <td colSpan={7} className="px-4 py-6">
                  <div className="grid gap-2.5" aria-hidden="true">
                    <div className="skeleton h-4 w-2/5" />
                    <div className="skeleton h-4 w-3/5" />
                    <div className="skeleton h-4 w-1/3" />
                  </div>
                  <span className="sr-only">Loading {label} clients…</span>
                </td>
              </tr>
            ) : null}
            {page && clients.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No {label} clients match these filters.</td>
              </tr>
            ) : null}
            {clients.map((client) => (
              <tr key={client.id} className="border-t border-border transition hover:bg-surface-muted/60">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-xs font-bold text-primary-foreground">
                      {initials(client)}
                      <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface ${connectionDot(client.connection)}`} />
                    </span>
                    <span className="font-medium">{client.firstName} {client.lastName}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div>{client.phone}</div>
                  <div className="text-xs text-muted-foreground">{client.username}</div>
                </td>
                <td className="px-4 py-3">{client.routerName}</td>
                <td className="px-4 py-3">
                  <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
                </td>
                <td className="px-4 py-3">
                  <div className="text-xs font-medium">{client.packageName}</div>
                  <UsedMeter percent={client.usedPercent} detail={client.usedDetail} />
                </td>
                <td className="px-4 py-3">
                  <div className="grid w-max gap-1.5">
                    {billingBadge(client.billingStatus)}
                    <span className="text-xs">{client.expiry ?? "—"}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <SecondaryButton to={viewPath(client)}>View</SecondaryButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 md:hidden">
        {!page && !message ? (
          <div className="card grid gap-3 p-4" aria-hidden="true">
            <div className="skeleton h-4 w-2/5" />
            <div className="skeleton h-4 w-3/5" />
            <div className="skeleton h-4 w-1/3" />
            <span className="sr-only">Loading {label} clients…</span>
          </div>
        ) : null}
        {page && clients.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface px-4 py-8 text-center text-sm text-muted-foreground shadow-card">
            No {label} clients match these filters.
          </p>
        ) : null}
        {clients.map((client) => (
          <article key={client.id} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-sm font-bold text-primary-foreground">
                  {initials(client)}
                  <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface ${connectionDot(client.connection)}`} />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{client.firstName} {client.lastName}</p>
                  <p className="truncate text-xs text-muted-foreground">{client.phone} · {client.username}</p>
                </div>
              </div>
              <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1.5">
                <dt className="text-muted-foreground">Router</dt>
                <dd className="truncate font-medium">{client.routerName || "—"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1.5">
                <dt className="text-muted-foreground">Billing / expiry</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  {billingBadge(client.billingStatus)}
                  <span className="truncate">{client.expiry ?? "—"}</span>
                </dd>
              </div>
            </dl>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="mb-1 truncate text-xs font-medium">{client.packageName || "—"}</p>
                <UsedMeter percent={client.usedPercent} detail={client.usedDetail} />
              </div>
              <SecondaryButton to={viewPath(client)}>View</SecondaryButton>
            </div>
          </article>
        ))}
      </div>

      {page ? <p className="mt-3 text-xs text-muted-foreground">{page.total} clients · sorted by usage</p> : null}
    </div>
  );
}
