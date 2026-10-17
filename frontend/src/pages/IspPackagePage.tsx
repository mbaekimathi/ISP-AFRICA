import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { RouterChoices, routerLabel, type PackageRouter } from "@/components/packages/RouterChoices";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { fileToPackageImage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

type PackageStatus = "active" | "suspended";

type PackageRecord = {
  id: string;
  name: string;
  price: string;
  downloadMbps: number;
  uploadMbps: number;
  status: PackageStatus;
  serviceType: "pppoe" | "hotspot";
  validityAmount: number;
  validityUnit: string;
  simultaneousDevices: number;
  routers: string[];
  defaultPackage: boolean;
  imageDataUrl: string;
};

type Draft = {
  name: string;
  price: string;
  downloadMbps: string;
  uploadMbps: string;
  routers: string[];
  imageDataUrl: string;
  serviceType: "pppoe" | "hotspot";
  validityAmount: string;
  validityUnit: string;
  deviceMode: "one" | "multiple";
  simultaneousDevices: string;
};

const emptyDraft: Draft = {
  name: "",
  price: "",
  downloadMbps: "",
  uploadMbps: "",
  routers: [],
  imageDataUrl: "",
  serviceType: "pppoe",
  validityAmount: "",
  validityUnit: "days",
  deviceMode: "one",
  simultaneousDevices: "",
};

const timeUnits = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
];

function validityText(record: PackageRecord) {
  const unit = record.validityAmount === 1 && record.validityUnit.endsWith("s") ? record.validityUnit.slice(0, -1) : record.validityUnit;
  return `${record.validityAmount} ${unit}`;
}

function payload(draft: Draft) {
  return {
    name: draft.name.trim(),
    price: draft.price.trim(),
    downloadMbps: Number(draft.downloadMbps),
    uploadMbps: Number(draft.uploadMbps),
    routers: draft.routers,
    imageDataUrl: draft.imageDataUrl,
    serviceType: draft.serviceType,
    validityAmount: Number(draft.validityAmount),
    validityUnit: draft.validityUnit,
    deviceMode: draft.deviceMode,
    simultaneousDevices: Number(draft.simultaneousDevices),
  };
}

function draftFrom(record: PackageRecord): Draft {
  return {
    name: record.name,
    price: record.price,
    downloadMbps: String(record.downloadMbps),
    uploadMbps: String(record.uploadMbps),
    routers: record.routers,
    imageDataUrl: record.imageDataUrl || "",
    serviceType: record.serviceType === "hotspot" ? "hotspot" : "pppoe",
    validityAmount: String(record.validityAmount || ""),
    validityUnit: record.validityUnit || "days",
    deviceMode: record.simultaneousDevices > 1 ? "multiple" : "one",
    simultaneousDevices: record.simultaneousDevices > 1 ? String(record.simultaneousDevices) : "",
  };
}

function ServiceFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (update: Partial<Draft>) => void;
}) {
  return (
    <>
      <FormField id={`${idPrefix}-service`} label="Service type" hint="Hotspot packages are sold on the Wi-Fi payment page.">
        <select
          id={`${idPrefix}-service`}
          className="field"
          value={draft.serviceType}
          onChange={(event) => onChange({ serviceType: event.target.value as Draft["serviceType"] })}
        >
          <option value="pppoe">PPPoE</option>
          <option value="hotspot">Hotspot</option>
        </select>
      </FormField>
      {draft.serviceType === "hotspot" ? (
        <>
          <FormField id={`${idPrefix}-validity`} label="Bundle lasts">
            <div className="grid grid-cols-[minmax(0,1fr)_9.5rem] gap-2">
              <input
                id={`${idPrefix}-validity`}
                className="field"
                inputMode="numeric"
                value={draft.validityAmount}
                onChange={(event) => onChange({ validityAmount: event.target.value })}
              />
              <select
                className="field"
                aria-label="Bundle lasts unit"
                value={draft.validityUnit}
                onChange={(event) => onChange({ validityUnit: event.target.value })}
              >
                {timeUnits.map((unit) => (
                  <option key={unit.value} value={unit.value}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </div>
          </FormField>
          <FormField id={`${idPrefix}-devices`} label="Devices per bundle">
            <select
              id={`${idPrefix}-devices`}
              className="field"
              value={draft.deviceMode}
              onChange={(event) => onChange({ deviceMode: event.target.value as Draft["deviceMode"] })}
            >
              <option value="one">One device</option>
              <option value="multiple">Several devices</option>
            </select>
          </FormField>
          {draft.deviceMode === "multiple" ? (
            <FormField id={`${idPrefix}-device-count`} label="How many devices">
              <input
                id={`${idPrefix}-device-count`}
                className="field"
                inputMode="numeric"
                value={draft.simultaneousDevices}
                onChange={(event) => onChange({ simultaneousDevices: event.target.value })}
              />
            </FormField>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function PackageImageField({ id, value, onChange }: { id: string; value: string; onChange: (image: string) => void }) {
  return (
    <FormField id={id} label="Package image" hint="Shown when a customer pays. JPEG, PNG, or WebP.">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        {value ? (
          <img src={value} alt="Package image" className="h-24 w-40 rounded-xl object-cover" />
        ) : (
          <span className="flex h-24 w-40 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
            No image
          </span>
        )}
        <input
          id={id}
          type="file"
          accept="image/*"
          className="field py-2"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void fileToPackageImage(file)
              .then(onChange)
              .catch((cause: unknown) => {
                window.alert(cause instanceof Error ? cause.message : "Could not use that image.");
              });
          }}
        />
      </div>
    </FormField>
  );
}

export function IspPackagePage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP PACKAGE SETTINGS — ISP CENTRIC", "Register, edit, suspend, unsuspend, and delete internet packages.");
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [routers, setRouters] = useState<PackageRouter[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const location = useLocation();

  const load = useCallback(async () => {
    const body = await apiRequest<{ packages: PackageRecord[]; routers: PackageRouter[] }>("/api/packages");
    setPackages(body.packages);
    setRouters(body.routers);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    let stopped = false;
    load()
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Packages could not be loaded.");
      })
      .finally(() => {
        if (!stopped) setLoaded(true);
      });
    return () => {
      stopped = true;
    };
  }, [load, user]);

  useEffect(() => {
    if (!loaded || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [loaded, location.hash]);

  async function run(task: () => Promise<void>) {
    setError("");
    setPending(true);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That package change could not be saved.");
    } finally {
      setPending(false);
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
    <div className="page-shell py-10">
      <PageHeader
        title="Packages"
        description="Company packages appear here as defaults. Edit a default for this account, or register a package of your own."
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
            await apiRequest("/api/packages", { method: "POST", body: JSON.stringify(payload(draft)) });
            setDraft(emptyDraft);
            await load();
          });
        }}
      >
        <div>
          <h2 className="text-lg font-semibold">Register a package</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Add a package for this account. It stays separate from the company defaults.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <PackageImageField id="package-image" value={draft.imageDataUrl} onChange={(image) => setDraft((current) => ({ ...current, imageDataUrl: image }))} />
          </div>
          <FormField id="package-name" label="Package name">
            <input
              id="package-name"
              className="field"
              maxLength={80}
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </FormField>
          <FormField id="package-price" label="Monthly price">
            <input
              id="package-price"
              className="field"
              inputMode="decimal"
              value={draft.price}
              onChange={(event) => setDraft((current) => ({ ...current, price: event.target.value }))}
            />
          </FormField>
          <FormField id="package-download" label="Download Mbps">
            <input
              id="package-download"
              className="field"
              inputMode="numeric"
              value={draft.downloadMbps}
              onChange={(event) => setDraft((current) => ({ ...current, downloadMbps: event.target.value }))}
            />
          </FormField>
          <FormField id="package-upload" label="Upload Mbps">
            <input
              id="package-upload"
              className="field"
              inputMode="numeric"
              value={draft.uploadMbps}
              onChange={(event) => setDraft((current) => ({ ...current, uploadMbps: event.target.value }))}
            />
          </FormField>
          <ServiceFields idPrefix="package" draft={draft} onChange={(update) => setDraft((current) => ({ ...current, ...update }))} />
          <div className="sm:col-span-2">
            <RouterChoices
              idPrefix="package"
              routers={routers}
              selected={draft.routers}
              showClient={false}
              hint="Routers linked to your account, grouped by site."
              onChange={(next) => setDraft((current) => ({ ...current, routers: next }))}
            />
          </div>
        </div>
        <div>
          <PrimaryButton type="submit" disabled={pending}>
            Register package
          </PrimaryButton>
        </div>
      </form>
      <div id="registered-packages" className="section-anchor mt-8 grid gap-3">
        <div>
          <h2 className="text-lg font-semibold">Registered packages</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Defaults from the company are marked so you can edit them for this account.</p>
        </div>
        {loaded && packages.length === 0 ? <p className="text-sm text-muted-foreground">No packages are registered yet.</p> : null}
        {packages.map((item) => {
          const editing = editingId === item.id;
          return (
            <article key={item.id} className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
              {editing ? (
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await apiRequest(`/api/packages/${item.id}/edit`, {
                        method: "POST",
                        body: JSON.stringify(payload(editDraft)),
                      });
                      setEditingId(null);
                      await load();
                    });
                  }}
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <PackageImageField
                        id={`edit-image-${item.id}`}
                        value={editDraft.imageDataUrl}
                        onChange={(image) => setEditDraft((current) => ({ ...current, imageDataUrl: image }))}
                      />
                    </div>
                    <FormField id={`edit-name-${item.id}`} label="Package name">
                      <input
                        id={`edit-name-${item.id}`}
                        className="field"
                        maxLength={80}
                        value={editDraft.name}
                        onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))}
                      />
                    </FormField>
                    <FormField id={`edit-price-${item.id}`} label="Monthly price">
                      <input
                        id={`edit-price-${item.id}`}
                        className="field"
                        inputMode="decimal"
                        value={editDraft.price}
                        onChange={(event) => setEditDraft((current) => ({ ...current, price: event.target.value }))}
                      />
                    </FormField>
                    <FormField id={`edit-download-${item.id}`} label="Download Mbps">
                      <input
                        id={`edit-download-${item.id}`}
                        className="field"
                        inputMode="numeric"
                        value={editDraft.downloadMbps}
                        onChange={(event) => setEditDraft((current) => ({ ...current, downloadMbps: event.target.value }))}
                      />
                    </FormField>
                    <FormField id={`edit-upload-${item.id}`} label="Upload Mbps">
                      <input
                        id={`edit-upload-${item.id}`}
                        className="field"
                        inputMode="numeric"
                        value={editDraft.uploadMbps}
                        onChange={(event) => setEditDraft((current) => ({ ...current, uploadMbps: event.target.value }))}
                      />
                    </FormField>
                    <ServiceFields
                      idPrefix={`edit-${item.id}`}
                      draft={editDraft}
                      onChange={(update) => setEditDraft((current) => ({ ...current, ...update }))}
                    />
                    <div className="sm:col-span-2">
                      <RouterChoices
                        idPrefix={`edit-${item.id}`}
                        routers={routers}
                        selected={editDraft.routers}
                        showClient={false}
                        hint="Routers linked to your account, grouped by site."
                        onChange={(next) => setEditDraft((current) => ({ ...current, routers: next }))}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <PrimaryButton type="submit" disabled={pending}>
                      Save package
                    </PrimaryButton>
                    <SecondaryButton type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </SecondaryButton>
                  </div>
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
                          <StatusBadge tone={item.status === "active" ? "active" : "paused"}>
                            {item.status === "active" ? "Active" : "Suspended"}
                          </StatusBadge>
                          <StatusBadge tone="neutral">{item.serviceType === "hotspot" ? "Hotspot" : "PPPoE"}</StatusBadge>
                          {item.defaultPackage ? <StatusBadge tone="due">Default</StatusBadge> : null}
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
                        setEditDraft(draftFrom(item));
                      }}
                    >
                      Edit
                    </SecondaryButton>
                    <SecondaryButton
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          const action = item.status === "active" ? "suspend" : "unsuspend";
                          await apiRequest(`/api/packages/${item.id}/${action}`, { method: "POST", body: "{}" });
                          setConfirmingId(null);
                          await load();
                        })
                      }
                    >
                      {item.status === "active" ? "Suspend" : "Unsuspend"}
                    </SecondaryButton>
                    {confirmingId === item.id ? (
                      <SecondaryButton
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            await apiRequest(`/api/packages/${item.id}/delete`, { method: "POST", body: "{}" });
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
                  <DetailGrid
                    items={[
                      {
                        label: "Price",
                        value: item.serviceType === "hotspot" ? `${item.price} / ${validityText(item)}` : `${item.price} monthly`,
                      },
                      { label: "Download", value: `${item.downloadMbps} Mbps` },
                      { label: "Upload", value: `${item.uploadMbps} Mbps` },
                      ...(item.serviceType === "hotspot"
                        ? [{ label: "Devices", value: item.simultaneousDevices > 1 ? `${item.simultaneousDevices} devices` : "One device" }]
                        : []),
                      {
                        label: "Routers",
                        value: item.routers.length
                          ? item.routers
                              .map((id) => {
                                const router = routers.find((candidate) => candidate.id === id);
                                return router ? routerLabel(router, false) : "Removed router";
                              })
                              .join(", ")
                          : "None",
                      },
                    ]}
                  />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
