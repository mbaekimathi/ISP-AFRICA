import { useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Eye, Pencil, Plus, X } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { cn } from "@/lib/cn";

export type NotificationEventItem<T extends string> = {
  key: T;
  label: string;
  detail: string;
  defaultMessage: string;
  placeholders?: string[];
  channel?: "push" | "sms";
};

const SAMPLE: Record<string, string> = {
  name: "Jane Wanjiku",
  router: "Estate Tower A",
  site: "Westlands",
  package: "Home 10Mbps",
  amount: "1500.00",
  expiry: "12 Nov 2026 23:59",
  voucher: "HS-9K2M4P",
  vouchers: "HS-9K2M4P, HS-7Q1L8R",
  phone: "0712 345 678",
  device: "CCR2004-West",
  reason: "Management tunnel did not answer",
  metric: "CPU",
  percent: "92",
  isp: "BrightNet ISP",
  link: "https://isp.example.com/api/public/pay/abc123",
  username: "jane.wanjiku",
};

export function fillNotificationMessage(template: string, values: Record<string, string> = SAMPLE) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key: string) => values[key] ?? full);
}

function ToggleSwitch({
  enabled,
  label,
  onChange,
}: {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition duration-fast ease-out",
        enabled ? "bg-primary" : "bg-muted-foreground/40",
      )}
      onClick={() => onChange(!enabled)}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition duration-fast ease-out",
          enabled && "translate-x-5",
        )}
      />
      <span className="sr-only">{enabled ? "Enabled" : "Disabled"}</span>
    </button>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground transition duration-fast ease-out hover:border-input hover:bg-surface-muted hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function NotificationEventList<T extends string>({
  items,
  values,
  messages,
  onToggle,
  onSaveMessage,
  intro,
  savingKey,
}: {
  items: NotificationEventItem<T>[];
  values: Record<T, boolean>;
  messages: Partial<Record<T, string>>;
  onToggle: (key: T, enabled: boolean) => void;
  onSaveMessage: (key: T, message: string | null) => Promise<void> | void;
  intro: string;
  savingKey?: T | null;
}) {
  const [previewKey, setPreviewKey] = useState<T | null>(null);
  const [editKey, setEditKey] = useState<T | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const previewItem = useMemo(
    () => items.find((item) => item.key === previewKey) ?? null,
    [items, previewKey],
  );
  const editItem = useMemo(() => items.find((item) => item.key === editKey) ?? null, [items, editKey]);

  function effectiveMessage(item: NotificationEventItem<T>) {
    const custom = messages[item.key];
    return (custom ?? item.defaultMessage).trim() || item.defaultMessage;
  }

  function hasCustom(item: NotificationEventItem<T>) {
    const custom = messages[item.key];
    return typeof custom === "string" && custom.trim().length > 0 && custom.trim() !== item.defaultMessage.trim();
  }

  function openEdit(item: NotificationEventItem<T>) {
    setError("");
    setDraft(effectiveMessage(item));
    setEditKey(item.key);
  }

  return (
    <>
      <fieldset className="grid gap-3">
        <legend className="sr-only">{intro}</legend>
        <p className="text-sm text-muted-foreground">{intro}</p>
        {items.map((item) => {
          const enabled = values[item.key];
          const customized = hasCustom(item);
          const channel = item.channel === "sms" ? "SMS" : "Push alert";
          return (
            <div
              key={item.key}
              className={cn(
                "grid gap-2 rounded-lg border px-3 py-2.5 transition-colors duration-fast ease-out",
                enabled
                  ? "border-primary bg-primary/5 shadow-xs"
                  : "border-border hover:border-input hover:bg-surface-muted/50",
              )}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">{item.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{item.detail}</p>
                  <p className="mt-1 text-caption text-muted-foreground">
                    {channel}
                    {customized ? " · custom message" : " · default message"}
                  </p>
                </div>
                <ToggleSwitch
                  enabled={enabled}
                  label={`${enabled ? "Disable" : "Enable"} ${item.label}`}
                  onChange={(next) => onToggle(item.key, next)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <IconAction label={`View ${item.label} message`} onClick={() => setPreviewKey(item.key)}>
                  <Eye className="h-4 w-4" aria-hidden="true" />
                </IconAction>
                {customized ? (
                  <IconAction label={`Edit ${item.label} message`} onClick={() => openEdit(item)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </IconAction>
                ) : (
                  <IconAction label={`Add ${item.label} message`} onClick={() => openEdit(item)}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </IconAction>
                )}
                {savingKey === item.key ? (
                  <span className="text-caption text-muted-foreground">Saving…</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </fieldset>

      <Dialog.Root open={Boolean(previewItem)} onOpenChange={(open) => !open && setPreviewKey(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-lg">
            {previewItem ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Dialog.Title className="text-base font-semibold text-foreground">
                      Message preview
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                      How {previewItem.channel === "sms" ? "the SMS" : "the push alert"} for “{previewItem.label}”
                      will look with sample details filled in.
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                      aria-label="Close preview"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Dialog.Close>
                </div>
                <div className="rounded-xl border border-border bg-surface-muted/40 p-4">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {previewItem.channel === "sms" ? "SMS to client" : "Push / in-app alert"}
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {fillNotificationMessage(effectiveMessage(previewItem))}
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <SecondaryButton type="button" onClick={() => setPreviewKey(null)}>
                    Close
                  </SecondaryButton>
                  <PrimaryButton
                    type="button"
                    onClick={() => {
                      const item = previewItem;
                      setPreviewKey(null);
                      openEdit(item);
                    }}
                  >
                    {hasCustom(previewItem) ? "Edit message" : "Add message"}
                  </PrimaryButton>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(editItem)}
        onOpenChange={(open) => {
          if (!open && !pending) setEditKey(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-lg">
            {editItem ? (
              <>
                <div>
                  <Dialog.Title className="text-base font-semibold text-foreground">
                    {hasCustom(editItem) ? "Edit message" : "Add message"}
                  </Dialog.Title>
                  <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                    Customize the {editItem.channel === "sms" ? "SMS" : "alert"} for “{editItem.label}”. Use
                    placeholders like {"{name}"} — they are replaced when the message is sent.
                  </Dialog.Description>
                </div>
                <FormField
                  id={`notification-message-${editItem.key}`}
                  label="Message"
                  hint={`${draft.length}/640 characters${
                    editItem.placeholders?.length
                      ? ` · ${editItem.placeholders.map((item) => `{${item}}`).join(" ")}`
                      : ""
                  }`}
                >
                  <textarea
                    id={`notification-message-${editItem.key}`}
                    className="field min-h-32 resize-y"
                    maxLength={640}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </FormField>
                <div className="rounded-lg border border-border bg-surface-muted/30 px-3 py-2">
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Live preview
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                    {fillNotificationMessage(draft || editItem.defaultMessage)}
                  </p>
                </div>
                {error ? (
                  <p className="notice" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-between gap-2">
                  <SecondaryButton
                    type="button"
                    disabled={pending}
                    onClick={() => setDraft(editItem.defaultMessage)}
                  >
                    Use default
                  </SecondaryButton>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton type="button" disabled={pending} onClick={() => setEditKey(null)}>
                      Cancel
                    </SecondaryButton>
                    <PrimaryButton
                      type="button"
                      disabled={pending || !draft.trim()}
                      onClick={() => {
                        setPending(true);
                        setError("");
                        const next = draft.trim();
                        const reset = next === editItem.defaultMessage.trim();
                        void Promise.resolve(onSaveMessage(editItem.key, reset ? null : next))
                          .then(() => setEditKey(null))
                          .catch((cause: unknown) => {
                            setError(
                              cause instanceof Error ? cause.message : "The message could not be saved.",
                            );
                          })
                          .finally(() => setPending(false));
                      }}
                    >
                      {pending ? "Saving…" : "Save message"}
                    </PrimaryButton>
                  </div>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
