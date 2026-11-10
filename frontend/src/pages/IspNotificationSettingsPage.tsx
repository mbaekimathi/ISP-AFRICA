import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { SoundAlertsCard } from "@/components/ui/SoundAlertsCard";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { NotificationEventList } from "@/components/notifications/NotificationEventList";
import { usePageMeta } from "@/hooks/usePageMeta";
import { ApiRequestError, apiRequest } from "@/lib/api";
import {
  clientNotificationEvents,
  hotspotNotificationEvents,
  meNotificationEvents,
  type IspClientNotificationKey,
  type IspHotspotNotificationKey,
  type IspMeNotificationKey,
} from "@/lib/notificationMessages";
import { SMS_PROVIDER_LABELS, type SmsProvider } from "@/components/communication/CommunicationFields";
import { useAuth } from "@/providers/AuthProvider";

type NotificationSettings = Record<IspMeNotificationKey, boolean>;
type ClientNotificationSettings = Record<IspClientNotificationKey, boolean>;
type HotspotNotificationSettings = Record<IspHotspotNotificationKey, boolean>;
type Audience = "me" | "client" | "hotspot" | "custom";
type MessageMap<T extends string> = Partial<Record<T, string>>;

type MessageClient = { id: string; name: string; phone: string };
type MessageRouter = { id: string; name: string; clients: MessageClient[] };
type MessageRecipients = {
  pppoe?: { routers: MessageRouter[] };
  routers?: MessageRouter[];
  sms: { ready: boolean; mode: string; provider: string; sender: string };
};

type NotificationsPayload = {
  notifications: NotificationSettings;
  clientNotifications?: ClientNotificationSettings;
  hotspotNotifications?: HotspotNotificationSettings;
  notificationMessages?: MessageMap<IspMeNotificationKey>;
  clientNotificationMessages?: MessageMap<IspClientNotificationKey>;
  hotspotNotificationMessages?: MessageMap<IspHotspotNotificationKey>;
};

const meDefaults: NotificationSettings = {
  mikrotikOnboarded: true,
  mikrotikUnreachable: true,
  mikrotikNoInternet: true,
  clientCannotSurf: true,
  clientsMoved: true,
  uplinkRenewalNear: true,
  usageLimitHit: true,
  subscriptionEnding: true,
  communicationsFailed: true,
  paymentsFailed: true,
  serverUnreachable: true,
};

const clientDefaults: ClientNotificationSettings = {
  subscriptionEnding: true,
  subscriptionExpired: true,
  paymentReceived: true,
  accountActivated: true,
  accountPaused: true,
  maintenance: true,
};

const hotspotDefaults: HotspotNotificationSettings = {
  sessionEnding: true,
  sessionExpired: true,
  paymentReceived: true,
  voucherActivated: true,
  maintenance: true,
};

