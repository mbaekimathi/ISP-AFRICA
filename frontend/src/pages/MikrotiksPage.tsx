import { useState } from "react";
import { PageHeader } from "@/components/ui/DetailGrid";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useSavedQuery } from "@/hooks/useSavedQuery";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Device = {
  id: string;
  name: string;
  site: string;
  status: string;
};

type DevicePage = {
  devices: Device[];
  total: number;
  limit: number;
  offset: number;
};

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
      <ul className="panel mt-6 divide-y divide-border overflow-hidden">
        {page?.devices.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">No routers are saved yet.</li>
        ) : null}
        {!page && !saved.error ? (
          <li className="px-4 py-6" aria-hidden="true">
            <div className="grid gap-3">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton h-4 w-1/4" />
            </div>
          </li>
        ) : null}
        {page?.devices.map((device) => {
          const suspended = device.status === "suspended";
          const busy = busyId === device.id;
          return (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-fast ease-out hover:bg-surface-muted/50">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{device.name}</p>
                  {suspended ? <StatusBadge tone="suspended">Suspended</StatusBadge> : null}
                </div>
                {device.site ? <p className="mt-0.5 text-sm text-muted-foreground">{device.site}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
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
            </li>
          );
        })}
      </ul>
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
