import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  CommunicationChannelFields,
  SMS_PROVIDER_LABELS,
  draftFrom,
  emptyDraft,
  inferSmsProvider,
  type Channel,
  type CommunicationDraft,
  type CommunicationRecord,
} from "@/components/communication/CommunicationFields";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { cn } from "@/lib/cn";
import { employeePage } from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type CommunicationSettings = Record<Channel, CommunicationRecord | null>;

type ConnectionCheck = { state: "idle" | "checking" | "ok" | "failed"; reason: string };

const idleCheck: ConnectionCheck = { state: "idle", reason: "" };

const channels: {
  channel: Channel;
  title: string;
  action: string;
}[] = [
  {
    channel: "sms",
    title: "SMS settings",
    action: "Save SMS",
  },
  {
    channel: "whatsapp",
    title: "Company WhatsApp gateway",
    action: "Save WhatsApp gateway",
  },
  {
    channel: "email",
    title: "Company email gateway",
    action: "Save email gateway",
  },
];

function isChannel(value: string | undefined): value is Channel {
  return value === "sms" || value === "whatsapp" || value === "email";
}

export function CompanyCommunicationsPage() {
  const { employee, ready } = useEmployeeAuth();
  const { channel: channelParam } = useParams<{ channel: string }>();
  const channel = isChannel(channelParam) ? channelParam : null;
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
  const [checks, setChecks] = useState<Record<Channel, ConnectionCheck>>({
    sms: idleCheck,
    whatsapp: idleCheck,
    email: idleCheck,
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Channel | null>(null);
  const [loaded, setLoaded] = useState(false);

  const testConnection = useCallback((tested: Channel, form?: CommunicationDraft) => {
    setChecks((current) => ({ ...current, [tested]: { state: "checking", reason: "" } }));
    apiRequest<{ test: { connected: boolean; reason: string } }>("/api/employee/company/communications/test", {
      method: "POST",
      body: JSON.stringify(form ? { channel: tested, endpoint: form.endpoint } : { channel: tested }),
    })
      .then((body) => {
        setChecks((current) => ({
          ...current,
          [tested]: body.test.connected
            ? { state: "ok", reason: body.test.reason }
            : { state: "failed", reason: body.test.reason },
        }));
      })
      .catch((cause: unknown) => {
        setChecks((current) => ({
          ...current,
          [tested]: {
            state: "failed",
            reason: cause instanceof ApiRequestError ? cause.message : "The connection test could not be completed.",
          },
        }));
      });
  }, []);

  const apply = useCallback(
    (body: CommunicationSettings) => {
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
      for (const id of ["sms", "whatsapp", "email"] as Channel[]) {
        if (body[id]) testConnection(id);
      }
    },
    [testConnection],
  );

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

  function update(channel: Channel, patch: Partial<CommunicationDraft>) {
    setDrafts((current) => ({ ...current, [channel]: { ...current[channel], ...patch } }));
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

  if (!channel) {
    return <Navigate to={employeePage(employee, "/company-settings/communications/sms")} replace />;
  }

  const item = channels.find((entry) => entry.channel === channel)!;
  const draft = drafts[channel];
  const check = checks[channel];
  const smsProvider = channel === "sms" ? inferSmsProvider(draft.endpoint, draft.provider) : null;
  const statusDot =
    check.state === "ok" ? "bg-success" : check.state === "failed" ? "bg-destructive" : "bg-muted-foreground";
  const statusText =
    check.state === "checking"
      ? "Checking the connection…"
      : check.state === "ok"
        ? check.reason || "Connected — the API endpoint answered."
        : check.state === "failed"
          ? `Not connected — ${check.reason}`
          : saved[channel]
            ? "Connection not tested yet."
            : "Save the details, then test the connection.";

  return (
    <div className="page-shell py-8">
      <PageHeader title={item.title} />
      {channel === "sms" ? (
        <div className="mb-6">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Settings · Communication settings
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">SMS settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Credentials are saved for the company. Leave secret fields blank to keep the current values.
          </p>
        </div>
      ) : (
        <div className="mb-6">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">{item.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved keys and tokens stay hidden and are kept when those fields are left unchanged.
          </p>
        </div>
      )}
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-stack mt-2">
        <form
          className="form-card"
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            setPending(channel);
            apiRequest<CommunicationSettings>("/api/employee/company/communications", {
              method: "POST",
              body: JSON.stringify({ channel, ...draft }),
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
          {channel !== "sms" ? (
            <>
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold">{item.title}</h3>
                {saved[channel] ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-caption font-semibold",
                      draft.enabled
                        ? "border border-success-border bg-success-soft/60 text-success"
                        : "bg-surface-muted text-muted-foreground",
                    )}
                  >
                    {draft.enabled ? "ON" : "OFF"}
                  </span>
                ) : null}
              </div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <span className={cn("h-2.5 w-2.5 rounded-full", statusDot)} aria-hidden="true" />
                {statusText}
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2" role="status">
              {check.state === "ok" ? (
                <span className="rounded-full border border-success-border bg-success-soft/70 px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-success">
                  Connected
                </span>
              ) : check.state === "failed" ? (
                <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-destructive">
                  Not connected
                </span>
              ) : check.state === "checking" ? (
                <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Checking
                </span>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {check.state === "ok"
                  ? check.reason ||
                    `${SMS_PROVIDER_LABELS[smsProvider!]}${draft.sender ? ` — sender ID ${draft.sender}` : "."}`
                  : check.state === "failed"
                    ? check.reason
                    : saved.sms
                      ? "Connection not tested yet."
                      : "Save the details, then test the connection."}
              </span>
            </div>
          )}
          <CommunicationChannelFields
            channel={channel}
            draft={draft}
            idPrefix={`company-${channel}`}
            onChange={(patch) => update(channel, patch)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" disabled={pending !== null || !loaded}>
              {item.action}
            </PrimaryButton>
            <SecondaryButton
              type="button"
              disabled={pending !== null || check.state === "checking"}
              onClick={() => testConnection(channel, draft)}
            >
              Test connection
            </SecondaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}
