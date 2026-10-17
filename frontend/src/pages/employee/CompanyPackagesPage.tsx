import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { ClientChoices, routerCountLabel, type PackageClient } from "@/components/packages/ClientChoices";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fileToPackageImage } from "@/lib/accounts";
import { apiRequest } from "@/lib/api";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type ServiceType = "pppoe" | "hotspot";
type BillingModel = "recurring" | "prepaid" | "voucher" | "usage";
type TimeUnit = "hours" | "days" | "weeks" | "months";
type DataUnit = "MB" | "GB";
type FairUseAction = "throttle" | "disconnect";
type PackageStatus = "draft" | "active" | "archived" | "suspended";

type PackageRecord = {
  id: string;
  name: string;
  serviceType: ServiceType;
  price: string;
  billingModel: BillingModel;
  downloadMbps: number;
  uploadMbps: number;
  validityAmount: number;
  validityUnit: TimeUnit;
  dataAllowanceAmount: string | null;
  dataAllowanceUnit: DataUnit | null;
  dataAllowanceAction: FairUseAction | null;
  dataThrottleDownloadMbps: number | null;
  dataThrottleUploadMbps: number | null;
  dataResetAmount: number | null;
  dataResetUnit: TimeUnit | null;
  fairUseAmount: string | null;
  fairUseUnit: DataUnit | null;
  fairUseAction: FairUseAction | null;
  fairThrottleDownloadMbps: number | null;
  fairThrottleUploadMbps: number | null;
  fairResetAmount: number | null;
  fairResetUnit: TimeUnit | null;
  simultaneousDevices: number;
  extraDevicePrice: string | null;
  extraPeriodPrice: string | null;
  graceAmount: number | null;
  graceUnit: TimeUnit | null;
  status: PackageStatus;
  clients: string[];
  appliesToAll: boolean;
  imageDataUrl: string;
};

type Draft = {
  name: string;
  serviceType: "" | ServiceType;
  price: string;
  billingModel: "" | BillingModel;
  downloadMbps: string;
  uploadMbps: string;
  validityAmount: string;
  validityUnit: "" | TimeUnit;
  dataEnabled: boolean;
  dataAllowanceAmount: string;
  dataAllowanceUnit: "" | DataUnit;
  dataAllowanceAction: "" | FairUseAction;
  dataThrottleDownloadMbps: string;
  dataThrottleUploadMbps: string;
  dataResetAmount: string;
  dataResetUnit: "" | TimeUnit;
  fairEnabled: boolean;
  fairUseAmount: string;
  fairUseUnit: "" | DataUnit;
  fairUseAction: "" | FairUseAction;
  fairThrottleDownloadMbps: string;
  fairThrottleUploadMbps: string;
  fairResetAmount: string;
  fairResetUnit: "" | TimeUnit;
  extraDevicePrice: string;
  extraPeriodPrice: string;
  graceAmount: string;
  graceUnit: "" | TimeUnit;
  status: "" | PackageStatus;
  deviceMode: "" | "one" | "multiple";
  devicesUnlimited: boolean;
  devicesLimit: string;
  clients: string[];
  imageDataUrl: string;
};

const emptyDraft: Draft = {
  name: "",
  serviceType: "",
  price: "",
  billingModel: "",
  downloadMbps: "",
  uploadMbps: "",
  validityAmount: "",
  validityUnit: "",
  dataEnabled: false,
  dataAllowanceAmount: "",
  dataAllowanceUnit: "",
  dataAllowanceAction: "",
  dataThrottleDownloadMbps: "",
  dataThrottleUploadMbps: "",
  dataResetAmount: "",
  dataResetUnit: "",
  fairEnabled: false,
  fairUseAmount: "",
  fairUseUnit: "",
  fairUseAction: "",
  fairThrottleDownloadMbps: "",
  fairThrottleUploadMbps: "",
  fairResetAmount: "",
  fairResetUnit: "",
  extraDevicePrice: "",
  extraPeriodPrice: "",
  graceAmount: "",
  graceUnit: "",
  status: "",
  deviceMode: "",
  devicesUnlimited: true,
  devicesLimit: "",
  clients: [],
  imageDataUrl: "",
};

const serviceLabels: Record<ServiceType, string> = {
  pppoe: "PPPoE",
  hotspot: "Hotspot",
};

const billingLabels: Record<BillingModel, string> = {
  recurring: "Recurring",
  prepaid: "Prepaid",
  voucher: "Voucher",
  usage: "Usage-based",
};

