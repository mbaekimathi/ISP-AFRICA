import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type NotificationKey =
  | "serverUnreachable"
  | "mikrotikUnreachable"
  | "mikrotikAdded"
  | "ispRegistered"
  | "communicationsFailed"
  | "paymentsFailed";

type NotificationSettings = Record<NotificationKey, boolean>;

const events: { key: NotificationKey; label: string; detail: string }[] = [
  {
    key: "serverUnreachable",
    label: "The app cannot communicate with the servers",
    detail: "Alert when this portal loses contact with the account service.",
  },
  {
    key: "mikrotikUnreachable",
    label: "The app cannot communicate with MikroTiks",
    detail: "Alert when a managed router stops answering health checks.",
  },
  {
    key: "mikrotikAdded",
    label: "A new MikroTik is added",
    detail: "Alert when an ISP client onboards a new router.",
  },
  {
    key: "ispRegistered",
    label: "A new ISP is registered",
    detail: "Alert when a new ISP client signs up and is waiting for review.",
  },
  {
    key: "communicationsFailed",
    label: "The communications API fails",
    detail: "Alert when the company SMS, WhatsApp, or email gateway stops working.",
  },
  {
    key: "paymentsFailed",
    label: "The payments APIs fail",
    detail: "Alert when the company payment gateway or Daraja credentials stop working.",
  },
];

const defaults: NotificationSettings = {
  serverUnreachable: true,
  mikrotikUnreachable: true,
  mikrotikAdded: true,
  ispRegistered: true,
  communicationsFailed: true,
  paymentsFailed: true,
};

export function CompanyNotificationSettingsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY NOTIFICATION SETTINGS — ISP CENTRIC", "Choose which events should notify the company.");
  const [toggles, setToggles] = useState<NotificationSettings>(defaults);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: { notifications: NotificationSettings }) => {
    setToggles(body.notifications);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    let stopped = false;
    apiRequest<{ notifications: NotificationSettings }>("/api/employee/company/notifications")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Notification settings could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, employee]);

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
      <PageHeader
        title="Notification settings"
        description="Choose which events should notify the company. Alerts go through the communication APIs set up in company settings."
      />
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}
      <form
        className="form-card mt-6 max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          apiRequest<{ notifications: NotificationSettings }>("/api/employee/company/notifications", {
            method: "POST",
            body: JSON.stringify({ notifications: toggles }),
          })
            .then((body) => {
              apply(body);
              setNotice("Notification settings saved.");
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Notification settings could not be saved.");
            })
            .finally(() => setPending(false));
        }}
      >
        <fieldset className="grid gap-3">
          <legend className="text-lg font-semibold">Notify me when</legend>
          {events.map((item) => {
            const enabled = toggles[item.key];
            return (
              <label
                key={item.key}
                className={cn(
                  "grid cursor-pointer gap-1 rounded-lg border px-3 py-2 transition-colors duration-fast ease-out",
                  enabled
                    ? "border-primary bg-primary/5 shadow-xs"
                    : "border-border hover:border-input hover:bg-surface-muted/50",
                )}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={enabled}
                    onChange={(event) =>
                      setToggles((current) => ({ ...current, [item.key]: event.target.checked }))
                    }
                  />
                  <span className="font-semibold">{item.label}</span>
                </span>
                <span className="pl-7 text-sm text-muted-foreground">{item.detail}</span>
              </label>
            );
          })}
        </fieldset>
        <div>
          <PrimaryButton type="submit" disabled={pending || !loaded}>
            Save notification settings
          </PrimaryButton>
        </div>
      </form>
    </div>
  );
}
