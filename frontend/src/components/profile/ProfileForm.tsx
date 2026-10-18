import type { FormEvent } from "react";
import { useState } from "react";
import { PrimaryButton } from "@/components/ui/Buttons";
import { FormField } from "@/components/ui/FormField";
import { fileToProfilePhoto, type AccountInput } from "@/lib/accounts";

export type ProfileSource = Pick<
  AccountInput,
  "firstName" | "lastName" | "username" | "email" | "phone" | "loginCode" | "photoDataUrl"
>;

type ProfileValues = Omit<ProfileSource, "photoDataUrl"> & {
  password: string;
  confirmPassword: string;
};

type ProfileErrors = Partial<Record<keyof ProfileValues | "photo" | "form", string>>;

const codePattern = /^\d{6}$/;

function validate(values: ProfileValues) {
  const errors: ProfileErrors = {};
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
  if (values.password) {
    if (!codePattern.test(values.password)) errors.password = "Use a 6-digit password.";
    else if (values.confirmPassword !== values.password) errors.confirmPassword = "Passwords do not match.";
  } else if (values.confirmPassword) {
    errors.confirmPassword = "Enter the new password first.";
  }
  return errors;
}

export function ProfileForm({
  account,
  idPrefix,
  onSubmit,
}: {
  account: ProfileSource;
  idPrefix: string;
  onSubmit: (input: AccountInput) => Promise<void>;
}) {
  const [values, setValues] = useState<ProfileValues>({
    firstName: account.firstName,
    lastName: account.lastName,
    username: account.username,
    email: account.email,
    phone: account.phone,
    loginCode: account.loginCode,
    password: "",
    confirmPassword: "",
  });
  const [photo, setPhoto] = useState(account.photoDataUrl);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  function update(field: keyof ProfileValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setNotice("");
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await fileToProfilePhoto(file);
      setPhoto(dataUrl);
      setNotice("");
      setErrors((current) => ({ ...current, photo: undefined }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        photo: error instanceof Error ? error.message : "Could not use that photo.",
      }));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setPending(true);
    try {
      await onSubmit({
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        username: values.username.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        loginCode: values.loginCode,
        password: values.password,
        photoDataUrl: photo,
      });
      setValues((current) => ({ ...current, password: "", confirmPassword: "" }));
      setNotice("Saved — your profile details are up to date.");
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "Could not save the profile." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form-card mt-6 max-w-2xl" onSubmit={submit} noValidate>
      <div className="grid gap-4">
        <FormField id={`${idPrefix}-photo`} label="Profile photo" error={errors.photo} hint="Upload a new photo to replace the current one.">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            {photo ? (
              <img src={photo} alt="Current profile photo" className="h-20 w-20 rounded-full object-cover" />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-border bg-surface-muted text-xs text-muted-foreground">
                Photo
              </span>
            )}
            <input
              id={`${idPrefix}-photo`}
              name="photo"
              type="file"
              accept="image/*"
              className="field py-2"
              aria-invalid={Boolean(errors.photo)}
              aria-describedby={errors.photo ? `${idPrefix}-photo-error` : `${idPrefix}-photo-hint`}
              onChange={(event) => void onPhoto(event.target.files?.[0])}
            />
          </div>
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id={`${idPrefix}-first-name`} label="First name" error={errors.firstName}>
            <input
              id={`${idPrefix}-first-name`}
              name="given-name"
              className="field"
              autoComplete="given-name"
              maxLength={60}
              value={values.firstName}
              aria-invalid={Boolean(errors.firstName)}
              aria-describedby={errors.firstName ? `${idPrefix}-first-name-error` : undefined}
              onChange={(event) => update("firstName", event.target.value)}
            />
          </FormField>
          <FormField id={`${idPrefix}-last-name`} label="Last name" error={errors.lastName}>
            <input
              id={`${idPrefix}-last-name`}
              name="family-name"
              className="field"
              autoComplete="family-name"
              maxLength={60}
              value={values.lastName}
              aria-invalid={Boolean(errors.lastName)}
              aria-describedby={errors.lastName ? `${idPrefix}-last-name-error` : undefined}
              onChange={(event) => update("lastName", event.target.value)}
            />
          </FormField>
        </div>
        <FormField id={`${idPrefix}-username`} label="Username" error={errors.username}>
          <input
            id={`${idPrefix}-username`}
            name="username"
            className="field"
            autoComplete="username"
            maxLength={24}
            value={values.username}
            aria-invalid={Boolean(errors.username)}
            aria-describedby={errors.username ? `${idPrefix}-username-error` : undefined}
            onChange={(event) => update("username", event.target.value)}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id={`${idPrefix}-email`} label="Email" error={errors.email}>
            <input
              id={`${idPrefix}-email`}
              name="email"
              type="email"
              className="field"
              autoComplete="email"
              maxLength={120}
              value={values.email}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? `${idPrefix}-email-error` : undefined}
              onChange={(event) => update("email", event.target.value)}
            />
          </FormField>
          <FormField id={`${idPrefix}-phone`} label="Phone number" error={errors.phone}>
            <input
              id={`${idPrefix}-phone`}
              name="tel"
              type="tel"
              className="field"
              autoComplete="tel"
              inputMode="tel"
              value={values.phone}
              aria-invalid={Boolean(errors.phone)}
              aria-describedby={errors.phone ? `${idPrefix}-phone-error` : undefined}
              onChange={(event) => update("phone", event.target.value)}
            />
          </FormField>
        </div>
        <FormField id={`${idPrefix}-login-code`} label="6-digit login code" error={errors.loginCode} hint="You use this code to sign in.">
          <input
            id={`${idPrefix}-login-code`}
            name="loginCode"
            className="field tracking-[0.3em]"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={values.loginCode}
            aria-invalid={Boolean(errors.loginCode)}
            aria-describedby={errors.loginCode ? `${idPrefix}-login-code-error` : `${idPrefix}-login-code-hint`}
            onChange={(event) => update("loginCode", event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id={`${idPrefix}-password`} label="New password" error={errors.password} hint="Leave blank to keep the current password.">
            <input
              id={`${idPrefix}-password`}
              name="new-password"
              type="password"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={values.password}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? `${idPrefix}-password-error` : `${idPrefix}-password-hint`}
              onChange={(event) => update("password", event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </FormField>
          <FormField id={`${idPrefix}-confirm`} label="Confirm new password" error={errors.confirmPassword}>
            <input
              id={`${idPrefix}-confirm`}
              name="confirm-password"
              type="password"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={values.confirmPassword}
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={errors.confirmPassword ? `${idPrefix}-confirm-error` : undefined}
              onChange={(event) => update("confirmPassword", event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </FormField>
        </div>
        {errors.form ? (
          <p className="notice" role="alert">
            {errors.form}
          </p>
        ) : null}
        {notice ? (
          <p className="notice border-success-border bg-success-soft/60" role="status">
            {notice}
          </p>
        ) : null}
        <div>
          <PrimaryButton type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save profile"}
          </PrimaryButton>
        </div>
      </div>
    </form>
  );
}