const statusLabels: Record<PackageStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
  suspended: "Suspended",
};

function payload(draft: Draft) {
  return {
    name: draft.name.trim(),
    serviceType: draft.serviceType,
    price: draft.price.trim(),
    billingModel: draft.billingModel,
    downloadMbps: Number(draft.downloadMbps),
    uploadMbps: Number(draft.uploadMbps),
    validityAmount: draft.serviceType === "hotspot" && draft.deviceMode === "multiple" ? 1 : Number(draft.validityAmount),
    validityUnit: draft.validityUnit,
    dataAllowanceAmount: draft.dataEnabled ? draft.dataAllowanceAmount.trim() : "",
    dataAllowanceUnit: draft.dataEnabled ? draft.dataAllowanceUnit : "",
    dataAllowanceAction: draft.dataEnabled ? draft.dataAllowanceAction : "",
    dataThrottleDownloadMbps: draft.dataEnabled && draft.dataAllowanceAction === "throttle" ? Number(draft.dataThrottleDownloadMbps) : "",
    dataThrottleUploadMbps: draft.dataEnabled && draft.dataAllowanceAction === "throttle" ? Number(draft.dataThrottleUploadMbps) : "",
    dataResetAmount: draft.dataEnabled ? draft.dataResetAmount.trim() : "",
    dataResetUnit: draft.dataEnabled ? draft.dataResetUnit : "",
    fairUseAmount: draft.fairEnabled ? draft.fairUseAmount.trim() : "",
    fairUseUnit: draft.fairEnabled ? draft.fairUseUnit : "",
    fairUseAction: draft.fairEnabled ? draft.fairUseAction : "",
    fairThrottleDownloadMbps: draft.fairEnabled && draft.fairUseAction === "throttle" ? Number(draft.fairThrottleDownloadMbps) : "",
    fairThrottleUploadMbps: draft.fairEnabled && draft.fairUseAction === "throttle" ? Number(draft.fairThrottleUploadMbps) : "",
    fairResetAmount: draft.fairEnabled ? draft.fairResetAmount.trim() : "",
    fairResetUnit: draft.fairEnabled ? draft.fairResetUnit : "",
    deviceMode: draft.serviceType === "hotspot" ? draft.deviceMode : "",
    simultaneousDevices: draft.serviceType === "pppoe" ? (draft.devicesUnlimited ? 0 : Number(draft.devicesLimit)) : "",
    extraDevicePrice: draft.serviceType === "hotspot" && draft.deviceMode === "multiple" ? draft.extraDevicePrice.trim() : "",
    extraPeriodPrice: draft.serviceType === "hotspot" && draft.deviceMode === "multiple" ? draft.extraPeriodPrice.trim() : "",
    graceAmount: draft.graceAmount.trim(),
    graceUnit: draft.graceUnit,
    status: draft.status,
    clients: draft.clients,
    imageDataUrl: draft.imageDataUrl,
  };
}

function draftFrom(record: PackageRecord): Draft {
  return {
    name: record.name,
    serviceType: record.serviceType,
    price: record.price,
    billingModel: record.billingModel,
    downloadMbps: String(record.downloadMbps),
    uploadMbps: String(record.uploadMbps),
    validityAmount: String(record.validityAmount),
    validityUnit: record.validityUnit,
    dataEnabled: Boolean(record.dataAllowanceAmount),
    dataAllowanceAmount: record.dataAllowanceAmount ?? "",
    dataAllowanceUnit: record.dataAllowanceUnit ?? "",
    dataAllowanceAction: record.dataAllowanceAction ?? "",
    dataThrottleDownloadMbps: record.dataThrottleDownloadMbps == null ? "" : String(record.dataThrottleDownloadMbps),
    dataThrottleUploadMbps: record.dataThrottleUploadMbps == null ? "" : String(record.dataThrottleUploadMbps),
    dataResetAmount: record.dataResetAmount == null ? "" : String(record.dataResetAmount),
    dataResetUnit: record.dataResetUnit ?? "",
    fairEnabled: Boolean(record.fairUseAmount),
    fairUseAmount: record.fairUseAmount ?? "",
    fairUseUnit: record.fairUseUnit ?? "",
    fairUseAction: record.fairUseAction ?? "",
    fairThrottleDownloadMbps: record.fairThrottleDownloadMbps == null ? "" : String(record.fairThrottleDownloadMbps),
    fairThrottleUploadMbps: record.fairThrottleUploadMbps == null ? "" : String(record.fairThrottleUploadMbps),
    fairResetAmount: record.fairResetAmount == null ? "" : String(record.fairResetAmount),
    fairResetUnit: record.fairResetUnit ?? "",
    extraDevicePrice: record.extraDevicePrice ?? "",
    extraPeriodPrice: record.extraPeriodPrice ?? "",
    deviceMode: record.serviceType === "hotspot" ? (record.simultaneousDevices === 1 ? "one" : "multiple") : "",
    devicesUnlimited: record.simultaneousDevices === 0,
    devicesLimit: record.simultaneousDevices > 0 ? String(record.simultaneousDevices) : "",
    graceAmount: record.graceAmount == null ? "" : String(record.graceAmount),
    graceUnit: record.graceUnit ?? "",
    status: record.status,
    clients: record.clients,
    imageDataUrl: record.imageDataUrl,
  };
}

