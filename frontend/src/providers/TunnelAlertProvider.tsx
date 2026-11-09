import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { SecondaryButton } from "@/components/ui/Buttons";
import { apiRequest } from "@/lib/api";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type TunnelAlert = {
  id: string;
  name: string;
};

type TunnelAlertContextValue = {
  reportDown: (id: string, name: string) => void;
  reportUp: (id: string) => void;
};

const TunnelAlertContext = createContext<TunnelAlertContextValue | null>(null);

const POLL_MS = 10_000;

export function useTunnelAlert() {
  return useContext(TunnelAlertContext);
}

export function TunnelAlertProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [down, setDown] = useState<TunnelAlert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const reportDown = useCallback((id: string, name: string) => {
    if (!id) return;
    setDown((current) => {
      const existing = current.find((item) => item.id === id);
      if (existing) {
        if (existing.name === (name || existing.name)) return current;
        return current.map((item) => (item.id === id ? { id, name: name || "Router" } : item));
      }
      return [...current, { id, name: name || "Router" }];
    });
  }, []);

  const reportUp = useCallback((id: string) => {
    if (!id) return;
    setDown((current) => current.filter((item) => item.id !== id));
    setDismissed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!user || user.status !== "approved") {
      setDown([]);
      setDismissed(new Set());
      return;
    }
    let stopped = false;
    const load = () => {
      apiRequest<{ devices: { id: string; name: string; tunnelStatus: string }[] }>("/api/mikrotiks?limit=100&offset=0")
        .then((body) => {
          if (stopped) return;
          const devices = body.devices ?? [];
          const offline = devices
            .filter((item) => item.tunnelStatus === "down")
            .map((item) => ({ id: item.id, name: item.name || "Router" }));
          const known = new Map(devices.map((item) => [item.id, item.tunnelStatus]));

          setDown((current) => {
            const next = new Map<string, TunnelAlert>();
            for (const item of current) {
              const status = known.get(item.id);
              if (status === "up") continue;
              if (status === "down") {
                const match = offline.find((row) => row.id === item.id);
                next.set(item.id, match || item);
                continue;
              }
              if (status === undefined) {
                next.set(item.id, item);
              }
            }
            for (const item of offline) next.set(item.id, item);
            return Array.from(next.values());
          });

          setDismissed((current) => {
            let changed = false;
            const next = new Set(current);
            for (const id of current) {
              if (known.get(id) === "up") {
                next.delete(id);
                changed = true;
              }
            }
            return changed ? next : current;
          });
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [user]);

  const visible = useMemo(
    () => down.filter((item) => !dismissed.has(item.id)),
    [down, dismissed],
  );

  const value = useMemo(() => ({ reportDown, reportUp }), [reportDown, reportUp]);

  function dismiss(id: string) {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }

  return (
    <TunnelAlertContext.Provider value={value}>
      {children}
      {visible.length > 0 && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-end gap-3 p-4 sm:top-4 sm:right-4 sm:left-auto sm:max-w-md sm:p-0"
              role="region"
              aria-label="Management tunnel alerts"
            >
              {visible.map((item) => (
                <TunnelAlertCard
                  key={item.id}
                  alert={item}
                  href={user ? clientPage(user, `/mikrotiks/${item.id}`) : `/mikrotiks/${item.id}`}
                  onDismiss={() => dismiss(item.id)}
                  onRetry={() => {
                    apiRequest<{ live?: { reachable?: boolean; name?: string } }>(`/api/mikrotiks/${item.id}/live`)
                      .then((body) => {
                        if (body.live?.reachable) reportUp(item.id);
                        else reportDown(item.id, body.live?.name || item.name);
                      })
                      .catch(() => reportDown(item.id, item.name));
                  }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </TunnelAlertContext.Provider>
  );
}

function TunnelAlertCard({
  alert,
  href,
  onDismiss,
  onRetry,
}: {
  alert: TunnelAlert;
  href: string;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="tunnel-toast pointer-events-auto w-full overflow-hidden rounded-2xl border border-destructive-border/50 bg-surface-raised shadow-lift"
      role="alertdialog"
      aria-labelledby={`tunnel-alert-title-${alert.id}`}
      aria-describedby={`tunnel-alert-detail-${alert.id}`}
    >
      <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-destructive-border/60 bg-destructive-soft/70">
          <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <p id={`tunnel-alert-title-${alert.id}`} className="text-sm font-semibold tracking-tight text-foreground">
            {alert.name} · Management tunnel offline
          </p>
          <p id={`tunnel-alert-detail-${alert.id}`} className="mt-1 text-sm leading-5 text-muted-foreground">
            The management tunnel did not answer. This stays open until you cancel it or the MikroTik comes back online.
          </p>
          <Link to={href} className="mt-2 inline-flex text-caption font-medium text-primary hover:underline">
            Open router
          </Link>
        </div>
        <button
          type="button"
          aria-label="Cancel notification"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition duration-fast ease-out hover:bg-surface-muted hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
        <SecondaryButton type="button" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </SecondaryButton>
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground transition duration-fast ease-out hover:bg-surface-muted"
          onClick={onDismiss}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
