import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField, FormPicker } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

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
    title: "Company SMS gateway",
    endpoint: "SMS API endpoint",
    sender: "Sender ID",
    secret: "API key",
    action: "Save SMS gateway",
  },
  {
    channel: "whatsapp",
    title: "Company WhatsApp gateway",
    endpoint: "WhatsApp API endpoint",
    sender: "Phone number ID",
    secret: "Access token",
    action: "Save WhatsApp gateway",
  },
  {
    channel: "email",
    title: "Company email gateway",
    endpoint: "Email API endpoint",
    sender: "From email",
    secret: "API key",
    action: "Save email gateway",
  },
];

function draftFrom(record: CommunicationRecord | null): CommunicationDraft {
  return record ? { endpoint: record.endpoint, sender: record.sender, apiKey: record.apiKey } : emptyDraft;
}

export function CompanyCommunicationsPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta(
    "COMPANY COMMUNICATIONS — ISP CENTRIC",
    "Set up the company SMS, WhatsApp, and email gateways.",
  );
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
    if (!employee || employee.status !== "approved") return;
    let stopped = false;
    apiRequest<CommunicationSettings>("/api/employee/company/communications")
      .then((body) => {
        if (!stopped) apply(body);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Company communication settings could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, employee]);

  function update(channel: Channel, field: keyof CommunicationDraft, value: string) {
    setDrafts((current) => ({ ...current, [channel]: { ...current[channel], [field]: value } }));
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
    <div className="page-shell py-10">
      <PageHeader
        title="Company communications"
        description="Set up the company SMS, WhatsApp, and email gateways. Saved keys and tokens stay hidden and are kept when those fields are left unchanged."
      />
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-stack mt-6">
        <FormPicker
          label="Company communication API"
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
                apiRequest<CommunicationSettings>("/api/employee/company/communications", {
                  method: "POST",
                  body: JSON.stringify({ channel: item.channel, ...draft }),
                })
                  .then((body) => {
                    apply(body);
                    setError("");
                  })
                  .catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "That company gateway could not be saved.");
                  })
                  .finally(() => setPending(null));
              }}
            >
              <div>
                <h2 className="text-lg font-semibold">{item.title}</h2>
                {saved[item.channel] ? <p className="mt-1 text-sm text-muted-foreground">Saved for the company.</p> : null}
              </div>
              <div className="grid gap-4">
                <FormField id={`company-${item.channel}-endpoint`} label={item.endpoint}>
                  <input
                    id={`company-${item.channel}-endpoint`}
                    className="field"
                    inputMode="url"
                    value={draft.endpoint}
                    onChange={(event) => update(item.channel, "endpoint", event.target.value)}
                  />
                </FormField>
                <FormField id={`company-${item.channel}-sender`} label={item.sender}>
                  <input
                    id={`company-${item.channel}-sender`}
                    className="field"
                    type={item.channel === "email" ? "email" : "text"}
                    autoComplete="off"
                    value={draft.sender}
                    onChange={(event) => update(item.channel, "sender", event.target.value)}
                  />
                </FormField>
                <FormField id={`company-${item.channel}-key`} label={item.secret}>
                  <input
                    id={`company-${item.channel}-key`}
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
