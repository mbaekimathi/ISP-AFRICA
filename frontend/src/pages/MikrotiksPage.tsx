import { useState } from "react";
import { Router, Wifi, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useSavedQuery } from "@/hooks/useSavedQuery";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";
import { cn } from "@/lib/cn";

type Device = {
  id: string;
  name: string;
  site: string;
  status: string;
  tunnelStatus: "up" | "down" | "unknown" | string;
  routerosVersion?: string;
  role?: string;
};

type DevicePage = {
  devices: Device[];
  total: number;
  limit: number;
  offset: number;
};

function connectionState(tunnelStatus: Device["tunnelStatus"]) {
  if (tunnelStatus === "up") {
    return {
      label: "Online",
      Icon: Wifi,
      iconClass: "bg-success-soft text-success",
    };
  }
  if (tunnelStatus === "down") {
    return {
      label: "Offline",
      Icon: WifiOff,
      iconClass: "bg-destructive-soft text-destructive",
    };
  }
  return {
    label: "Unknown",
    Icon: WifiOff,
    iconClass: "bg-warning-soft text-warning",
  };
}

export function MikrotiksPage() {
  usePageMeta("Mikrotiks — ISP CENTRIC", "Saved MikroTik records.");
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const saved = useSavedQuery<DevicePage>(`/api/mikrotiks?limit=50&offset=${offset}&reload=${reload}`);
  const page = saved.data;
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const href = (path: string) => (user ? clientPage(user, path) : path);

  async function setSuspended(device: Device, suspended: boolean) {
    setActionError("");
    setBusyId(device.id);
    try {
      await apiRequest(`/api/mikrotiks/${device.id}/${suspended ? "suspend" : "unsuspend"}`, {
        method: "POST",
        body: "{}",
      });
      setReload((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The router status could not be changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(deviceId: string) {
    setActionError("");
    setBusyId(deviceId);
    try {
      await apiRequest(`/api/mikrotiks/${deviceId}/delete`, { method: "POST", body: "{}" });
      setConfirmingId(null);
      if (page && page.devices.length === 1 && offset > 0) setOffset(Math.max(0, offset - page.limit));
      setReload((current) => current + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The router could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Mikrotiks" description={page ? `${page.total} routers.` : "Loading routers."} />
      {saved.error || actionError ? (
        <p className="notice mt-4" role="alert">
          {saved.error || actionError}
        </p>
      ) : null}

      {page?.devices.length === 0 ? (
        <p className="panel mt-6 px-4 py-10 text-center text-sm text-muted-foreground">No routers are saved yet.</p>
      ) : null}

      {!page && !saved.error ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 gap-2">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-3 w-1/3" />
                </div>
                <div className="skeleton h-10 w-10 rounded-xl" />
              </div>
              <div className="mt-5 flex gap-2">
                <div className="skeleton h-9 w-24" />
                <div className="skeleton h-9 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {page && page.devices.length > 0 ? (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {page.devices.map((device) => {
            const suspended = device.status === "suspended";
            const busy = busyId === device.id;
            const connection = connectionState(device.tunnelStatus);
            const StatusIcon = connection.Icon;
            return (
              <li key={device.id}>
                <article className="card flex h-full flex-col p-5 transition-transform duration-fast ease-out hover:-translate-y-0.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-muted text-muted-foreground">
                          <Router className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <h2 className="truncate text-base font-semibold">{device.name}</h2>
                          {device.site ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{device.site}</p> : null}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {suspended ? <StatusBadge tone="suspended">Suspended</StatusBadge> : null}
                        {device.routerosVersion ? (
                          <span className="text-xs text-muted-foreground">RouterOS {device.routerosVersion}</span>
                        ) : null}
                      </div>
                    </div>

                    <div
                      className={cn(
                        "flex shrink-0 flex-col items-center gap-1 rounded-xl px-2.5 py-2 text-center",
                        connection.iconClass,
                      )}
                      title={connection.label}
                    >
                      <StatusIcon className="h-5 w-5" aria-hidden="true" />
                      <span className="text-[0.65rem] font-semibold uppercase tracking-wide">{connection.label}</span>
                      <span className="sr-only">
                        {device.name} is {connection.label.toLowerCase()}
                      </span>
                    </div>
                  </div>

                  <div className="mt-auto flex flex-wrap gap-2 pt-5">
                    <PrimaryButton to={href(`/mikrotiks/${device.id}`)}>View live</PrimaryButton>
                    <SecondaryButton type="button" disabled={busy} onClick={() => void setSuspended(device, !suspended)}>
                      {suspended ? "Unsuspend" : "Suspend"}
                    </SecondaryButton>
                    {confirmingId === device.id ? (
                      <SecondaryButton type="button" disabled={busy} onClick={() => void remove(device.id)}>
                        {busy ? "Deleting" : "Confirm delete"}
                      </SecondaryButton>
                    ) : (
                      <SecondaryButton type="button" disabled={busyId !== null} onClick={() => setConfirmingId(device.id)}>
                        Delete
                      </SecondaryButton>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}

      {page && page.total > page.limit ? (
        <div className="mt-4 flex gap-3">
          <PrimaryButton type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>
            Previous
          </PrimaryButton>
          <PrimaryButton type="button" disabled={offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>
            Next
          </PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}
