import { Navigate, useLocation } from "react-router-dom";
import { PageHeader } from "@/components/ui/DetailGrid";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { usePageMeta } from "@/hooks/usePageMeta";
import { employeeHomePath, employeeRoleLabel } from "@/lib/employees";
import { IspClientsPage } from "@/pages/employee/IspClientsPage";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

export function EmployeeDashboardPage() {
  const { employee, ready } = useEmployeeAuth();
  const location = useLocation();
  const title = employee?.role ? `${employeeRoleLabel(employee.role)} dashboard` : "Dashboard";
  usePageMeta(`${title} — ISP CENTRIC`, `${title} for the signed-in employee.`);

  if (!ready) {
    return <LiveLoad label="Loading dashboard" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  const home = employeeHomePath(employee);
  if (location.pathname !== home) {
    return <Navigate to={home} replace />;
  }

  if (employee.role === "director") {
    return <IspClientsPage />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title={title} />
    </div>
  );
}
