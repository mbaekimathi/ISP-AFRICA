import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { SecondaryButton } from "@/components/ui/Buttons";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { employeePage } from "@/lib/employees";
import { cn } from "@/lib/cn";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type NotificationItem = {
  id: string;
  kind: string;
  subject: string;
  detail: string;
  at: string | null;
  open: boolean;
};

const kindLabels: Record<string, string> = {
  serverUnreachable: "Servers",
  mikrotikUnreachable: "MikroTik down",
  mikrotikAdded: "MikroTik added",
  ispRegistered: "New ISP",
  communicationsFailed: "Communications",
  paymentsFailed: "Payments",
};

export function CompanyNotificationsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY NOTIFICATIONS — ISP CENTRIC", "Company notifications.");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    let stopped = false;
    apiRequest<{ notifications: NotificationItem[] }>("/api/employee/company/notifications/feed")
      .then((body) => {
        if (!stopped) {
          setItems(body.notifications);
          setLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Notifications could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [employee]);

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.status !== "approved") {
    return <Navigate to="/employee/account" replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Notifications" description="Recent alerts and events for the company." />
      <div className="mt-4">
        <SecondaryButton to={employeePage(employee, "/company-settings/notifications/settings")}>
          Notification settings
        </SecondaryButton>
      </div>
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {!loaded ? (
        <LiveLoad label="Loading notifications" />
      ) : items.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Bell />}
            title="No notifications yet"
            description="Alerts about ISP clients, MikroTiks, and company APIs will show up here."
          />
        </div>
      ) : (
        <ul className="mt-6 grid gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="grid gap-1 rounded-xl border border-border bg-surface px-4 py-3 shadow-xs sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4"
            >
              <div className="grid gap-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                  {item.subject}
                  <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {kindLabels[item.kind] ?? item.kind}
                  </span>
                  {item.open ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5",
                        "text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-destructive",
                      )}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
                      Ongoing
                    </span>
                  ) : null}
                </p>
                {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
              </div>
              {item.at ? (
                <time className="text-xs text-muted-foreground sm:pt-0.5" dateTime={item.at}>
                  {item.at}
                </time>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
