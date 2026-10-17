import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";

type Channel = "sms" | "whatsapp" | "email";

type CommunicationDraft = {
  endpoint: string;
  sender: string;
  apiKey: string;
};

type CommunicationRecord = CommunicationDraft;

type CommunicationSettings = Record<Channel, CommunicationRecord | null>;

const emptyDraft: CommunicationDraft = { endpoint: "", sender: "", apiKey: "" };

const channels: {
  channel: Channel;
  title: string;
  endpoint: string;
  sender: string;
  secret: string;
  action: string;
}[] = [
  {
    channel: "sms",
    title: "SMS API",
    endpoint: "SMS API endpoint",
    sender: "Sender ID",
    secret: "API key",
    action: "Save SMS API",
  },
  {
    channel: "whatsapp",
    title: "WHATS APP API",
    endpoint: "WhatsApp API endpoint",
    sender: "Phone number ID",
    secret: "Access token",
    action: "Save WhatsApp API",
  },
  {
    channel: "email",
    title: "EMAIL API",
    endpoint: "Email API endpoint",
    sender: "From email",
    secret: "API key",
    action: "Save email API",
  },
];

function draftFrom(record: CommunicationRecord | null): CommunicationDraft {
  return record ? { endpoint: record.endpoint, sender: record.sender, apiKey: record.apiKey } : emptyDraft;
}

export function IspCommunicationsPage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP COMMUNICATIONS SETTINGS — ISP CENTRIC", "Set the SMS, WhatsApp, and email API settings.");
  const [drafts, setDrafts] = useState<Record<Channel, CommunicationDraft>>({
    sms: emptyDraft,
    whatsapp: emptyDraft,
    email: emptyDraft,
  });
  const [saved, setSaved] = useState<Record<Channel, boolean>>({ sms: false, whatsapp: false, email: false });
  const [channel, setChannel] = useState<Channel>("sms");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Channel | null>(null);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((body: CommunicationSettings) => {
    setDrafts({
      sms: draftFrom(body.sms),
      whatsapp: draftFrom(body.whatsapp),
      email: draftFrom(body.email),
    });
    setSaved({
      sms: Boolean(body.sms),
      whatsapp: Boolean(body.whatsapp),
      email: Boolean(body.email),
    });
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    let stopped = false;
    apiRequest<CommunicationSettings>("/api/communications")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Communication settings could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, user]);

  function update(channel: Channel, field: keyof CommunicationDraft, value: string) {
    setDrafts((current) => ({ ...current, [channel]: { ...current[channel], [field]: value } }));
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
        title="Communications"
        description="Set the SMS, WhatsApp, and email API for this account. Saved keys and tokens stay hidden and are kept when those fields are left unchanged."
      />
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-stack mt-6">
        <FormPicker
          label="Communication API"
          value={channel}
          onChange={(id) => setChannel(id as Channel)}
          options={[
            { id: "sms", label: "SMS" },
            { id: "whatsapp", label: "WhatsApp" },
            { id: "email", label: "Email" },
          ]}
        />
        {channels.map((item) => {
          const draft = drafts[item.channel];
          return (
            <form
              key={item.channel}
              hidden={channel !== item.channel}
              className="form-card"
              onSubmit={(event) => {
                event.preventDefault();
                setError("");
                setPending(item.channel);
                apiRequest<CommunicationSettings>("/api/communications", {
                  method: "POST",
                  body: JSON.stringify({ channel: item.channel, ...draft }),
                })
                  .then((body) => {
                    apply(body);
                    setError("");
                  })
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "That communication API could not be saved.");
                  })
                  .finally(() => setPending(null));
              }}
            >
              <div>
                <h2 className="text-lg font-semibold">{item.title}</h2>
                {saved[item.channel] ? <p className="mt-1 text-sm text-muted-foreground">Saved for this account.</p> : null}
              </div>
              <div className="grid gap-4">
                <FormField id={`${item.channel}-endpoint`} label={item.endpoint}>
                  <input
                    id={`${item.channel}-endpoint`}
                    className="field"
                    inputMode="url"
                    value={draft.endpoint}
                    onChange={(event) => update(item.channel, "endpoint", event.target.value)}
                  />
                </FormField>
                <FormField id={`${item.channel}-sender`} label={item.sender}>
                  <input
                    id={`${item.channel}-sender`}
                    className="field"
                    type={item.channel === "email" ? "email" : "text"}
                    autoComplete="off"
                    value={draft.sender}
                    onChange={(event) => update(item.channel, "sender", event.target.value)}
                  />
                </FormField>
                <FormField id={`${item.channel}-key`} label={item.secret}>
                  <input
                    id={`${item.channel}-key`}
                    type="password"
                    className="field"
                    autoComplete="new-password"
                    value={draft.apiKey}
                    onChange={(event) => update(item.channel, "apiKey", event.target.value)}
                  />
                </FormField>
              </div>
              <div>
                <PrimaryButton type="submit" disabled={pending !== null || !loaded}>
                  {item.action}
                </PrimaryButton>
              </div>
            </form>
          );
        })}
      </div>
    </div>
  );
}
