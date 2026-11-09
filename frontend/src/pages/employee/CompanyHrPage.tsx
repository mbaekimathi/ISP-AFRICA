import * as Dialog from "@radix-ui/react-dialog";
import { UserRound } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { ReviewGate } from "@/components/auth/ReviewGate";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fileToProfilePhoto } from "@/lib/accounts";
import {
  employeeHomePath,
  employeeRoleLabel,
  employeeRoles,
  listEmployeesForReview,
  type EmployeeRole,
  type PublicEmployee,
} from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

const codePattern = /^\d{6}$/;

type Draft = {
  firstName: string;
  lastName: string;
  username: string;
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
  username: "",
  email: "",
  phone: "",
  loginCode: "",
  password: "",
  confirmPassword: "",
};

function loginCodeInUse(loginCode: string, companyEmployees: PublicEmployee[] | null) {
  if (!codePattern.test(loginCode) || !companyEmployees) return false;
  return companyEmployees.some((member) => member.loginCode === loginCode);
}

function validate(draft: Draft, photo: string, companyEmployees: PublicEmployee[] | null): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.firstName.trim().length < 2) errors.firstName = "Enter the employee's first name.";
  if (draft.lastName.trim().length < 2) errors.lastName = "Enter the employee's last name.";
  if (!/^[A-Za-z0-9_]{3,24}$/.test(draft.username.trim())) {
    errors.username = "Use 3 to 24 letters, numbers, or underscores.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = "Enter a valid email address.";
  const digits = draft.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) errors.phone = "Enter a phone number with 10 to 15 digits.";
  if (!codePattern.test(draft.loginCode)) errors.loginCode = "Enter a 6-digit login code.";
  else if (loginCodeInUse(draft.loginCode, companyEmployees)) {
    errors.loginCode = "That login code is already in use by a company employee.";
  }
  if (!codePattern.test(draft.password)) errors.password = "Use a 6-digit password.";
  if (draft.confirmPassword !== draft.password) errors.confirmPassword = "Passwords do not match.";
  return errors;
}