function statusTone(status: PackageStatus) {
  if (status === "active") return "active" as const;
  if (status === "draft") return "due" as const;
  return "paused" as const;
}

function AmountAndUnit({
  amountId,
  unitId,
  label,
  hint,
  amount,
  unit,
  unitOptions,
  emptyUnit,
  required,
  onAmount,
  onUnit,
}: {
  amountId: string;
  unitId: string;
  label: string;
  hint?: string;
  amount: string;
  unit: string;
  unitOptions: { value: string; label: string }[];
  emptyUnit?: string;
  required?: boolean;
  onAmount: (value: string) => void;
  onUnit: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <label htmlFor={amountId} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_9.5rem] gap-2">
        <input
          id={amountId}
          className="field"
          inputMode={required ? "numeric" : "decimal"}
          required={required}
          value={amount}
          onChange={(event) => onAmount(event.target.value)}
        />
        <select
          id={unitId}
          className="field"
          aria-label={`${label} unit`}
          required={required}
          value={unit}
          onChange={(event) => onUnit(event.target.value)}
        >
          {emptyUnit ? <option value="">{emptyUnit}</option> : null}
          {unitOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const timeUnits = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
];

const dataUnits = [
  { value: "MB", label: "MB" },
  { value: "GB", label: "GB" },
];

function LimitTrigger({
  idPrefix,
  label,
  action,
  download,
  upload,
  onAction,
  onDownload,
  onUpload,
}: {
  idPrefix: string;
  label: string;
  action: "" | FairUseAction;
  download: string;
  upload: string;
  onAction: (value: "" | FairUseAction) => void;
  onDownload: (value: string) => void;
  onUpload: (value: string) => void;
}) {
  return (
    <div className="sm:col-span-2 grid gap-3 rounded-xl border border-border p-3">
      <FormField id={`${idPrefix}-action`} label={label}>
        <select
          id={`${idPrefix}-action`}
          className="field"
          required
          value={action}
          onChange={(event) => onAction(event.target.value as "" | FairUseAction)}
        >
          <option value="">Choose what happens</option>
          <option value="throttle">Throttle speeds</option>
          <option value="disconnect">Disconnect the user</option>
        </select>
      </FormField>
      {action === "throttle" ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium text-foreground">Throttle speeds to</p>
          <ThrottleSpeeds
            idPrefix={idPrefix}
            download={download}
            upload={upload}
            onDownload={onDownload}
            onUpload={onUpload}
          />
        </div>
      ) : null}
    </div>
  );
}

function ThrottleSpeeds({
  idPrefix,
  download,
  upload,
  onDownload,
  onUpload,
}: {
  idPrefix: string;
  download: string;
  upload: string;
  onDownload: (value: string) => void;
  onUpload: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <FormField id={`${idPrefix}-download`} label="Download (Mbps)">
        <input
          id={`${idPrefix}-download`}
          className="field"
          inputMode="numeric"
          required
          value={download}
          onChange={(event) => onDownload(event.target.value)}
        />
      </FormField>
      <FormField id={`${idPrefix}-upload`} label="Upload (Mbps)">
        <input
          id={`${idPrefix}-upload`}
          className="field"
          inputMode="numeric"
          required
          value={upload}
          onChange={(event) => onUpload(event.target.value)}
        />
      </FormField>
    </div>
  );
}

function UsageLimit({
  id,
  title,
  description,
  enabled,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-start justify-between gap-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
          <input id={id} type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
          Enable
        </label>
      </div>
      {enabled ? <div className="grid gap-4 border-t border-border bg-muted/40 p-4">{children}</div> : null}
    </section>
  );
}

