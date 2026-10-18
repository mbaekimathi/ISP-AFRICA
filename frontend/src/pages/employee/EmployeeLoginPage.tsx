import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { FormField } from "@/components/ui/FormField";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { usePageMeta } from "@/hooks/usePageMeta";
import { employeeHomePath } from "@/lib/employees";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

const codePattern = /^\d{6}$/;

export function EmployeeLoginPage() {
  usePageMeta("Employee login — ISP CENTRIC", "Sign in as an ISP CENTRIC employee with a 6-digit code and password.");
  const { user, ready: clientReady } = useAuth();
  const { employee, login } = useEmployeeAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const registered = Boolean((location.state as { registered?: boolean } | null)?.registered);
  const [loginCode, setLoginCode] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ loginCode?: string; password?: string; form?: string }>({});
  const [pending, setPending] = useState(false);

  if (!clientReady) {
    return <LiveLoad label="Loading account" />;
  }

  if (user && !employee) {
    return <Navigate to="/account" replace />;
  }

  if (employee) {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: { loginCode?: string; password?: string } = {};
    if (!codePattern.test(loginCode)) nextErrors.loginCode = "Enter the 6-digit login code.";
    if (!codePattern.test(password)) nextErrors.password = "Enter the 6-digit password.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      const account = await login(loginCode, password);
      navigate(employeeHomePath(account), { replace: true });
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "Could not sign in." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page-shell flex min-h-[70vh] items-center py-14">
      <div className="form-card">
        <Logo variant="employee" />
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-accent">Employees</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Employee login</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Sign in with your 6-digit login code and 6-digit password. A role is available only after approval and allocation.
        </p>
        {registered ? (
          <p className="mt-4 notice" role="status">
            Employee account submitted and pending approval. Sign in to check the status.
          </p>
        ) : null}
        <form className="mt-2 grid gap-4" onSubmit={onSubmit} noValidate>
          <FormField id="employee-login-code" label="Login code" error={errors.loginCode} hint="6 digits.">
            <input
              id="employee-login-code"
              name="loginCode"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="username"
              maxLength={6}
              value={loginCode}
              aria-invalid={Boolean(errors.loginCode)}
              aria-describedby={errors.loginCode ? "employee-login-code-error" : "employee-login-code-hint"}
              onChange={(event) => setLoginCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </FormField>
          <FormField id="employee-password" label="Password" error={errors.password} hint="6 digits.">
            <input
              id="employee-password"
              name="password"
              type="password"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              value={password}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "employee-password-error" : "employee-password-hint"}
              onChange={(event) => setPassword(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </FormField>
          {errors.form ? (
            <p className="text-sm text-destructive" role="alert">
              {errors.form}
            </p>
          ) : null}
          <PrimaryButton type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Login"}
          </PrimaryButton>
        </form>
        <p className="mt-6 text-sm text-muted-foreground">
          New employee?{" "}
          <Link to="/employee/signup" className="font-semibold text-primary">
            Create an employee account
          </Link>
        </p>
      </div>
    </div>
  );
}
