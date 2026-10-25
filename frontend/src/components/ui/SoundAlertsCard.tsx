import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { apiRequest } from "@/lib/api";
import { subscribePush, type PushState } from "@/lib/pushAlerts";

type PushInfo = { vapidPublicKey: string; devices: number };

export function SoundAlertsCard({ apiBase, scope }: { apiBase: string; scope: string }) {
  const [pushState, setPushState] = useState<PushState>("checking");
  const [pushEndpoint, setPushEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const autoTried = useRef(false);
  const offKey = `sound-alerts-off:${scope}`;

  const enableAlerts = useCallback(async () => {
    setBusy(true);
    setNote("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }
      const registration = await navigator.serviceWorker.register("/push-sw.js");
      await navigator.serviceWorker.ready;
      const { push } = await apiRequest<{ push: PushInfo }>(`${apiBase}/push`);
      const subscription = await subscribePush(registration, push.vapidPublicKey);
      await apiRequest(`${apiBase}/push/subscribe`, {
        method: "POST",
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: subscription.toJSON().keys,
          userAgent: navigator.userAgent,
        }),
      });
      localStorage.removeItem(offKey);
      setPushEndpoint(subscription.endpoint);
      setPushState("on");
      setNote("Sound alerts are on for this device — they keep ringing even after you sign out.");
    } catch (cause: unknown) {
      setNote(
        cause instanceof DOMException
          ? "This browser could not register with its push service — check VPN/firewall access, or try another browser."
          : cause instanceof Error
            ? cause.message
            : "Sound alerts could not be turned on.",
      );
    } finally {
      setBusy(false);
    }
  }, [apiBase, offKey]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushState("unsupported");
      return;
    }
    let stopped = false;
    navigator.serviceWorker
      .register("/push-sw.js")
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (stopped) return;
        if (subscription) {
          setPushState("on");
          setPushEndpoint(subscription.endpoint);
        } else {
          setPushState(Notification.permission === "denied" ? "denied" : "off");
        }
      })
      .catch(() => {
        if (!stopped) setPushState("unsupported");
      });
    return () => {
      stopped = true;
    };
  }, []);

  // Alerts default to ON: the first time this device can take a subscription
  // (permission granted or not yet asked), subscribe it straight away — unless
  // the user explicitly turned alerts off here before.
  useEffect(() => {
    if (pushState !== "off" || autoTried.current || localStorage.getItem(offKey)) return;
    autoTried.current = true;
    void enableAlerts();
  }, [pushState, enableAlerts, offKey]);

  async function disableAlerts() {
    setBusy(true);
    setNote("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await apiRequest(`${apiBase}/push/unsubscribe`, {
        method: "POST",
        body: JSON.stringify({ endpoint: subscription?.endpoint ?? pushEndpoint }),
      });
      localStorage.setItem(offKey, "1");
      setPushEndpoint("");
      setPushState("off");
      setNote("Sound alerts are off for this device.");
    } catch (cause: unknown) {
      setNote(cause instanceof Error ? cause.message : "Sound alerts could not be turned off.");
    } finally {
      setBusy(false);
    }
  }

  function testAlert() {
    setBusy(true);
    setNote("");
    apiRequest<{ test: { connected: boolean; reason: string } }>(`${apiBase}/push/test`, {
      method: "POST",
      body: JSON.stringify({ endpoint: pushEndpoint }),
    })
      .then((body) => setNote(`${body.test.reason} You should hear the alert sound shortly.`))
      .catch((cause: unknown) =>
        setNote(cause instanceof Error ? cause.message : "The test alert could not be sent."),
      )
      .finally(() => setBusy(false));
  }

  return (
    <div className="form-card max-w-2xl">
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
          ? "This gadget rings for new alerts — even after you sign out, until you turn it off here."
          : pushState === "unsupported"
            ? "This browser does not support push alerts — the site needs HTTPS (or localhost) and a modern browser."
            : pushState === "denied"
              ? "Notifications are blocked on this device — allow them in the browser's site settings, then turn alerts on."
              : "Ring this gadget for new alerts — even after you sign out."}
      </p>
      {note ? (
        <p className="text-sm text-muted-foreground" role="status">
          {note}
        </p>
      ) : null}
      {pushState === "checking" ? (
        <LiveLoad label="Checking this device" />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {pushState === "on" ? (
            <>
              <SecondaryButton type="button" disabled={busy} onClick={testAlert}>
                Test the sound
              </SecondaryButton>
              <SecondaryButton type="button" disabled={busy} onClick={disableAlerts}>
                Turn alerts off
              </SecondaryButton>
            </>
          ) : pushState === "off" || pushState === "denied" ? (
            <PrimaryButton type="button" disabled={busy} onClick={() => void enableAlerts()}>
              Turn alerts on
            </PrimaryButton>
          ) : null}
        </div>
      )}
    </div>
  );
}
