import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle, RefreshCw } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";

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
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="flex items-start gap-4">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tunnelStatus === "down" ? "bg-destructive/10" : "bg-warning/10"}`}>
              <StatusIcon className={`h-5 w-5 ${statusColor}`} />
            </div>
            <div className="flex-1">
              <Dialog.Title className="text-base font-semibold text-foreground">
                {routerName} · {statusText}
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
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
                onClick={onDismiss}
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {onRetry && (
              <SecondaryButton
                type="button"
                onClick={() => {
                  onRetry();
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Retry Connection
              </SecondaryButton>
            )}
            <Dialog.Close asChild>
              <PrimaryButton type="button" onClick={onDismiss}>
                Dismiss
              </PrimaryButton>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
