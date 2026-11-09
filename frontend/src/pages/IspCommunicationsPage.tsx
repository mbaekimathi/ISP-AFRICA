import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  CommunicationChannelFields,
  CommunicationSummary,
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
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type Source = "own" | "company";

type ChannelSettings = {
  mode: Source;
  own: CommunicationRecord | null;
  company: CommunicationRecord | null;
};

type CommunicationSettings = Record<Channel, ChannelSettings>;

type ConnectionCheck = { state: "idle" | "checking" | "ok" | "failed"; reason: string };

const idleCheck: ConnectionCheck = { state: "idle", reason: "" };

const channels: {
  channel: Channel;
  title: string;
  label: string;
  action: string;
}[] = [
  {
    channel: "sms",
    title: "SMS settings",
    label: "SMS",
    action: "Save SMS",
  },
  {
    channel: "whatsapp",
    title: "WhatsApp API",
    label: "WhatsApp",
    action: "Save WhatsApp API",
  },
  {
    channel: "email",
    title: "Email API",
    label: "Email",
    action: "Save email API",
  },
];

const sources: { source: Source; title: string; detail: string }[] = [
  {
    source: "own",
    title: "My API",
    detail: "Send with the endpoint, sender, and API key saved for this account.",
  },
  {
    source: "company",
    title: "Company API",
    detail: "Send with the communication API set up by the company instead.",
  },
];

function isChannel(value: string | undefined): value is Channel {
  return value === "sms" || value === "whatsapp" || value === "email";
}

export function IspCommunicationsPage() {
  const { user, ready } = useAuth();
  const { channel: channelParam } = useParams<{ channel: string }>();
  const channel = isChannel(channelParam) ? channelParam : null;
  usePageMeta("ISP COMMUNICATIONS SETTINGS — ISP CENTRIC", "Set the SMS, WhatsApp, and email API settings.");
  const [drafts, setDrafts] = useState<Record<Channel, CommunicationDraft>>({
    sms: emptyDraft,
    whatsapp: emptyDraft,
    email: emptyDraft,
  });
  const [settings, setSettings] = useState<CommunicationSettings | null>(null);
  const [modes, setModes] = useState<Record<Channel, Source>>({ sms: "own", whatsapp: "own", email: "own" });
  const [checks, setChecks] = useState<Record<Channel, ConnectionCheck>>({
    sms: idleCheck,
    whatsapp: idleCheck,
    email: idleCheck,
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Channel | null>(null);
  const [loaded, setLoaded] = useState(false);

  const testConnection = useCallback((tested: Channel, source: Source, form?: CommunicationDraft) => {
    setChecks((current) => ({ ...current, [tested]: { state: "checking", reason: "" } }));
    apiRequest<{ test: { connected: boolean; reason: string } }>("/api/communications/test", {
      method: "POST",
      body: JSON.stringify(
        form ? { channel: tested, source, settings: { endpoint: form.endpoint } } : { channel: tested, source },
      ),
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
      setSettings(body);
      setModes({
        sms: body.sms.mode,
        whatsapp: body.whatsapp.mode,
        email: body.email.mode,
      });
      setDrafts({
        sms: draftFrom(body.sms.own),
        whatsapp: draftFrom(body.whatsapp.own),
        email: draftFrom(body.email.own),
      });
      setLoaded(true);
      for (const id of ["sms", "whatsapp", "email"] as Channel[]) {
        if (body[id][body[id].mode]) testConnection(id, body[id].mode);
      }
    },
    [testConnection],
  );

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

  function update(target: Channel, patch: Partial<CommunicationDraft>) {
    setDrafts((current) => ({ ...current, [target]: { ...current[target], ...patch } }));
  }

  function pickMode(target: Channel, source: Source) {
    setModes((current) => ({ ...current, [target]: source }));
    setChecks((current) => ({ ...current, [target]: idleCheck }));
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

  if (!channel) {
    return <Navigate to={clientPage(user, "/account/settings/isp-communications/sms")} replace />;
  }

  const item = channels.find((entry) => entry.channel === channel)!;
  const draft = drafts[channel];
  const current = settings?.[channel] ?? { mode: "own" as Source, own: null, company: null };
  const mode = modes[channel];
  const check = checks[channel];
  const record = mode === "own" ? current.own : current.company;
  const smsProvider = channel === "sms" ? inferSmsProvider(draft.endpoint, draft.provider) : null;
  const statusDot =
    check.state === "ok" ? "bg-success" : check.state === "failed" ? "bg-destructive" : "bg-muted-foreground";
  const statusText =
    check.state === "checking"
      ? "Checking the connection…"
      : check.state === "ok"
        ? `Connected — ${check.reason || "the API endpoint answered."}`
        : check.state === "failed"
          ? `Not connected — ${check.reason}`
          : record
            ? "Connection not tested yet."
            : mode === "own"
              ? "Save the details, then test the connection."
              : "The company has not set up this API yet.";

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
            Use your own SMS API or the company API. Leave secret fields blank to keep saved values.
          </p>
        </div>
      ) : (
        <div className="mb-6">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">{item.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use your own {item.label} API or the company API. Saved keys stay hidden when left unchanged.
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
            apiRequest<CommunicationSettings>("/api/communications", {
              method: "POST",
              body: JSON.stringify({
                channel,
                mode,
                ...(mode === "own" ? draft : {}),
              }),
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
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-foreground">API source</legend>
            {sources.map((choice) => {
              const selected = mode === choice.source;
              return (
                <label
                  key={choice.source}
                  className={cn(
                    "grid cursor-pointer gap-1 rounded-lg border px-3 py-2 transition-colors duration-fast ease-out",
                    selected
                      ? "border-primary bg-primary/5 shadow-xs"
                      : "border-border hover:border-input hover:bg-surface-muted/50",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <input
                      type="radio"
                      name={`${channel}-source`}
                      className="h-4 w-4"
                      checked={selected}
                      onChange={() => pickMode(channel, choice.source)}
                    />
                    <span className="font-semibold">
                      {choice.source === "own" ? `My ${item.label} API` : `Company ${item.label} API`}
                    </span>
                  </span>
                  <span className="pl-7 text-sm text-muted-foreground">{choice.detail}</span>
                </label>
              );
            })}
          </fieldset>

          {channel === "sms" ? (
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
                    (mode === "own"
                      ? `${SMS_PROVIDER_LABELS[smsProvider!]}${draft.sender ? ` — sender ID ${draft.sender}` : "."}`
                      : statusText.replace(/^Connected — /, ""))
                  : check.state === "failed"
                    ? check.reason
                    : statusText}
              </span>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <span className={cn("h-2.5 w-2.5 rounded-full", statusDot)} aria-hidden="true" />
              {statusText}
            </p>
          )}

          {mode === "own" ? (
            <CommunicationChannelFields
              channel={channel}
              draft={draft}
              idPrefix={channel}
              onChange={(patch) => update(channel, patch)}
            />
          ) : current.company ? (
            <CommunicationSummary channel={channel} record={current.company} />
          ) : (
            <p className="notice" role="status">
              The company has not set up this API yet.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" disabled={pending !== null || !loaded}>
              {mode === "own" ? item.action : `Use the company ${item.label} API`}
            </PrimaryButton>
            <SecondaryButton
              type="button"
              disabled={pending !== null || check.state === "checking"}
              onClick={() => testConnection(channel, mode, mode === "own" ? draft : undefined)}
            >
              Test connection
            </SecondaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}
