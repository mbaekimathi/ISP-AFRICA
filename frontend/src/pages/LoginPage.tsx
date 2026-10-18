import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { FormField } from "@/components/ui/FormField";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientHomePath } from "@/lib/accounts";
import { employeeHomePath } from "@/lib/employees";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

const codePattern = /^\d{6}$/;

export function LoginPage() {
  usePageMeta("Login — ISP CENTRIC", "Sign in to ISP CENTRIC with your 6-digit login code and password.");
  const { user, login } = useAuth();
  const { employee, ready: employeeReady } = useEmployeeAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const registered = Boolean((location.state as { registered?: boolean } | null)?.registered);
  const [loginCode, setLoginCode] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ loginCode?: string; password?: string; form?: string }>({});
  const [pending, setPending] = useState(false);

  if (!employeeReady) {
    return <LiveLoad label="Loading account" />;
  }

  if (employee) {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  if (user) {
    return <Navigate to={clientHomePath(user)} replace />;
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
      navigate(clientHomePath(account), { replace: true });
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : "Could not sign in." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page-shell flex min-h-[70vh] items-center py-14">
      <div className="form-card">
        <Logo />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight sm:text-3xl">Login</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Sign in with the 6-digit login code and the 6-digit password from your account.
        </p>
        {registered ? (
          <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
            Account submitted and pending approval. Sign in to check the status. The ISP client account opens after approval.
          </p>
        ) : null}
        <form className="mt-2 grid gap-4" onSubmit={onSubmit} noValidate>
          <FormField id="login-code" label="Login code" error={errors.loginCode} hint="6 digits.">
            <input
              id="login-code"
              name="loginCode"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="username"
              maxLength={6}
              value={loginCode}
              aria-invalid={Boolean(errors.loginCode)}
              aria-describedby={errors.loginCode ? "login-code-error" : "login-code-hint"}
              onChange={(event) => setLoginCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </FormField>
          <FormField id="password" label="Password" error={errors.password} hint="6 digits.">
            <input
              id="password"
              name="password"
              type="password"
              className="field tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              value={password}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : "password-hint"}
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
          New to ISP CENTRIC?{" "}
          <Link to="/signup" className="font-semibold text-primary">
            Create an account
          </Link>
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Staff member?{" "}
          <Link to="/employee/login" className="font-semibold text-primary">
            Employee login
          </Link>
        </p>
      </div>
    </div>
  );
}
