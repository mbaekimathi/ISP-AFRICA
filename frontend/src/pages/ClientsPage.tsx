import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/DetailGrid";
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
  const [busy, setBusy] = useState("");

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

  async function act(id: string, action: "suspend" | "reactivate" | "disconnect" | "activate" | "delete") {
    let reason = "";
    if (action === "suspend" || action === "reactivate") {
      const entered = window.prompt(action === "suspend" ? "Why is this client being suspended?" : "Reason for continuing, if this is an override.");
      if (entered === null) return;
      reason = entered;
    }
    if (action === "suspend" && !reason.trim()) return;
    const question =
      action === "disconnect"
        ? `Disconnect the open ${label} session?`
        : action === "delete"
          ? `Delete this ${label} client? Their access is revoked, live sessions are dropped, and they leave this list. Billing history is kept.`
          : action === "activate"
            ? `Approve this ${label} client and start the service?`
            : `${action === "suspend" ? "Suspend" : "Continue"} this ${label} client?`;
    if (!window.confirm(question)) return;
    setBusy(id);
    setMessage("");
    try {
      await apiRequest(`/api/pppoe/subscribers/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(
          action === "reactivate" ? { override: true, reason } : action === "activate" || action === "delete" ? {} : { reason, mode: "session" },
        ),
      });
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusy("");
    }
  }

  async function hotspotDelete(id: string) {
    if (!window.confirm("Delete this hotspot guest? Access ends, vouchers are voided, and they leave this list.")) return;
    setBusy(id);
    setMessage("");
    try {
      await apiRequest(`/api/hotspot/clients/${id}/delete`, { method: "POST", body: JSON.stringify({}) });
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusy("");
    }
  }

  async function hotspotRecharge(id: string) {
    if (!window.confirm("Recharge this guest — mint a voucher for every device on the router and connect it?")) return;
    setBusy(id);
    setMessage("");
    try {
      const result = await apiRequest<{ result: { connected: number; vouchers: { code: string; status: string }[] } }>(
        `/api/hotspot/clients/${id}/recharge`,
        { method: "POST", body: JSON.stringify({ vouchers: 1, periods: 1 }) },
      );
      const spare = result.result.vouchers.filter((voucher) => voucher.status === "issued").map((voucher) => voucher.code);
      setMessage(
        result.result.connected
          ? `${result.result.connected} device(s) are online now.${spare.length ? ` Unused voucher: ${spare.join(", ")}` : ""}`
          : `No registered device is on the router. Voucher issued: ${spare.join(", ") || "—"}.`,
      );
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusy("");
    }
  }

  const home = (path: string) => (user ? clientPage(user, path) : path);

  return (
    <div className="page-shell py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title={kind === "pppoe" ? "PPPoE-clients" : "Hotspot-clients"}
          description={kind === "pppoe" ? "Subscribers who connect with a PPPoE login." : "Subscribers who connect through the hotspot."}
        />
        {kind === "pppoe" ? <PrimaryButton to={home("/pppoe/register")}>+ Register PPPoE Client</PrimaryButton> : null}
      </div>
      {message ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {message}
        </p>
      ) : null}
      <form
        className="mt-6 grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          load();
        }}
      >
        <label className="grid gap-1.5 text-sm font-medium">
          Search
          <input className="field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, phone, username, serial" />
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
        <div className="flex items-end">
          <SecondaryButton type="submit">Search</SecondaryButton>
        </div>
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
      </form>
      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="min-w-[64rem] w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">Name</th>
              <th className="px-3 py-3 font-medium">Phone / username</th>
              <th className="px-3 py-3 font-medium">Router</th>
              <th className="px-3 py-3 font-medium">Package</th>
              <th className="px-3 py-3 font-medium">Router status</th>
              <th className="px-3 py-3 font-medium">Billing</th>
              <th className="px-3 py-3 font-medium">Expiry</th>
              <th className="px-3 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!page && !message ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-muted-foreground">Loading {label} clients…</td>
              </tr>
            ) : null}
            {page?.subscribers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-muted-foreground">No {label} clients match these filters.</td>
              </tr>
            ) : null}
            {page?.subscribers.map((client) => (
              <tr key={client.id} className="border-b border-border last:border-0">
                <td className="px-3 py-3 font-medium">{client.firstName} {client.lastName}</td>
                <td className="px-3 py-3">
                  <div>{client.phone}</div>
                  <div className="text-xs text-muted-foreground">{client.username}</div>
                </td>
                <td className="px-3 py-3">{client.routerName}</td>
                <td className="px-3 py-3">{client.packageName}</td>
                <td className="px-3 py-3">
                  <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
                </td>
                <td className="px-3 py-3">{client.billingStatus}</td>
                <td className="px-3 py-3">{client.expiry ?? "—"}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-2">
                    {kind === "hotspot" ? <SecondaryButton to={home(`/hotspot/${client.id}`)}>View</SecondaryButton> : null}
                    {kind === "hotspot" ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void hotspotRecharge(client.id)}>
                        Recharge
                      </SecondaryButton>
                    ) : null}
                    {kind === "hotspot" ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void hotspotDelete(client.id)}>
                        Delete
                      </SecondaryButton>
                    ) : null}
                    {kind === "pppoe" ? <SecondaryButton to={home(`/pppoe/${client.id}`)}>View</SecondaryButton> : null}
                    {kind === "pppoe" ? <SecondaryButton to={`${home(`/pppoe/${client.id}/transactions`)}?pay=1`}>Recharge</SecondaryButton> : null}
                    {kind === "pppoe" ? <SecondaryButton to={home(`/pppoe/${client.id}?edit=1`)}>Edit</SecondaryButton> : null}
                    {kind === "pppoe" && client.status === "pending_activation" ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void act(client.id, "activate")}>
                        Approve
                      </SecondaryButton>
                    ) : null}
                    {kind === "pppoe" && client.status !== "pending_activation" ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void act(client.id, client.status === "suspended" ? "reactivate" : "suspend")}>
                        {client.status === "suspended" ? "Continue" : "Suspend"}
                      </SecondaryButton>
                    ) : null}
                    {kind === "pppoe" && (client.routerStatus === "surfing" || client.routerStatus === "expired_online" || client.routerStatus === "suspended_online") ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void act(client.id, "disconnect")}>Disconnect</SecondaryButton>
                    ) : null}
                    {kind === "pppoe" ? (
                      <SecondaryButton type="button" disabled={busy === client.id} onClick={() => void act(client.id, "delete")}>
                        Delete
                      </SecondaryButton>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page ? <p className="mt-3 text-xs text-muted-foreground">{page.total} clients</p> : null}
    </div>
  );
}
