import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, MonitorSmartphone } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import type { Subscriber } from "@/pages/PppoeCustomerPage";

const DEFAULT_USER = "admin";

type SavedAccess = {
  password: string;
};

type RemoteAccessSession = {
  url: string;
  target: string;
  expiresAt: number;
  tunnelIp: string;
  listenPort: number | null;
  mode?: string;
};

type RemoteAccessStatus = {
  state: "ready" | "session-open" | "tunnel-down" | "client-offline" | "no-address" | "no-tunnel" | string;
  label: string;
  ready: boolean;
  tunnelStatus: "up" | "down" | "unknown" | string;
  tunnelIp: string;
  cpeIp: string;
  connection: "online" | "offline" | "unknown" | string;
  routerName: string;
  session: RemoteAccessSession | null;
};

function savedAccessKey(subscriberId: string) {
  return `isp.remote-access.${subscriberId}`;
}

function loadSavedPassword(subscriberId: string): string {
  try {
    const raw = window.localStorage.getItem(savedAccessKey(subscriberId));
    if (!raw) return "";
    const saved = JSON.parse(raw) as SavedAccess & { password?: string };
    return typeof saved.password === "string" ? saved.password : "";
  } catch {
    return "";
  }
}

function routerHost(subscriber: Subscriber, status: RemoteAccessStatus | null) {
  if (status?.cpeIp) return status.cpeIp;
  const cpe = (subscriber.devices ?? []).find((device) => device.kind === "router");
  return (subscriber.live.ip || subscriber.staticIp || cpe?.ip || "").trim();
}

function accessTone(status: RemoteAccessStatus | null): StatusTone {
  if (!status) return "neutral";
  if (status.state === "session-open" || status.state === "ready") return "online";
  if (status.state === "client-offline" || status.state === "no-address") return "due";
  if (status.state === "tunnel-down" || status.state === "no-tunnel") return "offline";
  return "neutral";
}

function tunnelTone(status: string): StatusTone {
  if (status === "up") return "online";
  if (status === "down") return "offline";
  return "due";
}

function tunnelLabel(status: string) {
  if (status === "up") return "Tunnel up";
  if (status === "down") return "Tunnel down";
  return "Tunnel unknown";
}