function initials(draft: Pick<Draft, "firstName" | "lastName">) {
  const first = draft.firstName.trim()[0] ?? "";
  const last = draft.lastName.trim()[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

export function CompanyHrPage() {
  usePageMeta("Company HR — ISP CENTRIC", "Register company employees and allocate roles.");
  const { employee, ready, register, approve, allocateRole } = useEmployeeAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [employees, setEmployees] = useState<PublicEmployee[] | null>(null);
  const [listError, setListError] = useState("");
  const [message, setMessage] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const wantsAdd = searchParams.get("add") === "1";
  const dialogOpen = formOpen || wantsAdd;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [photo, setPhoto] = useState("");
  const [errors, setErrors] = useState<DraftErrors>({});
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rolePicks, setRolePicks] = useState<Record<string, EmployeeRole | "">>({});

  const pendingCount = employees?.filter((row) => row.status !== "approved").length ?? 0;

  function closeForm() {
    setFormOpen(false);
    if (wantsAdd) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }

  function openAdd() {
    setDraft(emptyDraft);
    setPhoto("");
    setErrors({});
    setFormOpen(true);
  }

  useEffect(() => {
    if (!employee || employee.role !== "director") return;
    let stopped = false;
    listEmployeesForReview()
      .then((rows) => {
        if (!stopped) setEmployees(rows);
      })
      .catch((cause: unknown) => {
        if (!stopped) setListError(cause instanceof Error ? cause.message : "The employee list could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [employee]);

  function update(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (field === "loginCode") {
      setErrors((current) => {
        if (!codePattern.test(value)) {
          return { ...current, loginCode: value ? "Enter a 6-digit login code." : undefined };
        }
        if (loginCodeInUse(value, employees)) {
          return { ...current, loginCode: "That login code is already in use by a company employee." };
        }
        return { ...current, loginCode: undefined };
      });
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await fileToProfilePhoto(file));
      setErrors((current) => ({ ...current, photo: undefined }));
    } catch (cause) {
      setPhoto("");
      setErrors((current) => ({
        ...current,
        photo: cause instanceof Error ? cause.message : "Could not use that photo.",
      }));
    }
  }

  async function reload(note?: string) {
    setEmployees(await listEmployeesForReview());
    if (note) setMessage(note);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(draft, photo, employees);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    setListError("");
    try {
      await register({
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        username: draft.username.trim(),
        email: draft.email.trim(),
        phone: draft.phone.trim(),
        loginCode: draft.loginCode,
        password: draft.password,
        photoDataUrl: photo,
      });
      await reload(`${draft.firstName.trim()} was registered and is waiting for approval.`);
      setDraft(emptyDraft);
      setPhoto("");
      closeForm();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The employee could not be registered.";
      if (/login code is already in use/i.test(message)) {
        setErrors({ loginCode: message });
      } else {
        setErrors({ form: message });
      }
    } finally {
      setPending(false);
    }
  }

  async function activate(member: PublicEmployee) {
    const role = rolePicks[member.id];
    if (!role) return;
    setListError("");
    setMessage("");
    setBusyId(member.id);
    try {
      if (member.status !== "approved") {
        await approve(member.id);
      }
      await allocateRole(member.id, role);
      await reload(`${member.firstName} is allocated to ${employeeRoleLabel(role)}.`);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Could not allocate that role.");
    } finally {
      setBusyId(null);
    }
  }

  if (!ready) {
    return <LiveLoad label="Loading company HR" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.role !== "director") {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  return (
    <div className="page-shell py-8">
      <ReviewGate>
        <PageHeader
          title="Company HR"
          description="Register company employees, approve them, and allocate Director, Supervisor, Customer Care, Technician, IT Support, Dispatcher, or Sales."
        />
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {employees ? `${employees.length} employees` : "Loading…"}
            {pendingCount > 0 ? ` · ${pendingCount} pending approval` : ""}
          </p>
          <PrimaryButton type="button" onClick={openAdd}>
            Register employee
          </PrimaryButton>
        </div>
        {message ? (
          <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
            {message}
          </p>
        ) : null}
        {listError ? (
          <p className="notice mt-4" role="alert">
            {listError}
          </p>
        ) : null}
        <ul className="panel mt-4 divide-y divide-border overflow-hidden">
          {!employees && !listError ? (
            <li className="px-4 py-6" aria-hidden="true">
              <div className="grid gap-3">
                <div className="skeleton h-4 w-1/3" />
                <div className="skeleton h-4 w-2/5" />
                <div className="skeleton h-4 w-1/4" />
              </div>
            </li>
          ) : null}
          {employees?.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground">
              No company employees are registered yet.
            </li>
          ) : null}
          {employees?.map((member) => {
            const memberPending = member.status !== "approved";
            const busy = busyId === member.id;
            const selected = rolePicks[member.id] ?? member.role ?? "";
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
                      {member.role ? (
                        <StatusBadge tone="neutral">{employeeRoleLabel(member.role)}</StatusBadge>
                      ) : !memberPending ? (
                        <StatusBadge tone="due">No role</StatusBadge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      @{member.username} · {member.email} · {member.phone}
                    </p>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      Login code {member.loginCode}
                      {member.employeeCode ? ` · ${member.employeeCode}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="field min-h-10 w-auto text-sm"
                    aria-label={`Role for ${member.firstName} ${member.lastName}`}
                    value={selected}
                    onChange={(event) =>
                      setRolePicks((current) => ({
                        ...current,
                        [member.id]: event.target.value as EmployeeRole | "",
                      }))
                    }
                  >
                    <option value="" disabled>
                      Choose role
                    </option>
                    {employeeRoles.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <PrimaryButton type="button" disabled={busy || !selected} onClick={() => void activate(member)}>
                    {busy ? "Saving…" : memberPending ? "Approve & allocate" : "Allocate role"}
                  </PrimaryButton>
                </div>
              </li>
            );
          })}
        </ul>

        <Dialog.Root
          open={dialogOpen}
          onOpenChange={(next) => {
            if (!next && !pending) closeForm();
          }}
        >
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
                    Register an employee
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                    Creates a pending company account. Approve them below and allocate a role so they can sign in to the staff console.
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
                    <label htmlFor="company-hr-photo" className="text-sm font-medium text-foreground">
                      Profile photo <span className="font-normal text-muted-foreground">(optional)</span>
                    </label>
                    <input
                      id="company-hr-photo"
                      name="photo"
                      type="file"
                      accept="image/*"
                      className="field mt-1.5 w-full py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-primary"
                      aria-invalid={Boolean(errors.photo)}
                      aria-describedby={errors.photo ? "company-hr-photo-error" : undefined}
                      onChange={(event) => void onPhoto(event.target.files?.[0])}
                    />
                    {errors.photo ? (
                      <p id="company-hr-photo-error" className="mt-1.5 text-sm font-medium text-destructive" role="alert">
                        {errors.photo}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-caption text-muted-foreground">
                        Optional — shown next to their name in the staff console.
                      </p>
                    )}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField id="company-hr-first-name" label="First name" error={errors.firstName}>
                    <input
                      id="company-hr-first-name"
                      className="field"
                      autoComplete="off"
                      value={draft.firstName}
                      aria-invalid={Boolean(errors.firstName)}
                      aria-describedby={errors.firstName ? "company-hr-first-name-error" : undefined}
                      onChange={(event) => update("firstName", event.target.value)}
                    />
                  </FormField>
                  <FormField id="company-hr-last-name" label="Last name" error={errors.lastName}>
                    <input
                      id="company-hr-last-name"
                      className="field"
                      autoComplete="off"
                      value={draft.lastName}
                      aria-invalid={Boolean(errors.lastName)}
                      aria-describedby={errors.lastName ? "company-hr-last-name-error" : undefined}
                      onChange={(event) => update("lastName", event.target.value)}
                    />
                  </FormField>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField id="company-hr-username" label="Username" error={errors.username}>
                    <input
                      id="company-hr-username"
                      className="field"
                      autoComplete="off"
                      value={draft.username}
                      aria-invalid={Boolean(errors.username)}
                      aria-describedby={errors.username ? "company-hr-username-error" : undefined}
                      onChange={(event) => update("username", event.target.value)}
                    />
                  </FormField>
                  <FormField id="company-hr-email" label="Email" error={errors.email}>
                    <input
                      id="company-hr-email"
                      type="email"
                      className="field"
                      autoComplete="off"
                      value={draft.email}
                      aria-invalid={Boolean(errors.email)}
                      aria-describedby={errors.email ? "company-hr-email-error" : undefined}
                      onChange={(event) => update("email", event.target.value)}
                    />
                  </FormField>
                </div>
                <FormField id="company-hr-phone" label="Phone number" error={errors.phone}>
                  <input
                    id="company-hr-phone"
                    type="tel"
                    className="field"
                    autoComplete="off"
                    inputMode="tel"
                    value={draft.phone}
                    aria-invalid={Boolean(errors.phone)}
                    aria-describedby={errors.phone ? "company-hr-phone-error" : undefined}
                    onChange={(event) => update("phone", event.target.value)}
                  />
                </FormField>
                <div className="border-t border-border/80 pt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Sign-in details</p>
                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <FormField
                      id="company-hr-login-code"
                      label="Login code"
                      error={errors.loginCode}
                      hint="6 digits. Must be unique among company employees."
                    >
                      <input
                        id="company-hr-login-code"
                        className="field tracking-[0.3em]"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={6}
                        value={draft.loginCode}
                        aria-invalid={Boolean(errors.loginCode)}
                        aria-describedby={errors.loginCode ? "company-hr-login-code-error" : "company-hr-login-code-hint"}
                        onChange={(event) => update("loginCode", event.target.value.replace(/\D/g, "").slice(0, 6))}
                      />
                    </FormField>
                    <FormField id="company-hr-password" label="Password" error={errors.password} hint="6 digits.">
                      <input
                        id="company-hr-password"
                        type="password"
                        className="field tracking-[0.3em]"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={6}
                        value={draft.password}
                        aria-invalid={Boolean(errors.password)}
                        aria-describedby={errors.password ? "company-hr-password-error" : "company-hr-password-hint"}
                        onChange={(event) => update("password", event.target.value.replace(/\D/g, "").slice(0, 6))}
                      />
                    </FormField>
                    <FormField id="company-hr-confirm" label="Confirm password" error={errors.confirmPassword}>
                      <input
                        id="company-hr-confirm"
                        type="password"
                        className="field tracking-[0.3em]"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={6}
                        value={draft.confirmPassword}
                        aria-invalid={Boolean(errors.confirmPassword)}
                        aria-describedby={errors.confirmPassword ? "company-hr-confirm-error" : undefined}
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
                    {pending ? "Registering…" : "Register employee"}
                  </PrimaryButton>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </ReviewGate>
    </div>
  );
}
