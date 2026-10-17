import { useEffect, useState } from "react";
import { ReviewGate } from "@/components/auth/ReviewGate";
import { PrimaryButton } from "@/components/ui/Buttons";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { employeeRoleLabel, employeeRoles, listEmployeesForReview, type EmployeeRole, type PublicEmployee } from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

export function EmployeeReviewsPage() {
  usePageMeta("Employee reviews — ISP CENTRIC", "Approve employees and allocate roles.");
  const { approve, allocateRole } = useEmployeeAuth();
  const [employees, setEmployees] = useState<PublicEmployee[]>([]);
  const [roles, setRoles] = useState<Record<string, EmployeeRole | "">>({});
  const [message, setMessage] = useState("");

  const pending = employees.filter((employee) => employee.status !== "approved");
  const approved = employees.filter((employee) => employee.status === "approved");

  useEffect(() => {
    listEmployeesForReview().then(setEmployees).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Could not load employees.");
    });
  }, []);

  async function refresh(note: string) {
    setEmployees(await listEmployeesForReview());
    setMessage(note);
  }

  return (
    <div className="page-shell py-8">
      <ReviewGate>
      <div className="grid gap-8">
        <PageHeader
          title="Approval and roles"
          description="Approve a pending employee first. Allocate a role only after approval."
        />
        {message ? (
          <p className="rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-foreground" role="status">
            {message}
          </p>
        ) : null}
        <section className="grid gap-4" aria-labelledby="employee-pending-heading">
          <h2 id="employee-pending-heading" className="text-xl font-semibold">Pending</h2>
          {pending.length === 0 ? (
            <p className="rounded-2xl border border-border bg-surface p-5 text-sm text-muted-foreground">No employees are waiting.</p>
          ) : (
            pending.map((employee) => (
              <article key={employee.id} className="rounded-xl border border-border bg-surface p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <img src={employee.photoDataUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{employee.firstName} {employee.lastName}</h3>
                      <StatusBadge tone="due">Pending</StatusBadge>
                    </div>
                  </div>
                <PrimaryButton
                  type="button"
                  onClick={() => {
                    approve(employee.id)
                      .then(() => refresh("Employee approved. Allocate a role when you are ready."))
                      .catch((error: unknown) => {
                        setMessage(error instanceof Error ? error.message : "Could not approve that employee.");
                      });
                  }}
                >
                  Approve
                </PrimaryButton>
                </div>
                <div className="mt-3">
                  <DetailGrid
                    items={[
                      { label: "Username", value: employee.username },
                      { label: "Email", value: employee.email },
                      { label: "Phone", value: employee.phone },
                      { label: "Login code", value: employee.loginCode },
                    ]}
                  />
                </div>
              </article>
            ))
          )}
        </section>
        <section className="grid gap-4" aria-labelledby="employee-role-heading">
          <h2 id="employee-role-heading" className="text-xl font-semibold">Allocate a role</h2>
          {approved.length === 0 ? (
            <p className="text-sm text-muted-foreground">Approve an employee before allocating a role.</p>
          ) : (
            approved.map((employee) => {
              const selected = roles[employee.id] ?? employee.role ?? "";
              return (
                <article key={employee.id} className="rounded-xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{employee.firstName} {employee.lastName}</h3>
                    <StatusBadge tone="active">{employee.role ? employeeRoleLabel(employee.role) : "No role"}</StatusBadge>
                  </div>
                  <div className="mt-3">
                    <DetailGrid
                      items={[
                        { label: "Employee", value: employee.employeeCode ?? "Not assigned" },
                        { label: "Email", value: employee.email },
                      ]}
                    />
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-center">
                    <label className="sr-only" htmlFor={`role-${employee.id}`}>Role for {employee.firstName}</label>
                    <select
                      id={`role-${employee.id}`}
                      className="field"
                      value={selected}
                      onChange={(event) =>
                        setRoles((current) => ({
                          ...current,
                          [employee.id]: event.target.value as EmployeeRole | "",
                        }))
                      }
                    >
                      <option value="">Select a role</option>
                      {employeeRoles.map((role) => (
                        <option key={role.value} value={role.value}>{role.label}</option>
                      ))}
                    </select>
                    <PrimaryButton
                      type="button"
                      disabled={!selected}
                      onClick={() => {
                        if (!selected) return;
                        allocateRole(employee.id, selected)
                          .then(() => refresh(`${employee.firstName} is allocated to ${employeeRoleLabel(selected)}.`))
                          .catch((error: unknown) => {
                            setMessage(error instanceof Error ? error.message : "Could not allocate that role.");
                          });
                      }}
                    >
                      Allocate role
                    </PrimaryButton>
                  </div>
                </article>
              );
            })
          )}
        </section>
      </div>
      </ReviewGate>
    </div>
  );
}
