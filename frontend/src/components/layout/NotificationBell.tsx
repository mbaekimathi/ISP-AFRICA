import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";

type NotificationItem = { id: string; open: boolean };

const POLL_MS = 30_000;

export function NotificationBell({
  feedPath,
  to,
  enabled = true,
}: {
  feedPath: string;
  to: string;
  enabled?: boolean;
}) {
  const location = useLocation();
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const load = () => {
      apiRequest<{ notifications: NotificationItem[] }>(feedPath)
        .then((body) => {
          if (!stopped) setItems(body.notifications);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [feedPath, enabled, location.pathname]);

  if (!enabled) return null;

  const ongoing = items.filter((item) => item.open).length;
  const count = items.length;
  const label = count > 99 ? "99+" : String(count);
  const ariaLabel =
    count === 0
      ? "Notifications"
      : `${count} notification${count === 1 ? "" : "s"}${ongoing ? `, ${ongoing} ongoing` : ""}`;

  return (
    <Link
      to={to}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground shadow-xs transition duration-fast ease-out hover:bg-surface active:scale-[0.97]"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <Bell className="h-4 w-4 text-amber-500" aria-hidden="true" />
      {count > 0 ? (
        <span
          className={cn(
            "absolute -right-1 -top-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-bold leading-none text-white",
            ongoing > 0 ? "bg-destructive" : "bg-primary",
          )}
          aria-hidden="true"
        >
          {label}
        </span>
      ) : null}
    </Link>
  );
}
