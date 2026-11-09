import { FormField } from "@/components/ui/FormField";
import { cn } from "@/lib/cn";

export type Channel = "sms" | "whatsapp" | "email";

export type SmsProvider = "africastalking" | "twilio" | "blessedtexts" | "custom";

export type CommunicationDraft = {
  enabled: boolean;
  endpoint: string;
  sender: string;
  apiKey: string;
  apiSecret: string;
  provider: SmsProvider | "";
  username: string;
  port: string;
  fromName: string;
  useTls: boolean;
  apiVersion: string;
  businessAccountId: string;
};

export type CommunicationRecord = Omit<CommunicationDraft, "port"> & {
  port: number | "";
};

export const emptyDraft: CommunicationDraft = {
  enabled: true,
  endpoint: "",
  sender: "",
  apiKey: "",
  apiSecret: "",
  provider: "blessedtexts",
  username: "",
  port: "465",
  fromName: "",
  useTls: true,
  apiVersion: "",
  businessAccountId: "",
};

export const SMS_PROVIDERS: {
  id: SmsProvider;
  label: string;
  endpoint: string;
}[] = [
  {
    id: "africastalking",
    label: "Africa’s Talking",
    endpoint: "https://api.africastalking.com/version1/messaging",
  },
  {
    id: "twilio",
    label: "Twilio",
    endpoint: "https://api.twilio.com",
  },
  {
    id: "blessedtexts",
    label: "BlessedTexts",
    endpoint: "https://sms.blessedtexts.com/api/sms/v1",
  },
  {
    id: "custom",
    label: "Custom HTTP",
    endpoint: "",
  },
];

export const SMS_PROVIDER_LABELS: Record<SmsProvider, string> = {
  africastalking: "Africa’s Talking",
  twilio: "Twilio",
  blessedtexts: "BlessedTexts",
  custom: "Custom HTTP",
};

function isSmsProvider(value: string | undefined | null): value is SmsProvider {
  return value === "africastalking" || value === "twilio" || value === "blessedtexts" || value === "custom";
}

export function inferSmsProvider(endpoint: string, provider?: string | null): SmsProvider {
  if (isSmsProvider(provider)) return provider;
  const host = endpoint.toLowerCase();
  if (host.includes("africastalking")) return "africastalking";
  if (host.includes("twilio.com")) return "twilio";
  if (host.includes("blessedtexts")) return "blessedtexts";
  return endpoint ? "custom" : "blessedtexts";
}

export function draftFrom(record: CommunicationRecord | null): CommunicationDraft {
  if (!record) return { ...emptyDraft };
  const provider = inferSmsProvider(record.endpoint || "", record.provider);
  return {
    ...emptyDraft,
    ...record,
    provider,
    apiSecret: record.apiSecret || "",
    port: record.port === "" || record.port == null ? "" : String(record.port),
  };
}

const channelNames: Record<Channel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
};

const enabledDetails: Record<Channel, string> = {
  sms: "Triggered drafts and broadcasts can send text messages.",
  whatsapp: "Send customer notices through this WhatsApp API.",
  email: "SMTP used for platform notices to ISPs and customers.",
};

const knownSmtp: Record<string, { host: string; port: string }> = {
  "gmail.com": { host: "smtp.gmail.com", port: "587" },
  "googlemail.com": { host: "smtp.gmail.com", port: "587" },
  "outlook.com": { host: "smtp.office365.com", port: "587" },
  "hotmail.com": { host: "smtp.office365.com", port: "587" },
  "live.com": { host: "smtp.office365.com", port: "587" },
  "msn.com": { host: "smtp.office365.com", port: "587" },
  "yahoo.com": { host: "smtp.mail.yahoo.com", port: "465" },
  "ymail.com": { host: "smtp.mail.yahoo.com", port: "465" },
  "rocketmail.com": { host: "smtp.mail.yahoo.com", port: "465" },
  "zoho.com": { host: "smtp.zoho.com", port: "465" },
  "icloud.com": { host: "smtp.mail.me.com", port: "587" },
  "me.com": { host: "smtp.mail.me.com", port: "587" },
  "mac.com": { host: "smtp.mail.me.com", port: "587" },
};

