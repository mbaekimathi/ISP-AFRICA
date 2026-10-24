import { FormField } from "@/components/ui/FormField";
import { cn } from "@/lib/cn";

export type Channel = "sms" | "whatsapp" | "email";

export type CommunicationDraft = {
  enabled: boolean;
  endpoint: string;
  sender: string;
  apiKey: string;
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
  username: "",
  port: "465",
  fromName: "",
  useTls: true,
  apiVersion: "",
  businessAccountId: "",
};

export function draftFrom(record: CommunicationRecord | null): CommunicationDraft {
  if (!record) return { ...emptyDraft };
  return {
    ...emptyDraft,
    ...record,
    port: record.port === "" ? "" : String(record.port),
  };
}

const channelNames: Record<Channel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
};

const enabledDetails: Record<Channel, string> = {
  sms: "Send customer notices through this SMS gateway.",
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
  return (
    <>
      <FormField
        id={`${idPrefix}-endpoint`}
        label="SMS API endpoint"
        hint="Africa's Talking: https://api.africastalking.com/version1/messaging — any HTTPS SMS API works."
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
        <FormField id={`${idPrefix}-sender`} label="Sender ID" hint="3–11 letters or digits, e.g. ISPCENTRIC.">
          <input
            id={`${idPrefix}-sender`}
            className="field"
            autoComplete="off"
            value={draft.sender}
            onChange={(event) => onChange({ sender: event.target.value })}
          />
        </FormField>
        <FormField
          id={`${idPrefix}-username`}
          label="API username / account ID"
          hint="Africa's Talking username or Twilio Account SID. Leave blank if the API key alone is enough."
        >
          <input
            id={`${idPrefix}-username`}
            className="field"
            autoComplete="off"
            value={draft.username}
            onChange={(event) => onChange({ username: event.target.value })}
          />
        </FormField>
      </div>
      <FormField id={`${idPrefix}-key`} label="API key" hint="From your SMS provider's dashboard.">
        <input
          id={`${idPrefix}-key`}
          type="password"
          className="field"
          autoComplete="new-password"
          value={draft.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </FormField>
    </>
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
      <FormField
        id={`${idPrefix}-key`}
        label="Access token"
        hint="Permanent access token from your Meta app."
      >
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
      {channel === "sms" ? <SmsFields draft={draft} idPrefix={idPrefix} onChange={onChange} /> : null}
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
    rows.push(["SMS API endpoint", record.endpoint]);
    rows.push(["Sender ID", record.sender]);
    if (record.username) rows.push(["API username", record.username]);
    rows.push(["API key", record.apiKey]);
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