function expiresLabel(expiresAt: number) {
  const seconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m left`;
}

export function PppoeRemoteAccessPage() {
  const { subscriberId = "" } = useParams();
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [access, setAccess] = useState<RemoteAccessStatus | null>(null);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [session, setSession] = useState<RemoteAccessSession | null>(null);
  const [error, setError] = useState("");

  usePageMeta("Remote access — ISP CENTRIC", "Open the client's router page remotely.");

  const refreshStatus = useCallback(() => {
    return apiRequest<{ remoteAccess: RemoteAccessStatus }>(`/api/pppoe/subscribers/${subscriberId}/remote-access`)
      .then((body) => {
        setAccess(body.remoteAccess);
        if (body.remoteAccess.session) setSession(body.remoteAccess.session);
        return body.remoteAccess;
      })
      .catch(() => null);
  }, [subscriberId]);

  useEffect(() => {
    apiRequest<{ subscriber: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}`)
      .then((body) => {
        setSubscriber(body.subscriber);
        setPassword(loadSavedPassword(subscriberId));
        setMessage("");
        if (body.subscriber.remoteAccess) setAccess(body.subscriber.remoteAccess);
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
    refreshStatus();
  }, [subscriberId, refreshStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshStatus();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setOpened(false);
    setSession(null);
    if (!subscriber) return;

    const host = routerHost(subscriber, access);
    if (!host) {
      setError("This client has no router address yet. Wait until their session is online.");
      return;
    }
    if (!password.trim()) {
      setError("Enter the router password.");
      return;
    }

    try {
      window.localStorage.setItem(savedAccessKey(subscriberId), JSON.stringify({ password } satisfies SavedAccess));
    } catch {
      // Storage unavailable — connecting still works.
    }

    setBusy(true);
    try {
      const body = await apiRequest<{ remoteAccess: RemoteAccessSession }>(
        `/api/pppoe/subscribers/${subscriberId}/remote-access`,
        {
          method: "POST",
          body: JSON.stringify({ password, username: DEFAULT_USER }),
        },
      );
      setSession(body.remoteAccess);
      await refreshStatus();
      const tab = window.open(body.remoteAccess.url, "_blank", "noopener,noreferrer");
      if (tab) {
        setOpened(true);
      } else {
        window.location.assign(body.remoteAccess.url);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Remote access could not be opened.");
      refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  if (!subscriber) {
    if (message) {
      return <div className="page-shell py-8 text-sm text-muted-foreground">{message}</div>;
    }
    return <LiveLoad label="Loading client" />;
  }

  const home = (path: string) => (user ? clientPage(user, path) : path);
  const online = (access?.connection || subscriber.connection) === "online";
  const host = routerHost(subscriber, access);
  const target = host ? `http://${host}` : "";
  const canOpen = Boolean(host && password.trim() && access?.tunnelStatus === "up");

  return (
    <div className="page-shell py-8">
      <SecondaryButton to={home(`/pppoe/${subscriberId}`)}>
        <ArrowLeft className="h-4 w-4" />
        Back to customer
      </SecondaryButton>

      <section className="mt-4 rounded-2xl border border-border bg-surface shadow-card">
        <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
              Remote access — {subscriber.firstName} {subscriber.lastName}
            </h1>
            <StatusBadge tone={online ? "online" : "offline"}>{online ? "Online" : "Offline"}</StatusBadge>
            <StatusBadge tone={accessTone(access)}>{access?.label || "Checking…"}</StatusBadge>
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {subscriber.phone} · {subscriber.username} · {subscriber.packageName}
          </p>
        </div>
      </section>

      <section className="mt-4 max-w-xl rounded-2xl border border-border bg-surface p-5 shadow-card sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Tunnel status</h2>
          <StatusBadge tone={tunnelTone(access?.tunnelStatus || "unknown")}>
            {tunnelLabel(access?.tunnelStatus || "unknown")}
          </StatusBadge>
        </div>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">MikroTik</dt>
            <dd className="text-right font-medium text-foreground">{access?.routerName || subscriber.routerName || "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Management tunnel</dt>
            <dd className="text-right font-medium text-foreground">{access?.tunnelIp || "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Client router IP</dt>
            <dd className="text-right font-medium text-foreground">{access?.cpeIp || host || "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Remote access</dt>
            <dd className="text-right font-medium text-foreground">{access?.label || "—"}</dd>
          </div>
          {access?.session ? (
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">Open session</dt>
              <dd className="text-right font-medium text-foreground">
                {access.session.mode || "proxy"} · {expiresLabel(access.session.expiresAt)}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="mt-4 max-w-xl rounded-2xl border border-border bg-surface p-5 shadow-card sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <MonitorSmartphone className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold">Open router</h2>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Opens this client's router page through the management tunnel. Your browser never talks to the private PPPoE
          address — surfing clients and live MikroTik settings stay untouched.
        </p>
        {access?.state === "tunnel-down" || access?.state === "no-tunnel" ? (
          <p className="notice mt-3">The management tunnel is not up — remote access cannot reach this client's router yet.</p>
        ) : null}
        {!online ? (
          <p className="notice mt-3">The client is offline right now — the router page may not answer until their session is up.</p>
        ) : null}
        {!host ? (
          <p className="notice mt-3">No router address is available for this client yet.</p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Target: <span className="font-medium text-foreground">{target}</span> · user{" "}
            <span className="font-medium text-foreground">{DEFAULT_USER}</span>
          </p>
        )}
        <form className="mt-4 grid gap-3" onSubmit={connect}>
          <FormField id="remote-password" label="Router password" hint="Remembered on this device. Sent only to open a short-lived tunnel session.">
            <input
              id="remote-password"
              type="password"
              className="field"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </FormField>
          {error ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <PrimaryButton type="submit" disabled={!canOpen || busy}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              {busy ? "Opening…" : "Open router page"}
            </PrimaryButton>
          </div>
        </form>
      </section>

      {opened && session ? (
        <p className="notice mt-4">
          Router page opened through the tunnel toward {session.target}. Session expires automatically after idle use.
        </p>
      ) : null}
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
