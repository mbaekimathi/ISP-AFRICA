import * as Dialog from "@radix-ui/react-dialog";
import { UserRound } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { TechnicianMobileNav } from "@/components/staff/TechnicianNav";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";

function generatePassword() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

type RouterOption = { id: string; name: string; tunnelStatus: string };
type PackageOption = { id: string; name: string; price: string; downloadMbps: number; uploadMbps: number };

type Onboarding = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  buildingName: string;
  houseNumber: string;
  routerId: string | null;
  packageId: string | null;
  packageName: string;
  serial: string;
  pppoeUsername: string;
  pppoePassword: string;
  status: string;
  createdAt: string;
};

type Draft = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  buildingName: string;
  houseNumber: string;
  routerId: string;
  packageId: string;
  serial: string;
  pppoeUsername: string;
  pppoePassword: string;
};

type DraftErrors = Partial<Record<keyof Draft | "form", string>>;

const emptyDraft: Draft = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  buildingName: "",
  houseNumber: "",
  routerId: "",
  packageId: "",
  serial: "",
  pppoeUsername: "",
  pppoePassword: "",
};

function validate(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.firstName.trim().length < 2) errors.firstName = "Enter the client's first name.";
  if (draft.lastName.trim().length < 2) errors.lastName = "Enter the client's last name.";
  const digits = draft.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) errors.phone = "Enter a phone number with 10 to 15 digits.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = "Enter a valid email address.";
  if (!draft.routerId) errors.routerId = "Choose the MikroTik router for this client.";
  if (!draft.packageId) errors.packageId = "Choose the client's package.";
  if (draft.pppoeUsername.trim().length < 3) errors.pppoeUsername = "Enter the PPPoE username (at least 3 characters).";
  if (draft.pppoePassword.trim().length < 4) errors.pppoePassword = "Enter the PPPoE password.";
  return errors;
}

