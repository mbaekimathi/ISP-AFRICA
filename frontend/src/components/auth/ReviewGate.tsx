import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { reviewerAccess, type ReviewerAccess } from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

export function ReviewGate({ children }: { children: ReactNode }) {
  const { employee, ready } = useEmployeeAuth();
  const [access, setAccess] = useState<ReviewerAccess | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    reviewerAccess().then((value) => {
      if (!cancelled) setAccess(value);
    });
    return () => {
      cancelled = true;
    };
  }, [employee, ready]);

  if (!access) {
    return <LiveLoad label="Loading reviews" />;
  }

  if (access === "denied") {
    return (
      <div>
        <div className="mx-auto max-w-xl rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Director sign-in required</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Account approval and role allocation are limited to a signed-in employee with the Director role.
            {employee ? " This signed-in employee does not have that role." : ""}
          </p>
          <p className="mt-4 text-sm">
            <Link to="/employee/login" className="font-semibold text-primary">
              Employee login
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {access === "bootstrap" ? (
        <p className="notice">
          No Director exists yet. Approve the first employee and allocate the Director role. After that, only a signed-in Director can use review pages.
        </p>
      ) : null}
      {children}
    </>
  );
}