function CustomMessagePanel() {
  const [recipients, setRecipients] = useState<MessageRecipients | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openRouters, setOpenRouters] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let stopped = false;
    apiRequest<MessageRecipients>("/api/notifications/message-recipients")
      .then((body) => {
        if (stopped) return;
        setRecipients(body);
        const routers = body.pppoe?.routers ?? body.routers ?? [];
        setOpenRouters(Object.fromEntries(routers.map((router) => [router.id, true])));
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Clients could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, []);

  const routers = recipients?.pppoe?.routers ?? recipients?.routers ?? [];
  const selectedIds = Object.entries(selected)
    .filter(([, on]) => on)
    .map(([id]) => id);
  const totalClients = routers.reduce((sum, router) => sum + router.clients.length, 0);

  function toggleClient(id: string, on: boolean) {
    setSelected((current) => ({ ...current, [id]: on }));
  }

  function toggleRouter(router: MessageRouter, on: boolean) {
    setSelected((current) => {
      const next = { ...current };
      for (const client of router.clients) next[client.id] = on;
      return next;
    });
  }

  function routerState(router: MessageRouter) {
    const count = router.clients.filter((client) => selected[client.id]).length;
    return {
      count,
      all: router.clients.length > 0 && count === router.clients.length,
      some: count > 0 && count < router.clients.length,
    };
  }

  const provider = (recipients?.sms.provider || "custom") as SmsProvider;

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">
        Type a custom SMS and choose PPPoE clients by MikroTik. Messages use the SMS gateway set under
        Communications
        {recipients?.sms.ready
          ? ` (${SMS_PROVIDER_LABELS[provider] || "SMS"}${recipients.sms.sender ? ` · ${recipients.sms.sender}` : ""}, ${
              recipients.sms.mode === "company" ? "company API" : "your API"
            })`
          : ""}
        .
      </p>
      {!recipients?.sms.ready && loaded ? (
        <p className="notice" role="status">
          Set up and enable an SMS gateway under Communications before sending.
        </p>
      ) : null}
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}

      <FormField id="custom-message" label="Message" hint={`${message.length}/640 characters`}>
        <textarea
          id="custom-message"
          className="field min-h-28 resize-y"
          maxLength={640}
          value={message}
          placeholder="Write the SMS clients should receive…"
          onChange={(event) => setMessage(event.target.value)}
        />
      </FormField>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">
          Selected {selectedIds.length} of {totalClients} PPPoE clients
        </p>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton
            type="button"
            disabled={!routers.length}
            onClick={() => {
              const next: Record<string, boolean> = {};
              for (const router of routers) {
                for (const client of router.clients) next[client.id] = true;
              }
              setSelected(next);
            }}
          >
            Select all
          </SecondaryButton>
          <SecondaryButton type="button" disabled={!selectedIds.length} onClick={() => setSelected({})}>
            Clear
          </SecondaryButton>
        </div>
      </div>

      <div className="grid max-h-[28rem] gap-3 overflow-y-auto pr-1">
        {!loaded ? <LiveLoad label="Loading clients" /> : null}
        {loaded && !routers.length ? (
          <p className="text-sm text-muted-foreground">No PPPoE clients with phone numbers yet.</p>
        ) : null}
        {routers.map((router) => {
          const state = routerState(router);
          const open = openRouters[router.id] ?? true;
          return (
            <section key={router.id} className="rounded-lg border border-border">
              <div className="flex items-center gap-3 border-b border-border/70 bg-surface-muted/40 px-3 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={state.all}
                  ref={(node) => {
                    if (node) node.indeterminate = state.some;
                  }}
                  onChange={(event) => toggleRouter(router, event.target.checked)}
                  aria-label={`Select all on ${router.name}`}
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                  onClick={() => setOpenRouters((current) => ({ ...current, [router.id]: !open }))}
                >
                  <span className="truncate font-semibold text-foreground">{router.name}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {state.count}/{router.clients.length}
                  </span>
                </button>
              </div>
              {open ? (
                <ul className="divide-y divide-border/60">
                  {router.clients.map((client) => (
                    <li key={client.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-muted/30">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={Boolean(selected[client.id])}
                          onChange={(event) => toggleClient(client.id, event.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{client.name}</span>
                          <span className="block truncate text-caption text-muted-foreground">{client.phone}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      <div>
        <PrimaryButton
          type="button"
          disabled={pending || !loaded || !recipients?.sms.ready || !message.trim() || !selectedIds.length}
          onClick={() => {
            setError("");
            setNotice("");
            setPending(true);
            apiRequest<{ sent: number; failed: number }>("/api/notifications/message", {
              method: "POST",
              body: JSON.stringify({
                message: message.trim(),
                service: "pppoe",
                subscriberIds: selectedIds,
              }),
            })
              .then((body) => {
                setNotice(
                  body.failed
                    ? `Sent to ${body.sent} client${body.sent === 1 ? "" : "s"}; ${body.failed} failed.`
                    : `Sent to ${body.sent} client${body.sent === 1 ? "" : "s"}.`,
                );
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof ApiRequestError
                    ? cause.message
                    : cause instanceof Error
                      ? cause.message
                      : "The message could not be sent.",
                );
              })
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Sending…" : `Send SMS${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
        </PrimaryButton>
      </div>
    </div>
  );
}

export function IspNotificationSettingsPage() {
  const { user, ready } = useAuth();
  usePageMeta(
    "ISP NOTIFICATION SETTINGS — ISP CENTRIC",
    "Choose which events should notify this account and its clients.",
  );
  const [audience, setAudience] = useState<Audience>("me");
  const [toggles, setToggles] = useState<NotificationSettings>(meDefaults);
  const [clientToggles, setClientToggles] = useState<ClientNotificationSettings>(clientDefaults);
  const [hotspotToggles, setHotspotToggles] = useState<HotspotNotificationSettings>(hotspotDefaults);
  const [messages, setMessages] = useState<MessageMap<IspMeNotificationKey>>({});
  const [clientMessages, setClientMessages] = useState<MessageMap<IspClientNotificationKey>>({});
  const [hotspotMessages, setHotspotMessages] = useState<MessageMap<IspHotspotNotificationKey>>({});
  const [savingMessageKey, setSavingMessageKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: NotificationsPayload) => {
    setToggles({ ...meDefaults, ...body.notifications });
    setClientToggles({ ...clientDefaults, ...(body.clientNotifications ?? {}) });
    setHotspotToggles({ ...hotspotDefaults, ...(body.hotspotNotifications ?? {}) });
    setMessages(body.notificationMessages ?? {});
    setClientMessages(body.clientNotificationMessages ?? {});
    setHotspotMessages(body.hotspotNotificationMessages ?? {});
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    let stopped = false;
    apiRequest<NotificationsPayload>("/api/notifications")
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

  async function saveMessage(
    scope: "me" | "client" | "hotspot",
    key: string,
    message: string | null,
  ) {
    setSavingMessageKey(key);
    try {
      const body = await apiRequest<NotificationsPayload>("/api/notifications/messages", {
        method: "POST",
        body: JSON.stringify({ audience: scope, key, message }),
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
        description="Enable or disable each alert, preview the message that will be sent, and add or edit the wording."
      />
      <div className="mt-6">
        <SoundAlertsCard apiBase="/api/notifications" scope="client" />
      </div>
      {error && audience !== "custom" ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice && audience !== "custom" ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}
      <div className="form-card mt-6 max-w-2xl">
        <FormPicker
          label="Notification audience"
          value={audience}
          onChange={(id) => {
            setAudience(id as Audience);
            setNotice("");
            setError("");
          }}
          options={[
            { id: "me", label: "Notify me when" },
            { id: "client", label: "Notify client when" },
            { id: "hotspot", label: "Notify hotspot clients when" },
            { id: "custom", label: "Custom message" },
          ]}
        />

        {audience === "custom" ? (
          <CustomMessagePanel />
        ) : (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              setNotice("");
              setPending(true);
              apiRequest<NotificationsPayload>("/api/notifications", {
                method: "POST",
                body: JSON.stringify({
                  notifications: toggles,
                  clientNotifications: clientToggles,
                  hotspotNotifications: hotspotToggles,
                }),
              })
                .then((body) => {
                  apply(body);
                  setNotice(
                    audience === "hotspot"
                      ? "Hotspot notification settings saved."
                      : audience === "client"
                        ? "Client notification settings saved."
                        : "Notification settings saved.",
                  );
                })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "Notification settings could not be saved.");
                })
                .finally(() => setPending(false));
            }}
          >
            {audience === "me" ? (
              <NotificationEventList
                items={meNotificationEvents}
                values={toggles}
                messages={messages}
                savingKey={savingMessageKey as IspMeNotificationKey | null}
                onToggle={(key, enabled) => setToggles((current) => ({ ...current, [key]: enabled }))}
                onSaveMessage={(key, message) => saveMessage("me", key, message)}
                intro="Alerts for this ISP account — shown in the notifications feed and optional push sound. Use view to preview, then add or edit the message."
              />
            ) : null}
            {audience === "client" ? (
              <NotificationEventList
                items={clientNotificationEvents}
                values={clientToggles}
                messages={clientMessages}
                savingKey={savingMessageKey as IspClientNotificationKey | null}
                onToggle={(key, enabled) => setClientToggles((current) => ({ ...current, [key]: enabled }))}
                onSaveMessage={(key, message) => saveMessage("client", key, message)}
                intro="Automatic SMS to PPPoE subscribers through the communication API in use for this account. Toggle each event, preview the SMS, then add or edit the wording."
              />
            ) : null}
            {audience === "hotspot" ? (
              <NotificationEventList
                items={hotspotNotificationEvents}
                values={hotspotToggles}
                messages={hotspotMessages}
                savingKey={savingMessageKey as IspHotspotNotificationKey | null}
                onToggle={(key, enabled) => setHotspotToggles((current) => ({ ...current, [key]: enabled }))}
                onSaveMessage={(key, message) => saveMessage("hotspot", key, message)}
                intro="Automatic SMS to hotspot guests through the communication API in use for this account. Toggle each event, preview the SMS, then add or edit the wording."
              />
            ) : null}
            <div>
              <PrimaryButton type="submit" disabled={pending || !loaded}>
                {audience === "hotspot"
                  ? "Save hotspot notifications"
                  : audience === "client"
                    ? "Save client notifications"
                    : "Save notification settings"}
              </PrimaryButton>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
