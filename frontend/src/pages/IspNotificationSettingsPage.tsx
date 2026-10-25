import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { SoundAlertsCard } from "@/components/ui/SoundAlertsCard";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

type NotificationKey =
  | "mikrotikOnboarded"
  | "mikrotikUnreachable"
  | "mikrotikNoInternet"
  | "clientCannotSurf"
  | "subscriptionEnding"
  | "communicationsFailed"
  | "paymentsFailed"
  | "serverUnreachable";

type NotificationSettings = Record<NotificationKey, boolean>;

const events: { key: NotificationKey; label: string; detail: string }[] = [
  {
    key: "mikrotikOnboarded",
    label: "A MikroTik is successfully onboarded",
    detail: "Alert when a router finishes onboarding and comes under management.",
  },
  {
    key: "mikrotikUnreachable",
    label: "The system cannot communicate with a MikroTik",
    detail: "Alert when a router fails health checks or disconnects.",
  },
  {
    key: "mikrotikNoInternet",
    label: "There is no internet on a MikroTik",
    detail: "Alert when a router is reachable but its uplinks have no internet.",
  },
  {
    key: "clientCannotSurf",
    label: "A client cannot surf",
    detail: "Alert when a subscriber is connected but cannot reach the internet.",
  },
  {
    key: "subscriptionEnding",
    label: "A client subscription is ending",
    detail: "Alert a day before a PPPoE subscription expires.",
  },
  {
    key: "communicationsFailed",
    label: "The communications API fails",
    detail: "Alert when the SMS, WhatsApp, or email API in use stops working.",
  },
  {
    key: "paymentsFailed",
    label: "The payments API fails",
    detail: "Alert when the payment API in use stops working.",
  },
  {
    key: "serverUnreachable",
    label: "The app cannot communicate with the servers",
    detail: "Alert when this portal loses contact with the account service.",
  },
];

const defaults: NotificationSettings = {
  mikrotikOnboarded: true,
  mikrotikUnreachable: true,
  mikrotikNoInternet: true,
  clientCannotSurf: true,
  subscriptionEnding: true,
  communicationsFailed: true,
  paymentsFailed: true,
  serverUnreachable: true,
};

export function IspNotificationSettingsPage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP NOTIFICATION SETTINGS — ISP CENTRIC", "Choose which events should notify this account.");
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
    if (!user || user.status !== "approved") return;
    let stopped = false;
    apiRequest<{ notifications: NotificationSettings }>("/api/notifications")
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
  }, [apply, user]);

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.status !== "approved") {
    return <Navigate to="/account" replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Notification settings"
        description="Choose which events should notify this account. Alerts go through the communication API set up for this account or the company."
      />
      <div className="mt-6">
        <SoundAlertsCard apiBase="/api/notifications" scope="client" />
      </div>
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
          apiRequest<{ notifications: NotificationSettings }>("/api/notifications", {
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
