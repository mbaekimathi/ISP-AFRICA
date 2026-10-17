import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { FormField } from "@/components/ui/FormField";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fileToProfilePhoto } from "@/lib/accounts";
import { employeeHomePath } from "@/lib/employees";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type SignUpValues = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  loginCode: string;
  password: string;
  confirmPassword: string;
};

type SignUpErrors = Partial<Record<keyof SignUpValues | "photo" | "form", string>>;

const emptyValues: SignUpValues = {
  firstName: "",
  lastName: "",
  username: "",
  email: "",
  phone: "",
  loginCode: "",
  password: "",
  confirmPassword: "",
};

const codePattern = /^\d{6}$/;

function validate(values: SignUpValues, photo: string) {
  const errors: SignUpErrors = {};
  if (values.firstName.trim().length < 2) errors.firstName = "Enter your first name.";
  if (values.lastName.trim().length < 2) errors.lastName = "Enter your last name.";
  if (!/^[A-Za-z0-9_]{3,24}$/.test(values.username.trim())) {
    errors.username = "Use 3 to 24 letters, numbers, or underscores.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  const digits = values.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    errors.phone = "Enter a phone number with 10 to 15 digits.";
  }
  if (!codePattern.test(values.loginCode)) errors.loginCode = "Enter a 6-digit login code.";
  if (!codePattern.test(values.password)) errors.password = "Use a 6-digit password.";
  if (values.confirmPassword !== values.password) errors.confirmPassword = "Passwords do not match.";
  if (!photo) errors.photo = "Upload a profile photo.";
  return errors;
}

