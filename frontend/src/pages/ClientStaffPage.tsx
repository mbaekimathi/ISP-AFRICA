import * as Dialog from "@radix-ui/react-dialog";
import { UserRound } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage, fileToProfilePhoto } from "@/lib/accounts";
import {
  approveClientStaff,
  changeClientStaff,
  clientStaffRoleLabel,
  clientStaffRoles,
  createClientStaff,
  listClientStaff,
  removeClientStaff,
  updateClientStaff,
  type ClientStaff,
  type ClientStaffRole,
} from "@/lib/clientStaff";
import { useAuth } from "@/providers/AuthProvider";

const codePattern = /^\d{6}$/;

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  loginCode: string;
  password: string;
  confirmPassword: string;
};

type DraftErrors = Partial<Record<keyof Draft | "photo" | "form", string>>;

const emptyDraft: Draft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  loginCode: "",
  password: "",
  confirmPassword: "",
};

function validate(draft: Draft, isEdit: boolean): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.firstName.trim().length < 2) errors.firstName = "Enter the employee's first name.";
  if (draft.lastName.trim().length < 2) errors.lastName = "Enter the employee's last name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = "Enter a valid email address.";
  const digits = draft.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) errors.phone = "Enter a phone number with 10 to 15 digits.";
  if (!codePattern.test(draft.loginCode)) errors.loginCode = "Enter a 6-digit login code.";
  if (!isEdit || draft.password || draft.confirmPassword) {
    if (!codePattern.test(draft.password)) errors.password = "Use a 6-digit password.";
    if (draft.confirmPassword !== draft.password) errors.confirmPassword = "Passwords do not match.";
  }
  return errors;
}