function smtpSuggestion(address: string) {
  const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain.includes(".")) return null;
  return knownSmtp[domain] ?? { host: `mail.${domain}`, port: "465" };
}

type FieldsProps = {
  draft: CommunicationDraft;
  idPrefix: string;
  onChange: (patch: Partial<CommunicationDraft>) => void;
};

function SmsFields({ draft, idPrefix, onChange }: FieldsProps) {
  const provider = inferSmsProvider(draft.endpoint, draft.provider);

  function selectProvider(next: SmsProvider) {
    const preset = SMS_PROVIDERS.find((item) => item.id === next);
    const known = SMS_PROVIDERS.some((item) => item.endpoint && item.endpoint === draft.endpoint);
    onChange({
      provider: next,
      endpoint: known || !draft.endpoint ? preset?.endpoint || "" : draft.endpoint,
    });
  }

  return (
    <div className="grid gap-5">
      <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
              Text (SMS) API
            </p>
            <p className="mt-1 text-sm text-muted-foreground">SMS provider API credentials and sender identity.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em]",
                  draft.enabled
                    ? "border border-success-border bg-success-soft/70 text-success"
                    : "bg-surface-muted text-muted-foreground",
                )}
              >
                SMS channel {draft.enabled ? "on" : "off"}
              </span>
              <span className="text-sm text-muted-foreground">{enabledDetails.sms}</span>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label="SMS channel enabled"
            className={cn(
              "relative inline-flex h-8 w-[3.25rem] shrink-0 items-center rounded-full transition duration-fast ease-out",
              draft.enabled ? "bg-primary" : "bg-muted-foreground/40",
            )}
            onClick={() => onChange({ enabled: !draft.enabled })}
          >
            <span
              className={cn(
                "absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition duration-fast ease-out",
                draft.enabled && "translate-x-[1.35rem]",
              )}
            />
            <span className="sr-only">{draft.enabled ? "On" : "Off"}</span>
          </button>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          SMS provider
        </legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="SMS provider">
          {SMS_PROVIDERS.map((item) => {
            const selected = provider === item.id;
            return (
              <label
                key={item.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition duration-fast ease-out",
                  selected
                    ? "border-success-border bg-success-soft/50 text-foreground shadow-xs"
                    : "border-border bg-surface hover:border-input hover:bg-surface-muted/40",
                )}
              >
                <input
                  type="radio"
                  className="h-4 w-4 accent-primary"
                  name={`${idPrefix}-provider`}
                  checked={selected}
                  onChange={() => selectProvider(item.id)}
                />
                <span className="font-medium">{item.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={`${idPrefix}-sender`} label="SENDER ID">
          <input
            id={`${idPrefix}-sender`}
            className="field"
            autoComplete="off"
            value={draft.sender}
            onChange={(event) => onChange({ sender: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-key`} label="API KEY / USERNAME">
          <input
            id={`${idPrefix}-key`}
            type="password"
            className="field"
            autoComplete="new-password"
            placeholder={draft.apiKey.startsWith("••••") ? "Saved — enter a new value to replace" : undefined}
            value={draft.apiKey.startsWith("••••") ? "" : draft.apiKey}
            onChange={(event) => onChange({ apiKey: event.target.value })}
          />
        </FormField>
      </div>

      <div className="grid gap-4">
        <FormField id={`${idPrefix}-secret`} label="API SECRET / AUTH TOKEN">
          <input
            id={`${idPrefix}-secret`}
            type="password"
            className="field"
            autoComplete="new-password"
            placeholder={
              draft.apiSecret.startsWith("••••")
                ? "Saved — enter a new value to replace"
                : "Optional for some providers"
            }
            value={draft.apiSecret.startsWith("••••") ? "" : draft.apiSecret}
            onChange={(event) => onChange({ apiSecret: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-endpoint`} label="CUSTOM API BASE URL">
          <input
            id={`${idPrefix}-endpoint`}
            className="field"
            inputMode="url"
            value={draft.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
          />
        </FormField>
      </div>

      <div className="grid gap-2 text-sm leading-6 text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">BlessedTexts:</span> put your BlessedTexts API key in the
          username field and your numeric sender ID in Sender ID. Secret and base URL are not needed.
        </p>
        <p>
          <span className="font-medium text-foreground">Africa’s Talking:</span> use your username and apiKey. For
          sandbox testing set Custom API Base URL to{" "}
          <code className="rounded bg-surface-muted px-1 py-0.5 text-caption text-foreground">
            https://api.sandbox.africastalking.com/version1/messaging
          </code>
          .
        </p>
        <p>
          <span className="font-medium text-foreground">Twilio:</span> put your Account SID in the API key /
          username field and Auth Token in the secret field.
        </p>
      </div>
    </div>
  );
}

function WhatsAppFields({ draft, idPrefix, onChange }: FieldsProps) {
  return (
    <>
      <FormField
        id={`${idPrefix}-endpoint`}
        label="WhatsApp API endpoint"
        hint="Meta Cloud API base — https://graph.facebook.com — or your provider's API URL."
      >
        <input
          id={`${idPrefix}-endpoint`}
          className="field"
          inputMode="url"
          value={draft.endpoint}
          onChange={(event) => onChange({ endpoint: event.target.value })}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`${idPrefix}-sender`}
          label="Phone number ID"
          hint="From Meta for Developers — the ID, not the phone number itself."
        >
          <input
            id={`${idPrefix}-sender`}
            className="field"
            inputMode="numeric"
            autoComplete="off"
            value={draft.sender}
            onChange={(event) => onChange({ sender: event.target.value })}
          />
        </FormField>
        <FormField
          id={`${idPrefix}-version`}
          label="API version"
          hint="Graph API version, e.g. v21.0. Used to test the connection."
        >
          <input
            id={`${idPrefix}-version`}
            className="field"
            autoComplete="off"
            placeholder="v21.0"
            value={draft.apiVersion}
            onChange={(event) => onChange({ apiVersion: event.target.value })}
          />
        </FormField>
      </div>
      <FormField id={`${idPrefix}-key`} label="Access token" hint="Permanent access token from your Meta app.">
        <input
          id={`${idPrefix}-key`}
          type="password"
          className="field"
          autoComplete="new-password"
          value={draft.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </FormField>
      <FormField
        id={`${idPrefix}-waba`}
        label="Business account ID"
        hint="WhatsApp Business Account ID — optional."
      >
        <input
          id={`${idPrefix}-waba`}
          className="field"
          inputMode="numeric"
          autoComplete="off"
          value={draft.businessAccountId}
          onChange={(event) => onChange({ businessAccountId: event.target.value })}
        />
      </FormField>
    </>
  );
}

function EmailFields({ draft, idPrefix, onChange }: FieldsProps) {
  function withSmtpSuggestion(patch: Partial<CommunicationDraft>, address: string) {
    if (draft.endpoint) return patch;
    const suggestion = smtpSuggestion(address);
    if (suggestion) {
      return { ...patch, endpoint: suggestion.host, port: suggestion.port, useTls: true };
    }
    return patch;
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`${idPrefix}-host`}
          label="SMTP host"
          hint="Auto-filled from Gmail, Outlook, Yahoo, Zoho, or iCloud. Any other SMTP host also works."
        >
          <input
            id={`${idPrefix}-host`}
            className="field"
            autoComplete="off"
            value={draft.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-port`} label="SMTP port" hint="587 for TLS, 465 for SSL.">
          <input
            id={`${idPrefix}-port`}
            className="field"
            inputMode="numeric"
            autoComplete="off"
            value={draft.port}
            onChange={(event) => onChange({ port: event.target.value })}
          />
        </FormField>
      </div>
      <FormField id={`${idPrefix}-username`} label="SMTP username" hint="Usually the full email address.">
        <input
          id={`${idPrefix}-username`}
          className="field"
          autoComplete="off"
          value={draft.username}
          onChange={(event) => onChange(withSmtpSuggestion({ username: event.target.value }, event.target.value))}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={`${idPrefix}-password`} label="SMTP password" hint="Mailbox password or app password.">
          <input
            id={`${idPrefix}-password`}
            type="password"
            className="field"
            autoComplete="new-password"
            value={draft.apiKey}
            onChange={(event) => onChange({ apiKey: event.target.value })}
          />
        </FormField>
        <FormField
          id={`${idPrefix}-from`}
          label="From email"
          hint="Address clients see. Defaults to the SMTP username."
        >
          <input
            id={`${idPrefix}-from`}
            type="email"
            className="field"
            autoComplete="off"
            value={draft.sender}
            onChange={(event) => onChange(withSmtpSuggestion({ sender: event.target.value }, event.target.value))}
          />
        </FormField>
      </div>
      <FormField id={`${idPrefix}-fromname`} label="From name" hint="Display name, e.g. ISPCENTRIC.">
        <input
          id={`${idPrefix}-fromname`}
          className="field"
          autoComplete="off"
          value={draft.fromName}
          onChange={(event) => onChange({ fromName: event.target.value })}
        />
      </FormField>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={draft.useTls}
          onChange={(event) => onChange({ useTls: event.target.checked })}
        />
        <span className="grid gap-1">
          <span className="text-sm font-medium text-foreground">Use TLS</span>
          <span className="text-caption leading-5 text-muted-foreground">
            Recommended for port 587. Port 465 uses SSL automatically.
          </span>
        </span>
      </label>
    </>
  );
}

export function CommunicationChannelFields({
  channel,
  draft,
  idPrefix,
  onChange,
}: FieldsProps & { channel: Channel }) {
  if (channel === "sms") {
    return <SmsFields draft={draft} idPrefix={idPrefix} onChange={onChange} />;
  }

  return (
    <div className="grid gap-4">
      <label
        className={cn(
          "grid cursor-pointer gap-1 rounded-lg border px-3 py-2 transition-colors duration-fast ease-out",
          draft.enabled
            ? "border-primary bg-primary/5 shadow-xs"
            : "border-border hover:border-input hover:bg-surface-muted/50",
        )}
      >
        <span className="flex items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={draft.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          <span className="font-semibold">{channelNames[channel]} enabled</span>
        </span>
        <span className="pl-7 text-sm text-muted-foreground">{enabledDetails[channel]}</span>
      </label>
      {channel === "whatsapp" ? <WhatsAppFields draft={draft} idPrefix={idPrefix} onChange={onChange} /> : null}
      {channel === "email" ? <EmailFields draft={draft} idPrefix={idPrefix} onChange={onChange} /> : null}
    </div>
  );
}

function summaryRows(channel: Channel, record: CommunicationRecord): [string, string][] {
  const rows: [string, string][] = [];
  if (channel === "email") {
    rows.push(["SMTP host", record.endpoint]);
    rows.push(["SMTP port", record.port === "" ? "" : String(record.port)]);
    rows.push(["SMTP username", record.username]);
    rows.push(["SMTP password", record.apiKey]);
    rows.push(["From email", record.sender]);
    if (record.fromName) rows.push(["From name", record.fromName]);
    rows.push(["Use TLS", record.useTls ? "Yes" : "No"]);
  } else if (channel === "whatsapp") {
    rows.push(["WhatsApp API endpoint", record.endpoint]);
    rows.push(["Phone number ID", record.sender]);
    if (record.apiVersion) rows.push(["API version", record.apiVersion]);
    if (record.businessAccountId) rows.push(["Business account ID", record.businessAccountId]);
    rows.push(["Access token", record.apiKey]);
  } else {
    const provider = inferSmsProvider(record.endpoint, record.provider);
    rows.push(["Provider", SMS_PROVIDER_LABELS[provider]]);
    rows.push(["Custom API base URL", record.endpoint]);
    rows.push(["Sender ID", record.sender]);
    rows.push(["API key / username", record.apiKey]);
    if (record.apiSecret) rows.push(["API secret / auth token", record.apiSecret]);
  }
  rows.push(["Status", record.enabled ? "Enabled" : "Disabled"]);
  return rows;
}

export function CommunicationSummary({ channel, record }: { channel: Channel; record: CommunicationRecord }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
      {summaryRows(channel, record).map(([label, value]) => (
        <p key={label}>
          <span className="font-medium text-foreground">{label}:</span> {value}
        </p>
      ))}
    </div>
  );
}
