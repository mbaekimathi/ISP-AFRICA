import { Navigate } from "react-router-dom";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { employeeRoleLabel } from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

export function EmployeeAccountPage() {
  usePageMeta("Employee account — ISP CENTRIC", "ISP CENTRIC employee account.");
  const { employee, ready, logout, saveProfile } = useEmployeeAuth();

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  const waitingForApproval = employee.status !== "approved";
  const waitingForRole = !waitingForApproval && !employee.role;

  if (!waitingForApproval && !waitingForRole) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Profile" description="View and edit the details on this employee account." />
        <article className="card mt-6 p-5">
          <DetailGrid
            items={[
              { label: "Employee", value: employee.employeeCode ?? "Not assigned" },
              ...(employee.role ? [{ label: "Role", value: employeeRoleLabel(employee.role) }] : []),
            ]}
          />
        </article>
        <ProfileForm
          idPrefix="employee-profile"
          account={{
            firstName: employee.firstName,
            lastName: employee.lastName,
            username: employee.username,
            email: employee.email,
            phone: employee.phone,
            loginCode: employee.loginCode,
            photoDataUrl: employee.photoDataUrl,
          }}
          onSubmit={saveProfile}
        />
      </div>
    );
  }

  return (
    <div className="page-shell py-8">
      <article className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src={employee.photoDataUrl}
              alt={`Profile photo of ${employee.firstName} ${employee.lastName}`}
              className="h-10 w-10 rounded-full object-cover"
            />
            <div>
              <h1 className="text-base font-semibold">{waitingForApproval ? "Waiting for approval" : "Waiting for a role"}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {waitingForApproval
                  ? "Sign-in works. A role cannot be used until this registration is approved."
                  : "This account is approved. Access opens after a role is allocated."}
              </p>
            </div>
          </div>
          <StatusBadge tone={waitingForApproval ? "due" : "active"}>{waitingForApproval ? "Pending" : "Approved"}</StatusBadge>
        </div>
        <div className="mt-3">
          <DetailGrid
            items={[
              { label: "Name", value: `${employee.firstName} ${employee.lastName}` },
              { label: "Username", value: employee.username },
              { label: "Email", value: employee.email },
              { label: "Phone", value: employee.phone },
              { label: "Employee", value: employee.employeeCode ?? "Not assigned" },
            ]}
          />
        </div>
        <div className="mt-4">
          <PrimaryButton type="button" onClick={logout}>
            Log out
          </PrimaryButton>
        </div>
      </article>
    </div>
  );
}