function initials(draft: Pick<Draft, "firstName" | "lastName">) {
  const first = draft.firstName.trim()[0] ?? "";
  const last = draft.lastName.trim()[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

export function ClientStaffPage({ view }: { view: "all" | "pending" }) {
  usePageMeta("HR — ISP CENTRIC", "Manage the employees who sign in to this ISP client account.");
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [staff, setStaff] = useState<ClientStaff[] | null>(null);
  const [listError, setListError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClientStaff | null>(null);
  const wantsAdd = searchParams.get("add") === "1";
  const dialogOpen = formOpen || wantsAdd || editing !== null;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [photo, setPhoto] = useState("");
  const [errors, setErrors] = useState<DraftErrors>({});
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rolePicks, setRolePicks] = useState<Record<string, ClientStaffRole | "">>({});

  const isDelegate = Boolean(user?.delegate);
  const pendingCount = staff?.filter((member) => member.status === "pending").length ?? 0;
  const visible = view === "pending" ? staff?.filter((member) => member.status === "pending") : staff;

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    if (wantsAdd) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }

  function openAdd() {
    setEditing(null);
    setDraft(emptyDraft);
    setPhoto("");
    setErrors({});
    setFormOpen(true);
  }

  function openEdit(member: ClientStaff) {
    setFormOpen(false);
    setDraft({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone,
      loginCode: member.loginCode,
      password: "",
      confirmPassword: "",
    });
    setPhoto(member.photoDataUrl.startsWith("data:image/jpeg") ? member.photoDataUrl : "");
    setErrors({});
    setEditing(member);
  }

  useEffect(() => {
    if (isDelegate) return;
    let stopped = false;
    listClientStaff()
      .then((rows) => {
        if (!stopped) setStaff(rows);
      })
      .catch((cause: unknown) => {
        if (!stopped) setListError(cause instanceof Error ? cause.message : "The staff list could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate]);

  function update(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await fileToProfilePhoto(file);
      setPhoto(dataUrl);
      setErrors((current) => ({ ...current, photo: undefined }));
    } catch (cause) {
      setPhoto("");
      setErrors((current) => ({
        ...current,
        photo: cause instanceof Error ? cause.message : "Could not use that photo.",
      }));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(draft, Boolean(editing));
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      const input = {
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        email: draft.email.trim(),
        phone: draft.phone.trim(),
        loginCode: draft.loginCode,
        password: draft.password,
        photoDataUrl: photo,
      };
      if (editing) {
        applyUpdate(await updateClientStaff(editing.id, input));
      } else {
        const created = await createClientStaff(input);
        setStaff((current) =>
          [...(current ?? []), created].sort((a, b) =>
            `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
          ),
        );
      }
      setDraft(emptyDraft);
      setPhoto("");
      closeForm();
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : "The employee could not be saved." });
    } finally {
      setPending(false);
    }
  }

  function applyUpdate(updated: ClientStaff) {
    setStaff((current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current);
  }

  async function approve(member: ClientStaff) {
    const role = rolePicks[member.id];
    if (!role) return;
    setListError("");
    setBusyId(member.id);
    try {
      applyUpdate(await approveClientStaff(member.id, role));
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "The employee could not be activated.");
    } finally {
      setBusyId(null);
    }
  }

  async function setSuspended(member: ClientStaff, suspended: boolean) {
    setListError("");
    setBusyId(member.id);
    try {
      applyUpdate(await changeClientStaff(member.id, suspended ? "suspend" : "unsuspend"));
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "The employee status could not be changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: ClientStaff) {
    setListError("");
    setBusyId(member.id);
    try {
      await removeClientStaff(member.id);
      setConfirmingId(null);
      setStaff((current) => current?.filter((row) => row.id !== member.id) ?? current);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "The employee could not be removed.");
    } finally {
      setBusyId(null);
    }
  }

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="HR" />
        <p className="notice">Only the account owner can manage employees.</p>
      </div>
    );
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="HR" description="Employees who sign in to this ISP client account." />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-2" aria-label="Staff views">
          <SecondaryButton to={user ? clientPage(user, "/hr") : "/hr"} aria-current={view === "all" ? "page" : undefined}>
            All employees{staff ? ` (${staff.length})` : ""}
          </SecondaryButton>
          <SecondaryButton
            to={user ? clientPage(user, "/hr/pending") : "/hr/pending"}
            aria-current={view === "pending" ? "page" : undefined}
          >
            Pending approvals{staff ? ` (${pendingCount})` : ""}
          </SecondaryButton>
        </nav>
        <PrimaryButton type="button" onClick={openAdd}>
          Add employee
        </PrimaryButton>
      </div>
      {listError ? (
        <p className="notice mt-4" role="alert">
          {listError}
        </p>
      ) : null}
      <ul className="panel mt-4 divide-y divide-border overflow-hidden">
        {!staff && !listError ? (
          <li className="px-4 py-6" aria-hidden="true">
            <div className="grid gap-3">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton h-4 w-1/4" />
            </div>
          </li>
        ) : null}
        {visible?.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">
            {view === "pending" ? "No employees are waiting for approval." : "No employees are saved yet."}
          </li>
        ) : null}
        {visible?.map((member) => {
          const memberPending = member.status === "pending";
          const suspended = member.status === "suspended";
          const busy = busyId === member.id;
          return (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-fast ease-out hover:bg-surface-muted/50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <img
                  src={member.photoDataUrl}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-full border border-border object-cover"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">
                      {member.firstName} {member.lastName}
                    </p>
                    {memberPending ? <StatusBadge tone="pending">Pending approval</StatusBadge> : null}
                    {suspended ? <StatusBadge tone="suspended">Suspended</StatusBadge> : null}
                    {member.role ? <StatusBadge tone="neutral">{clientStaffRoleLabel(member.role)}</StatusBadge> : null}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {member.title ? `${member.title} · ` : ""}
                    {member.email} · {member.phone}
                  </p>
                  <p className="mt-0.5 text-caption text-muted-foreground">Login code {member.loginCode}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {memberPending ? (
                  <>
                    <select
                      className="field min-h-10 w-auto text-sm"
                      aria-label={`Role for ${member.firstName} ${member.lastName}`}
                      value={rolePicks[member.id] ?? ""}
                      onChange={(event) =>
                        setRolePicks((current) => ({
                          ...current,
                          [member.id]: event.target.value as ClientStaffRole | "",
                        }))
                      }
                    >
                      <option value="" disabled>
                        Choose role
                      </option>
                      {clientStaffRoles.map((role) => (
                        <option key={role.value} value={role.value}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                    <PrimaryButton type="button" disabled={busy || !rolePicks[member.id]} onClick={() => void approve(member)}>
                      {busy ? "Activating…" : "Activate"}
                    </PrimaryButton>
                  </>
                ) : (
                  <>
                    <SecondaryButton type="button" disabled={busy} onClick={() => openEdit(member)}>
                      Edit
                    </SecondaryButton>
                    <SecondaryButton type="button" disabled={busy} onClick={() => void setSuspended(member, !suspended)}>
                      {busy ? "Saving…" : suspended ? "Reactivate" : "Suspend"}
                    </SecondaryButton>
                  </>
                )}
                {confirmingId === member.id ? (
                  <SecondaryButton type="button" disabled={busy} onClick={() => void remove(member)}>
                    {busy ? "Removing…" : "Confirm remove"}
                  </SecondaryButton>
                ) : (
                  <SecondaryButton type="button" disabled={busyId !== null} onClick={() => setConfirmingId(member.id)}>
                    Remove
                  </SecondaryButton>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog.Root open={dialogOpen} onOpenChange={(next) => { if (!next && !pending) closeForm(); }}>
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
                  {editing ? `Edit ${editing.firstName} ${editing.lastName}` : "Add an employee"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                  {editing
                    ? "Update their details — leave the password blank to keep the current one. Changing the password signs them out."
                    : "They sign in on the client login page once you approve them here. The login code must be different from every other sign-in."}
                </Dialog.Description>
              </div>
            </div>
            <form className="grid gap-5" onSubmit={onSubmit} noValidate>
              <div className="flex items-center gap-4 rounded-xl border border-border bg-surface-muted/50 px-4 py-3.5">
                {photo ? (
                  <img
                    src={photo}
                    alt="Selected profile photo"
                    className="h-14 w-14 shrink-0 rounded-full border border-border object-cover shadow-xs"
                  />
                ) : (
                  <span
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-border bg-primary/10 text-sm font-semibold tracking-wide text-primary"
                    aria-hidden="true"
                  >
                    {initials(draft) || <UserRound className="h-6 w-6" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <label htmlFor="staff-photo" className="text-sm font-medium text-foreground">
                    Profile photo <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="staff-photo"
                    name="photo"
                    type="file"
                    accept="image/*"
                    className="field mt-1.5 w-full py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-primary"
                    aria-invalid={Boolean(errors.photo)}
                    aria-describedby={errors.photo ? "staff-photo-error" : undefined}
                    onChange={(event) => void onPhoto(event.target.files?.[0])}
                  />
                  {errors.photo ? (
                    <p id="staff-photo-error" className="mt-1.5 text-sm font-medium text-destructive" role="alert">
                      {errors.photo}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-caption text-muted-foreground">
                      Shown next to their name — leave blank to use their initials.
                    </p>
                  )}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="staff-first-name" label="First name" error={errors.firstName}>
                  <input
                    id="staff-first-name"
                    name="firstName"
                    className="field"
                    autoComplete="off"
                    value={draft.firstName}
                    aria-invalid={Boolean(errors.firstName)}
                    aria-describedby={errors.firstName ? "staff-first-name-error" : undefined}
                    onChange={(event) => update("firstName", event.target.value)}
                  />
                </FormField>
                <FormField id="staff-last-name" label="Last name" error={errors.lastName}>
                  <input
                    id="staff-last-name"
                    name="lastName"
                    className="field"
                    autoComplete="off"
                    value={draft.lastName}
                    aria-invalid={Boolean(errors.lastName)}
                    aria-describedby={errors.lastName ? "staff-last-name-error" : undefined}
                    onChange={(event) => update("lastName", event.target.value)}
                  />
                </FormField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="staff-email" label="Email" error={errors.email}>
                  <input
                    id="staff-email"
                    name="email"
                    type="email"
                    className="field"
                    autoComplete="off"
                    value={draft.email}
                    aria-invalid={Boolean(errors.email)}
                    aria-describedby={errors.email ? "staff-email-error" : undefined}
                    onChange={(event) => update("email", event.target.value)}
                  />
                </FormField>
                <FormField id="staff-phone" label="Phone number" error={errors.phone}>
                  <input
                    id="staff-phone"
                    name="phone"
                    type="tel"
                    className="field"
                    autoComplete="off"
                    inputMode="tel"
                    value={draft.phone}
                    aria-invalid={Boolean(errors.phone)}
                    aria-describedby={errors.phone ? "staff-phone-error" : undefined}
                    onChange={(event) => update("phone", event.target.value)}
                  />
                </FormField>
              </div>
              <div className="border-t border-border/80 pt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Sign-in details
                </p>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <FormField id="staff-login-code" label="Login code" error={errors.loginCode} hint="6 digits.">
                    <input
                      id="staff-login-code"
                      name="loginCode"
                      className="field tracking-[0.3em]"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={draft.loginCode}
                      aria-invalid={Boolean(errors.loginCode)}
                      aria-describedby={errors.loginCode ? "staff-login-code-error" : "staff-login-code-hint"}
                      onChange={(event) => update("loginCode", event.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                  </FormField>
                  <FormField
                    id="staff-password"
                    label={editing ? "New password" : "Password"}
                    error={errors.password}
                    hint={editing ? "Optional — keeps the current one if blank." : "6 digits."}
                  >
                    <input
                      id="staff-password"
                      name="password"
                      type="password"
                      className="field tracking-[0.3em]"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={draft.password}
                      aria-invalid={Boolean(errors.password)}
                      aria-describedby={errors.password ? "staff-password-error" : "staff-password-hint"}
                      onChange={(event) => update("password", event.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                  </FormField>
                  <FormField id="staff-confirm-password" label="Confirm password" error={errors.confirmPassword}>
                    <input
                      id="staff-confirm-password"
                      name="confirmPassword"
                      type="password"
                      className="field tracking-[0.3em]"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={draft.confirmPassword}
                      aria-invalid={Boolean(errors.confirmPassword)}
                      aria-describedby={errors.confirmPassword ? "staff-confirm-password-error" : undefined}
                      onChange={(event) => update("confirmPassword", event.target.value.replace(/\D/g, "").slice(0, 6))}
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
                <SecondaryButton type="button" onClick={closeForm} disabled={pending}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save employee"}
                </PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
