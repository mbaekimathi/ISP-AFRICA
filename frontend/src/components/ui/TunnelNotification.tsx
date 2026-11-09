import { useEffect, useState } from "react";
import { X, AlertTriangle, RefreshCw } from "lucide-react";
import { SecondaryButton } from "@/components/ui/Buttons";

type TunnelStatus = "up" | "down" | "unknown";

interface TunnelNotificationProps {
  tunnelStatus: TunnelStatus;
  routerName?: string;
  onDismiss?: () => void;
  onRetry?: () => void;
  polling?: boolean;
}

export function TunnelNotification({
  tunnelStatus,
  routerName = "Router",
  onDismiss,
  onRetry,
  polling = false,
}: TunnelNotificationProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (tunnelStatus === "up") {
      setDismissed(false);
    }
  }, [tunnelStatus]);

  if (tunnelStatus !== "down" || dismissed) {
    return null;
  }

  function dismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-end p-4 sm:bottom-4 sm:right-4 sm:left-auto sm:p-0"
      role="status"
      aria-live="polite"
    >
      <div className="tunnel-toast pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-destructive-border/50 bg-surface-raised shadow-lift">
        <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-destructive-border/60 bg-destructive-soft/70">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              {routerName} · Management tunnel offline
            </p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              The management tunnel did not answer. The router may be unreachable or the WireGuard connection is down.
            </p>
            {polling ? (
              <p className="mt-2 text-caption text-subtle">
                Stays open until you cancel it or the router comes back online.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Cancel notification"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition duration-fast ease-out hover:bg-surface-muted hover:text-foreground"
            onClick={dismiss}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          {onRetry ? (
            <SecondaryButton type="button" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </SecondaryButton>
          ) : null}
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground transition duration-fast ease-out hover:bg-surface-muted"
            onClick={dismiss}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
