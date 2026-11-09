import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { SoundAlertsCard } from "@/components/ui/SoundAlertsCard";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { NotificationEventList } from "@/components/notifications/NotificationEventList";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import {
  companyNotificationEvents,
  type CompanyNotificationKey,
} from "@/lib/notificationMessages";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type NotificationSettings = Record<CompanyNotificationKey, boolean>;
type MessageMap = Partial<Record<CompanyNotificationKey, string>>;

type NotificationsPayload = {
  notifications: NotificationSettings;
  notificationMessages?: MessageMap;
};

const defaults: NotificationSettings = {
  serverUnreachable: true,
  mikrotikUnreachable: true,
  mikrotikAdded: true,
  ispRegistered: true,
  systemPerformance: true,
  communicationsFailed: true,
  paymentsFailed: true,
};

export function CompanyNotificationSettingsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY NOTIFICATION SETTINGS — ISP CENTRIC", "Choose which events should notify the company.");
  const [toggles, setToggles] = useState<NotificationSettings>(defaults);
  const [messages, setMessages] = useState<MessageMap>({});
  const [savingMessageKey, setSavingMessageKey] = useState<CompanyNotificationKey | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: NotificationsPayload) => {
    setToggles({ ...defaults, ...body.notifications });
    setMessages(body.notificationMessages ?? {});
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    let stopped = false;
    apiRequest<NotificationsPayload>("/api/employee/company/notifications")
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

  async function saveMessage(key: CompanyNotificationKey, message: string | null) {
    setSavingMessageKey(key);
    try {
      const body = await apiRequest<NotificationsPayload>("/api/employee/company/notifications/messages", {
        method: "POST",
        body: JSON.stringify({ key, message }),
      });
      apply(body);
      setNotice("Notification message saved.");
    } finally {
      setSavingMessageKey(null);
    }
  }

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
        description="Enable or disable each company alert, preview the message, and add or edit the wording. Alerts go through the communication APIs set up in company settings."
      />
      <div className="mt-6">
        <SoundAlertsCard apiBase="/api/employee/company/notifications" scope="company" />
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
        className="form-card mt-6 grid max-w-2xl gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          apiRequest<NotificationsPayload>("/api/employee/company/notifications", {
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
        <NotificationEventList
          items={companyNotificationEvents}
          values={toggles}
          messages={messages}
          savingKey={savingMessageKey}
          onToggle={(key, enabled) => setToggles((current) => ({ ...current, [key]: enabled }))}
          onSaveMessage={(key, message) => saveMessage(key, message)}
          intro="Notify the company when these events happen. Use the toggle to enable or disable, view to preview the alert, then add or edit the message."
        />
        <div>
          <PrimaryButton type="submit" disabled={pending || !loaded}>
            Save notification settings
          </PrimaryButton>
        </div>
      </form>
    </div>
  );
}
