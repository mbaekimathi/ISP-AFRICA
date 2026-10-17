import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle, RefreshCw } from "lucide-react";

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
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (tunnelStatus === "down" || tunnelStatus === "unknown") {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [tunnelStatus]);

  if (tunnelStatus === "up") {
    return null;
  }

  const statusColor = tunnelStatus === "down" ? "text-destructive" : "text-warning";
  const StatusIcon = tunnelStatus === "down" ? AlertTriangle : RefreshCw;
  const statusText = tunnelStatus === "down" ? "Management tunnel is offline" : "Router status unknown";
  const description = tunnelStatus === "down"
    ? "The management tunnel did not answer. The router may be unreachable or the WireGuard connection is down."
    : "Unable to reach the router. Check the tunnel configuration and network connectivity.";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]">
          <div className="flex items-start gap-4">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tunnelStatus === "down" ? "bg-destructive/10" : "bg-warning/10"}`}>
              <StatusIcon className={`h-5 w-5 ${statusColor}`} />
            </div>
            <div className="flex-1">
              <Dialog.Title className="text-base font-semibold text-foreground">
                {routerName} - {statusText}
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                {description}
              </Dialog.Description>
              {polling && (
                <p className="mt-2 text-xs text-muted-foreground">
                  This notification will auto-dismiss when the router comes back online.
                </p>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
                onClick={onDismiss}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            {onRetry && (
              <button
                type="button"
                onClick={() => {
                  onRetry();
                }}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-border bg-background hover:bg-surface-muted h-9 px-4 py-2"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry Connection
              </button>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2"
              >
                Dismiss
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
