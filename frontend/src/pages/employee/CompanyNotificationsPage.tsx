import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { Bell, Volume2 } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
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
  read: boolean;
};

type PushState = "checking" | "unsupported" | "denied" | "off" | "on";

const kindLabels: Record<string, string> = {
  serverUnreachable: "Servers",
  mikrotikUnreachable: "MikroTik down",
  mikrotikAdded: "MikroTik added",
  ispRegistered: "New ISP",
  communicationsFailed: "Communications",
  paymentsFailed: "Payments",
};

function vapidBytes(value: string) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function playChime(context: AudioContext | null) {
  if (!context) return;
  [0, 0.18].forEach((offset, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = index === 0 ? 880 : 1174.66;
    gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + offset + 0.2);
  });
}

export function CompanyNotificationsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY NOTIFICATIONS — ISP CENTRIC", "Company notifications.");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pushState, setPushState] = useState<PushState>("checking");
  const [pushEndpoint, setPushEndpoint] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState("");
  const audioRef = useRef<AudioContext | null>(null);
  const pushOnRef = useRef(false);
  const seenRef = useRef<Set<string> | null>(null);

  const loadFeed = useCallback(() => {
    apiRequest<{ notifications: NotificationItem[] }>("/api/employee/company/notifications/feed")
      .then((body) => {
        const fresh = new Set(body.notifications.map((item) => item.id));
        if (seenRef.current !== null && pushOnRef.current) {
          if (body.notifications.some((item) => !seenRef.current!.has(item.id))) {
            playChime(audioRef.current);
          }
        }
        seenRef.current = fresh;
        setItems(body.notifications);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        setLoaded(true);
        setError(cause instanceof Error ? cause.message : "Notifications could not be loaded.");
      });
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    loadFeed();
    const timer = setInterval(loadFeed, 10000);
    return () => clearInterval(timer);
  }, [employee, loadFeed]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushState("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/push-sw.js")
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (subscription) {
          setPushState("on");
          setPushEndpoint(subscription.endpoint);
          pushOnRef.current = true;
        } else {
          setPushState(Notification.permission === "denied" ? "denied" : "off");
        }
      })
      .catch(() => setPushState("unsupported"));
  }, []);

  async function enableAlerts() {
    setPushBusy(true);
    setPushNote("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }
      const registration = await navigator.serviceWorker.register("/push-sw.js");
      const { push } = await apiRequest<{ push: { vapidPublicKey: string; devices: number } }>(
        "/api/employee/company/notifications/push",
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidBytes(push.vapidPublicKey),
        }));
      await apiRequest("/api/employee/company/notifications/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: subscription.toJSON().keys,
          userAgent: navigator.userAgent,
        }),
      });
      audioRef.current ??= new AudioContext();
      void audioRef.current.resume();
      pushOnRef.current = true;
      setPushEndpoint(subscription.endpoint);
      setPushState("on");
      setPushNote("Sound alerts are on for this device — they keep ringing even after you sign out.");
    } catch (cause: unknown) {
      setPushNote(cause instanceof Error ? cause.message : "Sound alerts could not be turned on.");
    } finally {
      setPushBusy(false);
    }
  }

  async function disableAlerts() {
    setPushBusy(true);
    setPushNote("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await apiRequest("/api/employee/company/notifications/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: subscription?.endpoint ?? pushEndpoint }),
      });
      pushOnRef.current = false;
      setPushEndpoint("");
      setPushState("off");
      setPushNote("Sound alerts are off for this device.");
    } catch (cause: unknown) {
      setPushNote(cause instanceof Error ? cause.message : "Sound alerts could not be turned off.");
    } finally {
      setPushBusy(false);
    }
  }

  function testAlert() {
    setPushBusy(true);
    setPushNote("");
    apiRequest<{ test: { connected: boolean; reason: string } }>(
      "/api/employee/company/notifications/push/test",
      { method: "POST", body: JSON.stringify({ endpoint: pushEndpoint }) },
    )
      .then((body) => setPushNote(`${body.test.reason} You should hear the alert sound shortly.`))
      .catch((cause: unknown) =>
        setPushNote(cause instanceof Error ? cause.message : "The test alert could not be sent."),
      )
      .finally(() => setPushBusy(false));
  }

  function markRead(payload: { itemIds?: string[]; all?: boolean }) {
    apiRequest<{ notifications: NotificationItem[] }>(
      "/api/employee/company/notifications/read",
      { method: "POST", body: JSON.stringify(payload) },
    )
      .then((body) => setItems(body.notifications))
      .catch(() => undefined);
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
      <PageHeader title="Notifications" description="Recent alerts and events for the company." />
      <div className="mt-4">
        <SecondaryButton to={employeePage(employee, "/company-settings/notifications/settings")}>
          Notification settings
        </SecondaryButton>
      </div>
      <div className="form-card mt-6 max-w-2xl">
        <div className="flex flex-wrap items-center gap-3">
          <Volume2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Sound alerts on this device</h2>
          {pushState === "on" ? (
            <span className="rounded-full border border-success-border bg-success-soft/60 px-2 py-0.5 text-caption font-semibold text-success">
              ON
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {pushState === "on"
            ? "This gadget rings for new company alerts — even after you sign out, until you turn it off here."
            : pushState === "unsupported"
              ? "This browser does not support push alerts — the site needs HTTPS (or localhost) and a modern browser."
              : pushState === "denied"
                ? "Notifications are blocked on this device — allow them in the browser's site settings, then turn alerts on."
                : "Ring this gadget for new company alerts — even after you sign out."}
        </p>
        {pushNote ? (
          <p className="text-sm text-muted-foreground" role="status">
            {pushNote}
          </p>
        ) : null}
        {pushState === "checking" ? (
          <LiveLoad label="Checking this device" />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {pushState === "on" ? (
              <>
                <SecondaryButton type="button" disabled={pushBusy} onClick={testAlert}>
                  Test the sound
                </SecondaryButton>
                <SecondaryButton type="button" disabled={pushBusy} onClick={disableAlerts}>
                  Turn alerts off
                </SecondaryButton>
              </>
            ) : pushState === "off" || pushState === "denied" ? (
              <PrimaryButton type="button" disabled={pushBusy} onClick={enableAlerts}>
                Turn alerts on
              </PrimaryButton>
            ) : null}
          </div>
        )}
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
        <>
          {items.some((item) => !item.read) ? (
            <div className="mt-6 flex items-center gap-3">
              <p className="text-sm font-medium text-foreground">
                {items.filter((item) => !item.read).length} unread
              </p>
              <SecondaryButton type="button" onClick={() => markRead({ all: true })}>
                Mark all read
              </SecondaryButton>
            </div>
          ) : null}
          <ul className="mt-3 grid gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                onClick={() => {
                  if (!item.read) markRead({ itemIds: [item.id] });
                }}
                className={cn(
                  "grid gap-1 rounded-xl border px-4 py-3 shadow-xs sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4",
                  item.read
                    ? "border-border bg-surface"
                    : "cursor-pointer border-primary/50 bg-primary/5 transition-colors hover:border-primary",
                )}
              >
                <div className="grid gap-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {item.subject}
                    <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {kindLabels[item.kind] ?? item.kind}
                    </span>
                    {!item.read ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5",
                          "text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-primary",
                        )}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                        Unread
                      </span>
                    ) : null}
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
        </>
      )}
    </div>
  );
}
