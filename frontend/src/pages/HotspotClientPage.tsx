import { useEffect, useState } from "react";
import { ArrowLeft, Copy, PlugZap, Trash2, Wifi, WifiOff } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { DetailGrid } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Voucher = {
  id: string;
  code: string;
  username: string;
  status: string;
  seconds: number;
  redeemedIp: string;
  redeemedMac: string;
  issuedAt: string | null;
  usedAt: string | null;
};

type GuestSession = {
  username: string;
  label: string;
  start: string | null;
  stop: string | null;
  seconds: number;
  bytesIn: number;
  bytesOut: number;
  ip: string;
  mac: string;
  cause: string;
  live: boolean;
};

type TimelineEvent = { at: string | null; event: string; detail: string };

type LiveSession = {
  username: string;
  label: string;
  ip: string;
  mac: string;
  uptime: string;
  idleTime: string;
  sessionTimeLeft: string;
  bytesIn: number;
  bytesOut: number;
};

type GuestClient = {
  id: string;
  phone: string;
  mac: string;
  ip: string;
  amount: string;
  status: string;
  mpesaCode: string;
  paidAt: string | null;
  createdAt: string | null;
  packageName: string;
  routerName: string;
  devices: number;
  periods: number;
  username: string;
  authorized: boolean;
  endedAt: string | null;
  deleted: boolean;
  connection: "online" | "offline";
};

type GuestDetail = {
  client: GuestClient;
  vouchers: Voucher[];
  usage: { bytesIn: number; bytesOut: number; sessions: number; firstSeen: string | null; lastSeen: string | null };
  sessions: GuestSession[];
  timeline: TimelineEvent[];
  live: LiveSession[];
  routerReachable: boolean;
};