function PackageFields({
  idPrefix,
  draft,
  clients,
  pending,
  submitLabel,
  extraActions,
  onChange,
}: {
  idPrefix: string;
  draft: Draft;
  clients: PackageClient[];
  pending: boolean;
  submitLabel: string;
  extraActions?: ReactNode;
  onChange: (draft: Draft) => void;
}) {
  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    onChange({ ...draft, [key]: value });
  }

  function chooseService(serviceType: Draft["serviceType"]) {
    onChange({
      ...draft,
      serviceType,
      deviceMode: "",
      extraDevicePrice: "",
      extraPeriodPrice: "",
    });
  }

  function setUsage(kind: "data" | "fair", enabled: boolean) {
    if (kind === "data") {
      onChange({
        ...draft,
        dataEnabled: enabled,
        dataAllowanceAmount: enabled ? draft.dataAllowanceAmount : "",
        dataAllowanceUnit: enabled ? draft.dataAllowanceUnit : "",
        dataAllowanceAction: enabled ? draft.dataAllowanceAction : "",
        dataThrottleDownloadMbps: enabled ? draft.dataThrottleDownloadMbps : "",
        dataThrottleUploadMbps: enabled ? draft.dataThrottleUploadMbps : "",
        dataResetAmount: enabled ? draft.dataResetAmount : "",
        dataResetUnit: enabled ? draft.dataResetUnit : "",
      });
      return;
    }
    onChange({
      ...draft,
      fairEnabled: enabled,
      fairUseAmount: enabled ? draft.fairUseAmount : "",
      fairUseUnit: enabled ? draft.fairUseUnit : "",
      fairUseAction: enabled ? draft.fairUseAction : "",
      fairThrottleDownloadMbps: enabled ? draft.fairThrottleDownloadMbps : "",
      fairThrottleUploadMbps: enabled ? draft.fairThrottleUploadMbps : "",
      fairResetAmount: enabled ? draft.fairResetAmount : "",
      fairResetUnit: enabled ? draft.fairResetUnit : "",
    });
  }

  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-foreground">Service type</legend>
        <p className="text-sm text-muted-foreground">Choose PPPoE or Hotspot. The rest of the form follows that choice.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["pppoe", "PPPoE", "One connection for a router or customer account."],
              ["hotspot", "Hotspot", "A login for one device or several devices."],
            ] as const
          ).map(([value, label, detail]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 ${draft.serviceType === value ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <input
                className="mt-1"
                type="radio"
                name={`${idPrefix}-service`}
                value={value}
                required
                checked={draft.serviceType === value}
                onChange={() => chooseService(value)}
              />
              <span>
                <span className="block text-sm font-semibold">{label}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {draft.serviceType ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
          <FormField id={`${idPrefix}-image`} label="Package image" hint="Shown with this package. JPEG, PNG, or WebP.">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {draft.imageDataUrl ? (
                <img src={draft.imageDataUrl} alt="Package image" className="h-24 w-40 rounded-xl object-cover" />
              ) : (
                <span className="flex h-24 w-40 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                  No image
                </span>
              )}
              <input
                id={`${idPrefix}-image`}
                type="file"
                accept="image/*"
                className="field py-2"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void fileToPackageImage(file)
                    .then((image) => set("imageDataUrl", image))
                    .catch((cause: unknown) => {
                      window.alert(cause instanceof Error ? cause.message : "Could not use that image.");
                    });
                }}
              />
            </div>
          </FormField>
          </div>
        <FormField id={`${idPrefix}-name`} label="Package name" hint="E.g. Home 10 Mbps">
          <input
            id={`${idPrefix}-name`}
            className="field"
            maxLength={80}
            required
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </FormField>
        <FormField id={`${idPrefix}-status`} label="Status">
          <select
            id={`${idPrefix}-status`}
            className="field"
            required
            value={draft.status}
            onChange={(event) => set("status", event.target.value as Draft["status"])}
          >
            <option value="">Choose status</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            {draft.status === "suspended" ? <option value="suspended">Suspended</option> : null}
          </select>
        </FormField>
        {draft.serviceType === "hotspot" ? (
          <div className="sm:col-span-2 grid gap-3">
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-foreground">Devices</legend>
              <p className="text-sm text-muted-foreground">
                One device sells the package at the price above. Multiple devices lets the customer pick how many devices
                and how many periods to buy on the pay page.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name={`${idPrefix}-device-mode`}
                    required
                    checked={draft.deviceMode === "one"}
                    onChange={() => onChange({ ...draft, deviceMode: "one", extraDevicePrice: "", extraPeriodPrice: "" })}
                  />
                  One device
                </label>
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name={`${idPrefix}-device-mode`}
                    required
                    checked={draft.deviceMode === "multiple"}
                    onChange={() => onChange({ ...draft, deviceMode: "multiple" })}
                  />
                  Multiple devices
                </label>
              </div>
            </fieldset>
            {draft.deviceMode === "multiple" ? (
              <div className="grid gap-3 rounded-xl border border-border p-3">
                <p className="text-sm text-muted-foreground">
                  The price above covers 1 device for one period. The customer pays the extra-device charge for every
                  additional device and the extra-period charge for every additional period they choose.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    id={`${idPrefix}-period-unit`}
                    label="Period unit"
                    hint="How long each period lasts. The customer chooses how many periods to buy on the pay page."
                  >
                    <select
                      id={`${idPrefix}-period-unit`}
                      className="field"
                      required
                      value={draft.validityUnit}
                      onChange={(event) => set("validityUnit", event.target.value as Draft["validityUnit"])}
                    >
                      <option value="">Choose a unit</option>
                      <option value="hours">Hour</option>
                      <option value="days">Day</option>
                      <option value="weeks">Week</option>
                      <option value="months">Month</option>
                    </select>
                  </FormField>
                  <FormField
                    id={`${idPrefix}-extra-device`}
                    label="Charge per extra device (KSh)"
                    hint="Added for each device beyond the first."
                  >
                    <input
                      id={`${idPrefix}-extra-device`}
                      className="field"
                      inputMode="decimal"
                      required
                      value={draft.extraDevicePrice}
                      onChange={(event) => set("extraDevicePrice", event.target.value)}
                    />
                  </FormField>
                  <FormField
                    id={`${idPrefix}-extra-period`}
                    label="Charge per extra period (KSh)"
                    hint="Added for each extra validity period the customer buys."
                  >
                    <input
                      id={`${idPrefix}-extra-period`}
                      className="field"
                      inputMode="decimal"
                      required
                      value={draft.extraPeriodPrice}
                      onChange={(event) => set("extraPeriodPrice", event.target.value)}
                    />
                  </FormField>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {draft.serviceType === "pppoe" ? (
          <FormField
            id={`${idPrefix}-devices`}
            label="Devices"
            hint="How many devices may connect at once. Leave it unlimited or set a limit."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <select
                id={`${idPrefix}-devices`}
                className="field"
                value={draft.devicesUnlimited ? "unlimited" : "limited"}
                onChange={(event) => onChange({ ...draft, devicesUnlimited: event.target.value === "unlimited" })}
              >
                <option value="unlimited">Unlimited</option>
                <option value="limited">Set a limit</option>
              </select>
              {!draft.devicesUnlimited ? (
                <input
                  className="field"
                  inputMode="numeric"
                  required
                  placeholder="e.g. 3"
                  value={draft.devicesLimit}
                  onChange={(event) => set("devicesLimit", event.target.value)}
                />
              ) : null}
            </div>
          </FormField>
        ) : null}
        <FormField id={`${idPrefix}-price`} label="Price (KSh)">
          <input
            id={`${idPrefix}-price`}
            className="field"
            inputMode="decimal"
            required
            value={draft.price}
            onChange={(event) => set("price", event.target.value)}
          />
        </FormField>
        <FormField id={`${idPrefix}-billing`} label="Billing model">
          <select
            id={`${idPrefix}-billing`}
            className="field"
            required
            value={draft.billingModel}
            onChange={(event) => set("billingModel", event.target.value as Draft["billingModel"])}
          >
            <option value="">Choose billing model</option>
            <option value="recurring">Recurring</option>
            <option value="prepaid">Prepaid</option>
            <option value="voucher">Voucher</option>
            <option value="usage">Usage-based</option>
          </select>
        </FormField>
        <FormField id={`${idPrefix}-download`} label="Download (Mbps)">
          <input
            id={`${idPrefix}-download`}
            className="field"
            inputMode="numeric"
            required
            value={draft.downloadMbps}
            onChange={(event) => set("downloadMbps", event.target.value)}
          />
        </FormField>
        <FormField id={`${idPrefix}-upload`} label="Upload (Mbps)">
          <input
            id={`${idPrefix}-upload`}
            className="field"
            inputMode="numeric"
            required
            value={draft.uploadMbps}
            onChange={(event) => set("uploadMbps", event.target.value)}
          />
          </FormField>
        {draft.serviceType === "hotspot" && draft.deviceMode === "multiple" ? null : (
          <AmountAndUnit
            amountId={`${idPrefix}-validity-amount`}
            unitId={`${idPrefix}-validity-unit`}
            label="Validity"
            hint="How long the package stays valid."
            amount={draft.validityAmount}
            unit={draft.validityUnit}
            unitOptions={timeUnits}
            emptyUnit="Choose a unit"
            required
            onAmount={(value) => set("validityAmount", value)}
            onUnit={(value) => set("validityUnit", value as Draft["validityUnit"])}
          />
        )}
        <AmountAndUnit
          amountId={`${idPrefix}-grace-amount`}
          unitId={`${idPrefix}-grace-unit`}
          label="Grace period"
          hint="Optional extra time before suspension."
          amount={draft.graceAmount}
          unit={draft.graceUnit}
          unitOptions={timeUnits}
          emptyUnit="No grace period"
          onAmount={(value) => set("graceAmount", value)}
          onUnit={(value) => set("graceUnit", value as Draft["graceUnit"])}
        />
        <div className="grid gap-4 sm:col-span-2">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-foreground">Usage limits</p>
          <p className="text-sm text-muted-foreground">Enable a data allowance, fair use, or both. A limit stays off until you turn it on.</p>
        </div>
        <UsageLimit
          id={`${idPrefix}-data-enabled`}
          title="Data allowance"
          description="Cap how much data the customer can use, then reset that usage."
          enabled={draft.dataEnabled}
          onToggle={(enabled) => setUsage("data", enabled)}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountAndUnit
              amountId={`${idPrefix}-data-amount`}
              unitId={`${idPrefix}-data-unit`}
              label="Allowance"
              amount={draft.dataAllowanceAmount}
              unit={draft.dataAllowanceUnit}
              unitOptions={dataUnits}
              emptyUnit="Choose a unit"
              required
              onAmount={(value) => set("dataAllowanceAmount", value)}
              onUnit={(value) => set("dataAllowanceUnit", value as Draft["dataAllowanceUnit"])}
            />
            <AmountAndUnit
              amountId={`${idPrefix}-data-reset-amount`}
              unitId={`${idPrefix}-data-reset-unit`}
              label="Resets after"
              amount={draft.dataResetAmount}
              unit={draft.dataResetUnit}
              unitOptions={timeUnits}
              emptyUnit="Choose a unit"
              required
              onAmount={(value) => set("dataResetAmount", value)}
              onUnit={(value) => set("dataResetUnit", value as Draft["dataResetUnit"])}
            />
          </div>
          <LimitTrigger
            idPrefix={`${idPrefix}-data`}
            label="When the user hits the data allowance"
            action={draft.dataAllowanceAction}
            download={draft.dataThrottleDownloadMbps}
            upload={draft.dataThrottleUploadMbps}
            onAction={(value) => set("dataAllowanceAction", value)}
            onDownload={(value) => set("dataThrottleDownloadMbps", value)}
            onUpload={(value) => set("dataThrottleUploadMbps", value)}
          />
        </UsageLimit>
        <UsageLimit
          id={`${idPrefix}-fair-enabled`}
          title="Fair use"
          description="Set a usage threshold, then reset that threshold on its own period."
          enabled={draft.fairEnabled}
          onToggle={(enabled) => setUsage("fair", enabled)}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountAndUnit
              amountId={`${idPrefix}-fair-amount`}
              unitId={`${idPrefix}-fair-unit`}
              label="Threshold"
              amount={draft.fairUseAmount}
              unit={draft.fairUseUnit}
              unitOptions={dataUnits}
              emptyUnit="Choose a unit"
              required
              onAmount={(value) => set("fairUseAmount", value)}
              onUnit={(value) => set("fairUseUnit", value as Draft["fairUseUnit"])}
            />
            <AmountAndUnit
              amountId={`${idPrefix}-fair-reset-amount`}
              unitId={`${idPrefix}-fair-reset-unit`}
              label="Resets after"
              amount={draft.fairResetAmount}
              unit={draft.fairResetUnit}
              unitOptions={timeUnits}
              emptyUnit="Choose a unit"
              required
              onAmount={(value) => set("fairResetAmount", value)}
              onUnit={(value) => set("fairResetUnit", value as Draft["fairResetUnit"])}
            />
          </div>
          <LimitTrigger
            idPrefix={`${idPrefix}-fair`}
            label="When the user hits the fair-use threshold"
            action={draft.fairUseAction}
            download={draft.fairThrottleDownloadMbps}
            upload={draft.fairThrottleUploadMbps}
            onAction={(value) => set("fairUseAction", value)}
            onDownload={(value) => set("fairThrottleDownloadMbps", value)}
            onUpload={(value) => set("fairThrottleUploadMbps", value)}
          />
        </UsageLimit>
        </div>
        <ClientChoices
          idPrefix={idPrefix}
          clients={clients}
          selected={draft.clients}
          onChange={(next) => set("clients", next)}
        />
      <div className="grid grid-cols-2 gap-2 sm:col-span-2 sm:flex sm:flex-wrap">
        <PrimaryButton type="submit" disabled={pending}>
          {submitLabel}
        </PrimaryButton>
        {extraActions}
      </div>
        </div>
      ) : null}
    </div>
  );
}

function periodLabel(amount: number | null, unit: TimeUnit | null) {
  if (!amount || !unit) return "";
  const name = amount === 1 ? unit.replace(/s$/, "") : unit;
  return `${amount} ${name}`;
}

function deviceLabel(item: PackageRecord) {
  if (item.serviceType !== "hotspot") return item.simultaneousDevices === 0 ? "Unlimited" : String(item.simultaneousDevices);
  if (item.simultaneousDevices === 0) {
    return `Customer chooses · +KSh ${item.extraDevicePrice ?? "0"} per extra device · +KSh ${item.extraPeriodPrice ?? "0"} per extra period`;
  }
  return item.simultaneousDevices > 1 ? `Up to ${item.simultaneousDevices}` : "1";
}

function packageDetails(item: PackageRecord, clients: PackageClient[]) {
  const chosen = item.appliesToAll ? clients : clients.filter((client) => item.clients.includes(client.id));
  const availability = chosen.length
    ? chosen.map((client) => `${client.name} (${routerCountLabel(client.routerCount)})`).join(", ")
    : "All approved ISP clients";
  const dataAction = !item.dataAllowanceAmount
    ? "No limit"
    : item.dataAllowanceAction === "disconnect"
      ? `Disconnect after ${item.dataAllowanceAmount} ${item.dataAllowanceUnit}`
      : `Throttle to ${item.dataThrottleDownloadMbps}/${item.dataThrottleUploadMbps} Mbps after ${item.dataAllowanceAmount} ${item.dataAllowanceUnit}`;
  const fairAction = !item.fairUseAmount
    ? "No threshold"
    : item.fairUseAction === "disconnect"
      ? `Disconnect after ${item.fairUseAmount} ${item.fairUseUnit}`
      : `Throttle to ${item.fairThrottleDownloadMbps}/${item.fairThrottleUploadMbps} Mbps after ${item.fairUseAmount} ${item.fairUseUnit}`;
  return [
    { label: "Price", value: `KSh ${item.price}` },
    { label: "Service", value: serviceLabels[item.serviceType] },
    { label: "Billing", value: billingLabels[item.billingModel] },
    { label: "Speed", value: `${item.downloadMbps} / ${item.uploadMbps} Mbps` },
    { label: "Validity", value: item.serviceType === "hotspot" && item.simultaneousDevices === 0 ? `Each period = ${periodLabel(item.validityAmount, item.validityUnit)}` : `${item.validityAmount} ${item.validityUnit}` },
    { label: "Grace", value: item.graceAmount ? periodLabel(item.graceAmount, item.graceUnit) : "None" },
    { label: "Devices", value: deviceLabel(item) },
    { label: "Data", value: item.dataResetAmount ? `${dataAction}. Resets after ${periodLabel(item.dataResetAmount, item.dataResetUnit)}` : dataAction },
    { label: "Fair use", value: item.fairResetAmount ? `${fairAction}. Resets after ${periodLabel(item.fairResetAmount, item.fairResetUnit)}` : fairAction },
    { label: "Clients", value: availability },
  ];
}

export function CompanyPackagesPage() {
  const { employee, ready } = useEmployeeAuth();
  usePageMeta("COMPANY PACKAGES — ISP CENTRIC", "Register, edit, suspend, unsuspend, and delete company packages.");
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [clients, setClients] = useState<PackageClient[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const body = await apiRequest<{ packages: PackageRecord[]; clients: PackageClient[] }>("/api/employee/company/packages");
    setPackages(body.packages);
    setClients(body.clients);
    setDraft((current) => (current.clients.length ? current : { ...current, clients: body.clients.map((client) => client.id) }));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!employee || employee.status !== "approved") return;
    let stopped = false;
    load()
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Company packages could not be loaded.");
      })
      .finally(() => {
        if (!stopped) setLoaded(true);
      });
    return () => {
      stopped = true;
    };
  }, [employee, load]);

  async function run(task: () => Promise<void>) {
    setError("");
    setPending(true);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That company package change could not be saved.");
    } finally {
      setPending(false);
    }
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
      <PageHeader
        title="Company packages"
        description="Register a company package. It is added to every selected ISP account as a default package."
      />
      {error ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <form
        id="register-package"
        className="section-anchor mt-6 grid gap-5 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await apiRequest("/api/employee/company/packages", { method: "POST", body: JSON.stringify(payload(draft)) });
            setDraft({ ...emptyDraft, clients: clients.map((client) => client.id) });
            await load();
          });
        }}
      >
        <div>
          <h2 className="text-lg font-semibold">Register a package</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Add a company package. It is copied to each selected ISP account as a default.</p>
        </div>
        <PackageFields
          idPrefix="company-package"
          draft={draft}
          clients={clients}
          pending={pending}
          submitLabel="Register package"
          onChange={setDraft}
        />
      </form>
      <div id="registered-packages" className="section-anchor mt-8 grid gap-3">
        <div>
          <h2 className="text-lg font-semibold">Registered company packages</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Packages already registered as defaults for ISP accounts.</p>
        </div>
        {loaded && packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No company packages are registered yet.</p>
        ) : null}
        {packages.map((item) => {
          const editing = editingId === item.id;
          return (
            <article key={item.id} className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
              {editing ? (
                <form
                  className="grid gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await apiRequest(`/api/employee/company/packages/${item.id}/edit`, {
                        method: "POST",
                        body: JSON.stringify(payload(editDraft)),
                      });
                      setEditingId(null);
                      await load();
                    });
                  }}
                >
                  <PackageFields
                    idPrefix={`company-edit-${item.id}`}
                    draft={editDraft}
                    clients={clients}
                    pending={pending}
                    submitLabel="Save package"
                    extraActions={
                      <SecondaryButton type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </SecondaryButton>
                    }
                    onChange={setEditDraft}
                  />
                </form>
              ) : (
                <div className="grid gap-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      {item.imageDataUrl ? (
                        <img src={item.imageDataUrl} alt="" className="h-14 w-24 shrink-0 rounded-lg object-cover" />
                      ) : null}
                      <div className="min-w-0">
                        <h3 className="break-words font-semibold">{item.name}</h3>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <StatusBadge tone={statusTone(item.status)}>{statusLabels[item.status]}</StatusBadge>
                        </div>
                      </div>
                    </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <SecondaryButton
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setConfirmingId(null);
                        setEditingId(item.id);
                        setEditDraft({
                          ...draftFrom(item),
                          clients: item.clients.length ? item.clients : clients.map((client) => client.id),
                        });
                      }}
                    >
                      Edit
                    </SecondaryButton>
                    {item.status === "active" || item.status === "suspended" ? (
                      <SecondaryButton
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            const action = item.status === "active" ? "suspend" : "unsuspend";
                            await apiRequest(`/api/employee/company/packages/${item.id}/${action}`, {
                              method: "POST",
                              body: "{}",
                            });
                            setConfirmingId(null);
                            await load();
                          })
                        }
                      >
                        {item.status === "active" ? "Suspend" : "Unsuspend"}
                      </SecondaryButton>
                    ) : null}
                    {confirmingId === item.id ? (
                      <SecondaryButton
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            await apiRequest(`/api/employee/company/packages/${item.id}/delete`, {
                              method: "POST",
                              body: "{}",
                            });
                            setConfirmingId(null);
                            if (editingId === item.id) setEditingId(null);
                            await load();
                          })
                        }
                      >
                        Confirm delete
                      </SecondaryButton>
                    ) : (
                      <SecondaryButton type="button" disabled={pending} onClick={() => setConfirmingId(item.id)}>
                        Delete
                      </SecondaryButton>
                    )}
                  </div>
                  </div>
                  <DetailGrid items={packageDetails(item, clients)} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
