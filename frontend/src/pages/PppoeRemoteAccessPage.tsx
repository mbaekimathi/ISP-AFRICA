import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, MonitorSmartphone } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import type { Subscriber } from "@/pages/PppoeCustomerPage";

const DEFAULT_USER = "admin";
const DEFAULT_PROTOCOL = "http";
const DEFAULT_PORT = "80";

type SavedAccess = {
  password: string;
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

function routerHost(subscriber: Subscriber) {
  const cpe = (subscriber.devices ?? []).find((device) => device.kind === "router");
  return (subscriber.live.ip || subscriber.staticIp || cpe?.ip || "").trim();
}

function buildRouterUrl(host: string, password: string) {
  const url = new URL(`${DEFAULT_PROTOCOL}://${host}`);
  url.port = DEFAULT_PORT;
  url.username = DEFAULT_USER;
  if (password) url.password = password;
  return url;
}

export function PppoeRemoteAccessPage() {
  const { subscriberId = "" } = useParams();
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");

  usePageMeta("Remote access — ISP CENTRIC", "Open the client's router page remotely.");

  useEffect(() => {
    apiRequest<{ subscriber: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}`)
      .then((body) => {
        setSubscriber(body.subscriber);
        setPassword(loadSavedPassword(subscriberId));
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }, [subscriberId]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setOpened(false);
    if (!subscriber) return;

    const host = routerHost(subscriber);
    if (!host) {
      setError("This client has no router address yet. Wait until their session is online.");
      return;
    }
    if (!password.trim()) {
      setError("Enter the router password.");
      return;
    }

    let url: URL;
    try {
      url = buildRouterUrl(host, password);
    } catch {
      setError("The router address on this account is not valid.");
      return;
    }

    try {
      window.localStorage.setItem(savedAccessKey(subscriberId), JSON.stringify({ password } satisfies SavedAccess));
    } catch {
      // Storage unavailable — connecting still works.
    }

    const tab = window.open(url.href, "_blank", "noopener,noreferrer");
    if (tab) {
      setOpened(true);
    } else {
      window.location.assign(url.href);
    }
  }

  if (!subscriber) {
    if (message) {
      return <div className="page-shell py-8 text-sm text-muted-foreground">{message}</div>;
    }
    return <LiveLoad label="Loading client" />;
  }

  const home = (path: string) => (user ? clientPage(user, path) : path);
  const online = subscriber.connection === "online";
  const host = routerHost(subscriber);
  const target = host ? `${DEFAULT_PROTOCOL}://${host}` : "";

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
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {subscriber.phone} · {subscriber.username} · {subscriber.packageName}
          </p>
        </div>
      </section>

      <section className="mt-4 max-w-xl rounded-2xl border border-border bg-surface p-5 shadow-card sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
            <MonitorSmartphone className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold">Open router</h2>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Opens this client's router page in a new tab. The address is taken from their session — enter the router password to sign in.
        </p>
        {!online ? (
          <p className="notice mt-3">The client is offline right now — the router page may not answer until their session is up.</p>
        ) : null}
        {!host ? (
          <p className="notice mt-3">No router address is available for this client yet.</p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Target: <span className="font-medium text-foreground">{target}</span> · user <span className="font-medium text-foreground">{DEFAULT_USER}</span>
          </p>
        )}
        <form className="mt-4 grid gap-3" onSubmit={connect}>
          <FormField id="remote-password" label="Router password" hint="Remembered on this device. Only sent to the router page itself.">
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
            <PrimaryButton type="submit" disabled={!host || !password.trim()}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open router page
            </PrimaryButton>
          </div>
        </form>
      </section>

      {opened ? <p className="notice mt-4">Router page opened in a new tab.</p> : null}
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