export function ClientOnboardPage() {
  usePageMeta("Onboard client — ISP CENTRIC", "Register a new client account for activation.");
  const [allRows, setAllRows] = useState<Onboarding[] | null>(null);
  const rows = allRows?.filter((row) => row.status === "pending_activation") ?? null;
  const [listError, setListError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const [formOpen, setFormOpen] = useState(false);
  const wantsAdd = searchParams.get("add") === "1";
  const dialogOpen = formOpen || wantsAdd;

  function closeForm() {
    setFormOpen(false);
    if (wantsAdd) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft, pppoePassword: generatePassword() });
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [routers, setRouters] = useState<RouterOption[]>([]);
  const [packages, setPackages] = useState<PackageOption[]>([]);
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const digits = draft.phone.replace(/\D/g, "");
    if (!usernameEdited && digits.length >= 3) {
      setDraft((current) => ({ ...current, pppoeUsername: digits }));
    }
  }, [draft.phone, usernameEdited]);

  const selectedPackage = packages.find((item) => item.id === draft.packageId);

  useEffect(() => {
    apiRequest<{ routers: RouterOption[] }>("/api/routers")
      .then((body) => setRouters(body.routers))
      .catch(() => setRouters([]));
  }, []);

  useEffect(() => {
    if (!draft.routerId) {
      setPackages([]);
      return;
    }
    apiRequest<{ packages: PackageOption[] }>(`/api/routers/${draft.routerId}/packages`)
      .then((body) => setPackages(body.packages))
      .catch(() => setPackages([]));
  }, [draft.routerId]);

  useEffect(() => {
    let stopped = false;
    apiRequest<{ onboardings: Onboarding[] }>("/api/client/onboardings")
      .then((body) => {
        if (!stopped) setAllRows(body.onboardings);
      })
      .catch((cause: unknown) => {
        if (!stopped)
          setListError(cause instanceof Error ? cause.message : "The onboarded accounts could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, []);

  function update(field: keyof Draft, value: string) {
    const next =
      field === "email"
        ? value.toLowerCase()
        : field === "firstName" || field === "lastName" || field === "buildingName" || field === "houseNumber"
          ? value.toUpperCase()
          : value;
    setDraft((current) => ({ ...current, [field]: next }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    try {
      const body = await apiRequest<{ onboarding: Onboarding }>("/api/client/onboardings", {
        method: "POST",
        body: JSON.stringify({
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          phone: draft.phone.trim(),
          email: draft.email.trim(),
          buildingName: draft.buildingName.trim(),
          houseNumber: draft.houseNumber.trim(),
          routerId: draft.routerId,
          packageId: draft.packageId,
          packageName: selectedPackage?.name ?? "",
          serial: draft.serial.trim(),
          pppoeUsername: draft.pppoeUsername.trim(),
          pppoePassword: draft.pppoePassword,
        }),
      });
      setAllRows((current) => [body.onboarding, ...(current ?? [])]);
      setDraft({ ...emptyDraft, pppoePassword: generatePassword() });
      setUsernameEdited(false);
      setErrors({});
      closeForm();
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : "The client could not be registered." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-shell py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="New client onboarding"
          description="Register a client's details. Their account stays pending until it is activated."
        />
        <Dialog.Root open={dialogOpen} onOpenChange={(next) => (next ? setFormOpen(true) : closeForm())}>
          <Dialog.Trigger asChild>
            <PrimaryButton type="button" className="lg:hidden">
              Onboard client
            </PrimaryButton>
          </Dialog.Trigger>
          <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content max-w-2xl">
                <div className="flex items-start gap-3.5">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                    aria-hidden="true"
                  >
                    <UserRound className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
                      Register a client
                    </Dialog.Title>
                    <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                      The account is created as pending activation — service starts once it is activated.
                    </Dialog.Description>
                  </div>
                </div>
                <form className="grid gap-5" onSubmit={onSubmit} noValidate>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField id="onb-first" label="First name" error={errors.firstName}>
                      <input
                        id="onb-first"
                        className="field"
                        autoComplete="off"
                        value={draft.firstName}
                        onChange={(event) => update("firstName", event.target.value)}
                      />
                    </FormField>
                    <FormField id="onb-last" label="Last name" error={errors.lastName}>
                      <input
                        id="onb-last"
                        className="field"
                        autoComplete="off"
                        value={draft.lastName}
                        onChange={(event) => update("lastName", event.target.value)}
                      />
                    </FormField>
                    <FormField id="onb-phone" label="Phone number" error={errors.phone}>
                      <input
                        id="onb-phone"
                        className="field"
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        value={draft.phone}
                        onChange={(event) => update("phone", event.target.value)}
                      />
                    </FormField>
                    <FormField id="onb-email" label="Email" error={errors.email}>
                      <input
                        id="onb-email"
                        className="field"
                        type="email"
                        autoComplete="off"
                        value={draft.email}
                        onChange={(event) => update("email", event.target.value)}
                      />
                    </FormField>
                  </div>
                  <div className="border-t border-border/80 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      PPPoE credentials
                    </p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <FormField
                        id="onb-pppoe-user"
                        label="PPPoE username"
                        error={errors.pppoeUsername}
                        hint="Auto-filled from the phone number."
                      >
                        <input
                          id="onb-pppoe-user"
                          className="field"
                          autoComplete="off"
                          value={draft.pppoeUsername}
                          onChange={(event) => {
                            setUsernameEdited(true);
                            update("pppoeUsername", event.target.value);
                          }}
                        />
                      </FormField>
                      <FormField id="onb-pppoe-pass" label="PPPoE password" error={errors.pppoePassword}>
                        <div className="flex flex-wrap gap-2">
                          <input
                            id="onb-pppoe-pass"
                            className="field min-w-0 flex-1"
                            type={showPassword ? "text" : "password"}
                            autoComplete="off"
                            value={draft.pppoePassword}
                            onChange={(event) => update("pppoePassword", event.target.value)}
                          />
                          <SecondaryButton type="button" onClick={() => setShowPassword((c) => !c)}>
                            {showPassword ? "Hide" : "Show"}
                          </SecondaryButton>
                          <SecondaryButton type="button" onClick={() => update("pppoePassword", generatePassword())}>
                            New
                          </SecondaryButton>
                        </div>
                      </FormField>
                    </div>
                  </div>
                  <div className="border-t border-border/80 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Installation details
                    </p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <FormField id="onb-building" label="Building name" hint="Optional">
                        <input
                          id="onb-building"
                          className="field"
                          autoComplete="off"
                          value={draft.buildingName}
                          onChange={(event) => update("buildingName", event.target.value)}
                        />
                      </FormField>
                      <FormField id="onb-house" label="House number" hint="Optional">
                        <input
                          id="onb-house"
                          className="field"
                          autoComplete="off"
                          value={draft.houseNumber}
                          onChange={(event) => update("houseNumber", event.target.value)}
                        />
                      </FormField>
                    </div>
                  </div>
                  <div className="border-t border-border/80 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Service</p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <FormField id="onb-router" label="MikroTik router" error={errors.routerId}>
                        <select
                          id="onb-router"
                          className="field"
                          value={draft.routerId}
                          onChange={(event) => {
                            update("routerId", event.target.value);
                            update("packageId", "");
                          }}
                        >
                          <option value="">Choose a router</option>
                          {routers.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} ({item.tunnelStatus})
                            </option>
                          ))}
                        </select>
                      </FormField>
                      <FormField
                        id="onb-package"
                        label="Package"
                        error={errors.packageId}
                        hint={
                          selectedPackage
                            ? `${selectedPackage.downloadMbps}/${selectedPackage.uploadMbps} Mbps · KSh ${selectedPackage.price}`
                            : "Choose a router first."
                        }
                      >
                        <select
                          id="onb-package"
                          className="field"
                          value={draft.packageId}
                          disabled={!draft.routerId}
                          onChange={(event) => update("packageId", event.target.value)}
                        >
                          <option value="">Choose a package</option>
                          {packages.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {item.downloadMbps}/{item.uploadMbps} Mbps · KSh {item.price}
                            </option>
                          ))}
                        </select>
                      </FormField>
                      <FormField
                        id="onb-serial"
                        label="Router / ONU serial"
                        error={errors.serial}
                        hint="Optional — scan or type the device serial number."
                      >
                        <input
                          id="onb-serial"
                          className="field"
                          autoComplete="off"
                          value={draft.serial}
                          onChange={(event) => update("serial", event.target.value)}
                        />
                      </FormField>
                    </div>
                  </div>
                  {errors.form ? (
                    <p className="text-sm text-destructive" role="alert">
                      {errors.form}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap justify-end gap-2 border-t border-border/80 pt-4">
                    <SecondaryButton type="button" onClick={closeForm} disabled={saving}>
                      Cancel
                    </SecondaryButton>
                    <PrimaryButton type="submit" disabled={saving}>
                      {saving ? "Saving…" : "Register client"}
                    </PrimaryButton>
                  </div>
                </form>
              </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <TechnicianMobileNav />
      {listError ? (
        <p className="mt-4 notice" role="alert">
          {listError}
        </p>
      ) : null}
      {rows === null ? (
        <div className="mt-4 grid gap-3">
          <div className="panel h-20 animate-pulse" />
          <div className="panel h-20 animate-pulse" />
        </div>
      ) : rows.length === 0 ? (
        <div className="panel mt-4 p-6 text-sm text-muted-foreground">
          No accounts pending activation. Register a client to see them here.
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {rows.map((row) => (
            <article key={row.id} className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                aria-hidden="true"
              >
                {`${row.firstName[0] ?? ""}${row.lastName[0] ?? ""}`.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-base font-semibold">
                    {row.firstName} {row.lastName}
                  </p>
                  <StatusBadge tone="due">Pending activation</StatusBadge>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {row.phone} · {row.email}
                </p>
                <p className="truncate text-caption text-muted-foreground">
                  {[row.buildingName, row.houseNumber].filter(Boolean).join(" · ") || "No address"}
                  {row.packageName ? ` · ${row.packageName}` : ""}
                  {row.serial ? ` · SN ${row.serial}` : ""} · Registered {row.createdAt}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