const statusTone: Record<string, "active" | "due" | "critical" | "paused" | "neutral"> = {
  paid: "active",
  pending: "due",
  failed: "critical",
  issued: "neutral",
  used: "active",
  void: "paused",
};

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function duration(seconds: number) {
  if (seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function money(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}

export function HotspotClientPage() {
  const { purchaseId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  usePageMeta("Hotspot client — ISP CENTRIC", "Details, usage, and access for one hotspot guest.");
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [vouchers, setVouchers] = useState(1);
  const [periods, setPeriods] = useState(1);
  const [copied, setCopied] = useState(false);

  const home = (path: string) => (user ? clientPage(user, path) : path);

  function load() {
    apiRequest<GuestDetail>(`/api/hotspot/clients/${purchaseId}`)
      .then((body) => {
        setDetail(body);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }

  useEffect(() => {
    load();
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(refreshIfVisible, 8000);
    return () => window.clearInterval(timer);
  }, [purchaseId]);

  async function act(action: string, body?: Record<string, number>) {
    setBusy(action);
    setMessage("");
    try {
      await apiRequest(`/api/hotspot/clients/${purchaseId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      });
      load();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That action could not be completed.");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function endAccess() {
    if (!window.confirm("End this guest's access? Live sessions are dropped and every voucher is voided.")) return;
    await act("end-access");
  }

  async function recharge() {
    const ok = await act("recharge", { vouchers, periods });
    if (ok) setRechargeOpen(false);
  }

  async function remove() {
    if (!window.confirm("Delete this guest account? Access is revoked and the record is removed from the clients list.")) return;
    const ok = await act("delete");
    if (ok) navigate(home("/clients/hotspot"));
  }

  function copyVouchers() {
    const codes = detail?.vouchers.map((voucher) => voucher.code).join("  ") ?? "";
    if (!codes) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(codes).then(done, done);
    } else {
      done();
    }
  }

  const client = detail?.client ?? null;

  return (
    <div className="page-shell py-8">
      <SecondaryButton to={home("/clients/hotspot")} className="min-h-9">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Hotspot clients
      </SecondaryButton>
      {message ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {message}
        </p>
      ) : null}
      {!detail && !message ? <p className="mt-6 text-sm text-muted-foreground">Loading client…</p> : null}
      {detail && client ? (
        <>
          <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                {client.connection === "online" ? (
                  <Wifi className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <WifiOff className="h-5 w-5" aria-hidden="true" />
                )}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{client.phone || "Hotspot guest"}</h1>
                  <StatusBadge tone={statusTone[client.status] ?? "neutral"}>{client.status}</StatusBadge>
                  <StatusBadge tone={client.connection === "online" ? "active" : "paused"}>
                    {client.connection === "online" ? "Online" : "Offline"}
                  </StatusBadge>
                  {client.deleted ? <StatusBadge tone="critical">Deleted</StatusBadge> : null}
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {client.packageName} on {client.routerName || "this router"} — bought {client.createdAt ?? "—"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton type="button" onClick={() => setRechargeOpen((open) => !open)} disabled={client.deleted}>
                <PlugZap className="h-4 w-4" aria-hidden="true" />
                Recharge
              </SecondaryButton>
              <SecondaryButton type="button" disabled={busy === "end-access" || client.deleted} onClick={() => void endAccess()}>
                End access
              </SecondaryButton>
              <SecondaryButton
                type="button"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={busy === "delete" || client.deleted}
                onClick={() => void remove()}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </SecondaryButton>
            </div>
          </div>

          {rechargeOpen ? (
            <section className="mt-4 grid gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1.5 text-sm font-medium">
                Vouchers
                <input
                  type="number"
                  className="field"
                  min={1}
                  max={50}
                  inputMode="numeric"
                  value={vouchers}
                  onChange={(event) => setVouchers(Math.min(50, Math.max(1, Number(event.target.value) || 1)))}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Periods each (1 = {client.periods > 1 ? `${client.periods} × package period` : "one package period"})
                <input
                  type="number"
                  className="field"
                  min={1}
                  max={60}
                  inputMode="numeric"
                  value={periods}
                  onChange={(event) => setPeriods(Math.min(60, Math.max(1, Number(event.target.value) || 1)))}
                />
              </label>
              <PrimaryButton type="button" disabled={busy === "recharge"} onClick={() => void recharge()}>
                {busy === "recharge" ? "Adding…" : "Add access time"}
              </PrimaryButton>
            </section>
          ) : null}

          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Download</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(detail.usage.bytesIn)}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Upload</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(detail.usage.bytesOut)}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Sessions</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{detail.usage.sessions}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Last seen</p>
              <p className="mt-1 text-sm font-semibold leading-7">{detail.usage.lastSeen ?? "Never"}</p>
            </article>
          </div>

          <section className="mt-6 rounded-xl border border-border bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Live now</h2>
              {detail.routerReachable ? (
                <StatusBadge tone={detail.live.length ? "active" : "paused"}>
                  {detail.live.length ? `${detail.live.length} device${detail.live.length === 1 ? "" : "s"} online` : "Nobody surfing"}
                </StatusBadge>
              ) : (
                <StatusBadge tone="critical">Router unreachable</StatusBadge>
              )}
            </div>
            {!detail.routerReachable ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Live device data comes straight from the router. It did not answer — check that the management tunnel
                and the saved API login still work for {client.routerName || "this router"}.
              </p>
            ) : null}
            {detail.routerReachable && detail.live.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">This guest has no active session on the router right now.</p>
            ) : null}
            {detail.live.length ? (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-[44rem] w-full text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 font-medium">Account</th>
                      <th className="px-2 py-2 font-medium">IP</th>
                      <th className="px-2 py-2 font-medium">MAC</th>
                      <th className="px-2 py-2 font-medium">Uptime</th>
                      <th className="px-2 py-2 font-medium">Idle</th>
                      <th className="px-2 py-2 font-medium">Time left</th>
                      <th className="px-2 py-2 font-medium">Down / Up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.live.map((session) => (
                      <tr key={session.username || session.mac} className="border-b border-border last:border-0">
                        <td className="px-2 py-2 font-medium">{session.label || session.username || "—"}</td>
                        <td className="px-2 py-2">{session.ip || "—"}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{session.mac || "—"}</td>
                        <td className="px-2 py-2">{session.uptime || "—"}</td>
                        <td className="px-2 py-2">{session.idleTime || "—"}</td>
                        <td className="px-2 py-2">{session.sessionTimeLeft || "—"}</td>
                        <td className="px-2 py-2">
                          {bytes(session.bytesIn)} / {bytes(session.bytesOut)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-surface p-5">
              <h2 className="font-semibold">Details</h2>
              <div className="mt-3">
                <DetailGrid
                  items={[
                    { label: "Phone", value: client.phone || "—" },
                    { label: "MAC", value: client.mac || "—" },
                    { label: "IP", value: client.ip || "—" },
                    { label: "Package", value: client.packageName },
                    { label: "Router", value: client.routerName || "—" },
                    { label: "Paid", value: `${money(client.amount)}${client.mpesaCode ? ` · ${client.mpesaCode}` : ""}` },
                    { label: "Requested", value: client.createdAt ?? "—" },
                    { label: "Paid at", value: client.paidAt ?? "—" },
                    { label: "Devices", value: String(client.devices) },
                    { label: "Periods", value: String(client.periods) },
                    { label: "Ended", value: client.endedAt ?? "—" },
                  ]}
                />
              </div>
            </section>

            <section className="rounded-xl border border-border bg-surface p-5">
              <h2 className="font-semibold">Timeline</h2>
              <ol className="mt-3 grid gap-3">
                {detail.timeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events recorded yet.</p>
                ) : null}
                {detail.timeline.map((event, index) => (
                  <li key={index} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-border/60 pb-3 last:border-0">
                    <span className="text-xs leading-5 text-muted-foreground">{event.at ?? "—"}</span>
                    <span>
                      <span className="block text-sm font-medium">{event.event}</span>
                      <span className="block text-xs leading-5 text-muted-foreground">{event.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <section className="mt-6 rounded-xl border border-border bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Vouchers</h2>
              {detail.vouchers.length ? (
                <SecondaryButton type="button" className="min-h-9" onClick={copyVouchers}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {copied ? "Copied" : "Copy codes"}
                </SecondaryButton>
              ) : null}
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-[44rem] w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Code</th>
                    <th className="px-2 py-2 font-medium">Valid for</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Issued</th>
                    <th className="px-2 py-2 font-medium">Used</th>
                    <th className="px-2 py-2 font-medium">Device</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.vouchers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-6 text-muted-foreground">
                        No vouchers issued for this purchase.
                      </td>
                    </tr>
                  ) : null}
                  {detail.vouchers.map((voucher) => (
                    <tr key={voucher.id} className="border-b border-border last:border-0">
                      <td className="px-2 py-2 font-mono text-xs font-semibold text-primary">{voucher.code}</td>
                      <td className="px-2 py-2">{duration(voucher.seconds)}</td>
                      <td className="px-2 py-2">
                        <StatusBadge tone={statusTone[voucher.status] ?? "neutral"}>{voucher.status}</StatusBadge>
                      </td>
                      <td className="px-2 py-2">{voucher.issuedAt ?? "—"}</td>
                      <td className="px-2 py-2">{voucher.usedAt ?? "—"}</td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">{voucher.redeemedMac || voucher.redeemedIp || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 rounded-xl border border-border bg-surface p-5">
            <h2 className="font-semibold">Sessions</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-[48rem] w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Account</th>
                    <th className="px-2 py-2 font-medium">Started</th>
                    <th className="px-2 py-2 font-medium">Stopped</th>
                    <th className="px-2 py-2 font-medium">Length</th>
                    <th className="px-2 py-2 font-medium">Down / Up</th>
                    <th className="px-2 py-2 font-medium">Ended because</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sessions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-6 text-muted-foreground">
                        No sessions have been accounted yet.
                      </td>
                    </tr>
                  ) : null}
                  {detail.sessions.map((session, index) => (
                    <tr key={index} className="border-b border-border last:border-0">
                      <td className="px-2 py-2 font-medium">{session.label}</td>
                      <td className="px-2 py-2">{session.start ?? "—"}</td>
                      <td className="px-2 py-2">
                        {session.live ? <StatusBadge tone="active">Live now</StatusBadge> : session.stop ?? "—"}
                      </td>
                      <td className="px-2 py-2">{duration(session.seconds)}</td>
                      <td className="px-2 py-2">
                        {bytes(session.bytesIn)} / {bytes(session.bytesOut)}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">{session.cause || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
