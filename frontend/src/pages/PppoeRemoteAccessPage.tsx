import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ExternalLink, MonitorSmartphone } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import type { Subscriber } from "@/pages/PppoeCustomerPage";

type SavedAccess = {
  protocol: string;
  host: string;
  port: string;
  username: string;
  password: string;
};

function savedAccessKey(subscriberId: string) {
  return `isp.remote-access.${subscriberId}`;
}

function loadSavedAccess(subscriberId: string): SavedAccess | null {
  try {
    const raw = window.localStorage.getItem(savedAccessKey(subscriberId));
    return raw ? (JSON.parse(raw) as SavedAccess) : null;
  } catch {
    return null;
  }
}

function cleanHost(value: string) {
  return value.trim().replace(/^https?:\/\//i, "").split("/")[0];
}

export function PppoeRemoteAccessPage() {
  const { subscriberId = "" } = useParams();
  const { user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [message, setMessage] = useState("");
  const [protocol, setProtocol] = useState("http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("80");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");

  usePageMeta("Remote access — ISP CENTRIC", "Open the client's router page remotely.");

  useEffect(() => {
    apiRequest<{ subscriber: Subscriber }>(`/api/pppoe/subscribers/${subscriberId}`)
      .then((body) => {
        const saved = loadSavedAccess(subscriberId);
        setSubscriber(body.subscriber);
        const cpe = (body.subscriber.devices ?? []).find((device) => device.kind === "router");
        setHost(body.subscriber.live.ip || body.subscriber.staticIp || cpe?.ip || saved?.host || "");
        setProtocol(saved?.protocol ?? "http");
        setPort(saved?.port ?? "80");
        setUsername(saved?.username ?? "");
        setPassword(saved?.password ?? "");
        setSettingsOpen(!saved);
        setMessage("");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "That client could not be loaded."));
  }, [subscriberId]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setOpened(false);
    const cleaned = cleanHost(host);
    if (!cleaned) {
      setError("Enter the router address, for example 192.168.1.1.");
      return;
    }
    const portNumber = port.trim();
    if (portNumber && (!/^\d+$/.test(portNumber) || Number(portNumber) < 1 || Number(portNumber) > 65535)) {
      setError("Enter a port between 1 and 65535.");
      return;
    }
    let url: URL;
    try {
      url = new URL(`${protocol}://${cleaned}`);
    } catch {
      setError("Enter the router address, for example 192.168.1.1.");
      return;
    }
    if (portNumber) url.port = portNumber;
    if (username.trim()) url.username = username.trim();
    if (password) url.password = password;
    if (remember) {
      try {
        window.localStorage.setItem(
          savedAccessKey(subscriberId),
          JSON.stringify({ protocol, host: cleaned, port: portNumber, username: username.trim(), password } satisfies SavedAccess),
        );
      } catch {
        // Storage unavailable — connecting still works.
      }
    } else {
      window.localStorage.removeItem(savedAccessKey(subscriberId));
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
  const cleaned = cleanHost(host);
  const defaultPort = protocol === "https" ? "443" : "80";
  const target = cleaned ? `${protocol}://${cleaned}${port.trim() && port.trim() !== defaultPort ? `:${port.trim()}` : ""}` : "";

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
          <h2 className="text-sm font-semibold">Quick connect</h2>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Opens the client's router page in a new tab, already signed in. Sign-in details are remembered on this
          device so the next visit is a single click.
        </p>
        {!online ? (
          <p className="notice mt-3">The client is offline right now — the router page may not answer until their session is up.</p>
        ) : null}
        <form className="mt-4 grid gap-3" onSubmit={connect}>
          <FormField
            id="remote-host"
            label="Router address"
            hint={subscriber.live.ip ? `Online now at ${subscriber.live.ip}` : "The router's web address, for example 192.168.1.1."}
          >
            <input
              id="remote-host"
              className="field"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="192.168.1.1"
              autoComplete="off"
            />
          </FormField>
          <details
            className="group rounded-xl border border-border"
            open={settingsOpen}
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
              <span>Connection settings{username ? ` · ${username}` : ""}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="grid gap-3 border-t border-border px-4 pb-4 pt-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="remote-username" label="User name">
                  <input
                    id="remote-username"
                    className="field"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                  />
                </FormField>
                <FormField id="remote-password" label="Password" hint="Only sent to the router page itself.">
                  <input
                    id="remote-password"
                    type="password"
                    className="field"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </FormField>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                Remember sign-in on this device
              </label>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
                <FormPicker
                  label="Protocol"
                  options={[
                    { id: "http", label: "http" },
                    { id: "https", label: "https" },
                  ]}
                  value={protocol}
                  onChange={(next) => {
                    setProtocol(next);
                    setPort((current) => (next === "https" && current === "80" ? "443" : next === "http" && current === "443" ? "80" : current));
                  }}
                />
                <FormField id="remote-port" label="Port">
                  <input
                    id="remote-port"
                    className="field"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </FormField>
              </div>
            </div>
          </details>
          {error ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <PrimaryButton type="submit" disabled={!cleaned}>
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open router page
            </PrimaryButton>
            <p className="mt-2 text-caption text-muted-foreground">
              {target ? `Opens ${target} in a new tab.` : "Enter the router address to connect."}
            </p>
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