export function EmployeeSignUpPage() {
  usePageMeta("Employee sign up — ISP CENTRIC", "Create a pending ISP CENTRIC employee account.");
  const { user, ready: clientReady } = useAuth();
  const { employee, register } = useEmployeeAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<SignUpValues>(emptyValues);
  const [photo, setPhoto] = useState("");
  const [errors, setErrors] = useState<SignUpErrors>({});
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState(0);

  if (!clientReady) {
    return <LiveLoad label="Loading account" />;
  }

  if (user && !employee) {
    return <Navigate to="/account" replace />;
  }

  if (employee) {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  function update(field: keyof SignUpValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await fileToProfilePhoto(file));
      setErrors((current) => ({ ...current, photo: undefined }));
    } catch (error) {
      setPhoto("");
      setErrors((current) => ({
        ...current,
        photo: error instanceof Error ? error.message : "Could not use that photo.",
      }));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(values, photo);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const profileError = Boolean(
        nextErrors.firstName || nextErrors.lastName || nextErrors.username || nextErrors.email || nextErrors.phone || nextErrors.photo,
      );
      setStep(profileError ? 0 : 1);
      return;
    }

    setPending(true);
    try {
      await register({ ...values, photoDataUrl: photo });
      navigate("/employee/login", { replace: true, state: { registered: true } });
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "Could not create the employee account." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page-shell py-14">
      <div className="form-card">
        <Logo variant="employee" />
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-accent">Employees</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Employee sign up</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The account is saved in ISP-DB as pending. The username, email, phone number, and login code must be different from every ISP client account. After approval, a role can be allocated: Director, Supervisor, Customer Care, Technician, IT Support, Dispatcher, or Sales.
        </p>
        <form className="mt-2 grid gap-4" onSubmit={onSubmit} noValidate>
          <p className="text-xs font-medium text-muted-foreground">Step {step + 1} of 2 · {step === 0 ? "Your details" : "Sign in"}</p>
          <div className="grid gap-4" hidden={step !== 0}>
            <FormField id="emp-first-name" label="First name" error={errors.firstName}>
              <input id="emp-first-name" className="field" autoComplete="given-name" value={values.firstName} aria-invalid={Boolean(errors.firstName)} aria-describedby={errors.firstName ? "emp-first-name-error" : undefined} onChange={(event) => update("firstName", event.target.value)} />
            </FormField>
            <FormField id="emp-last-name" label="Last name" error={errors.lastName}>
              <input id="emp-last-name" className="field" autoComplete="family-name" value={values.lastName} aria-invalid={Boolean(errors.lastName)} aria-describedby={errors.lastName ? "emp-last-name-error" : undefined} onChange={(event) => update("lastName", event.target.value)} />
            </FormField>
            <FormField id="emp-username" label="Username" error={errors.username}>
              <input id="emp-username" className="field" autoComplete="username" value={values.username} aria-invalid={Boolean(errors.username)} aria-describedby={errors.username ? "emp-username-error" : undefined} onChange={(event) => update("username", event.target.value)} />
            </FormField>
            <FormField id="emp-email" label="Email" error={errors.email}>
              <input id="emp-email" type="email" className="field" autoComplete="email" value={values.email} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "emp-email-error" : undefined} onChange={(event) => update("email", event.target.value)} />
            </FormField>
            <FormField id="emp-phone" label="Phone number" error={errors.phone}>
              <input id="emp-phone" type="tel" className="field" autoComplete="tel" inputMode="tel" value={values.phone} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? "emp-phone-error" : undefined} onChange={(event) => update("phone", event.target.value)} />
            </FormField>
            <FormField id="emp-photo" label="Profile photo" error={errors.photo}>
              <div className="flex flex-col items-start gap-3">
                {photo ? (
                  <img src={photo} alt="Selected profile photo" className="h-16 w-16 rounded-full object-cover" />
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-border bg-surface-muted text-xs text-muted-foreground">Photo</span>
                )}
                <input id="emp-photo" type="file" accept="image/*" className="field py-2" aria-invalid={Boolean(errors.photo)} aria-describedby={errors.photo ? "emp-photo-error" : undefined} onChange={(event) => void onPhoto(event.target.files?.[0])} />
              </div>
            </FormField>
          </div>
          <div className="grid gap-4" hidden={step !== 1}>
            <FormField id="emp-code" label="6-digit login code" error={errors.loginCode} hint="You will use this code to sign in.">
              <input id="emp-code" className="field tracking-[0.3em]" inputMode="numeric" autoComplete="off" maxLength={6} value={values.loginCode} aria-invalid={Boolean(errors.loginCode)} aria-describedby={errors.loginCode ? "emp-code-error" : "emp-code-hint"} onChange={(event) => update("loginCode", event.target.value.replace(/\D/g, "").slice(0, 6))} />
            </FormField>
            <FormField id="emp-password" label="Password" error={errors.password} hint="Must be 6 digits.">
              <input id="emp-password" type="password" className="field tracking-[0.3em]" inputMode="numeric" autoComplete="new-password" maxLength={6} value={values.password} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? "emp-password-error" : "emp-password-hint"} onChange={(event) => update("password", event.target.value.replace(/\D/g, "").slice(0, 6))} />
            </FormField>
            <FormField id="emp-confirm" label="Confirm password" error={errors.confirmPassword}>
              <input id="emp-confirm" type="password" className="field tracking-[0.3em]" inputMode="numeric" autoComplete="new-password" maxLength={6} value={values.confirmPassword} aria-invalid={Boolean(errors.confirmPassword)} aria-describedby={errors.confirmPassword ? "emp-confirm-error" : undefined} onChange={(event) => update("confirmPassword", event.target.value.replace(/\D/g, "").slice(0, 6))} />
            </FormField>
          </div>
          {errors.form ? (
            <p className="text-sm text-destructive" role="alert">{errors.form}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {step === 1 ? (
              <SecondaryButton type="button" onClick={() => setStep(0)}>
                Back
              </SecondaryButton>
            ) : null}
            {step === 0 ? (
              <PrimaryButton type="button" onClick={() => setStep(1)}>
                Continue
              </PrimaryButton>
            ) : (
              <PrimaryButton type="submit" disabled={pending}>
                {pending ? "Creating account…" : "Create employee account"}
              </PrimaryButton>
            )}
          </div>
        </form>
        <p className="mt-6 text-sm text-muted-foreground">
          Already registered?{" "}
          <Link to="/employee/login" className="font-semibold text-primary">Employee login</Link>
        </p>
      </div>
    </div>
  );
}
