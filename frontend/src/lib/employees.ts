import { apiRequest, withProfilePhoto } from "@/lib/api";

export const employeeRoles = [
  { value: "director", label: "Director" },
  { value: "supervisor", label: "Supervisor" },
  { value: "customer-care", label: "Customer Care" },
  { value: "technician", label: "Technician" },
  { value: "it-support", label: "IT Support" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "sales", label: "Sales" },
] as const;

export type EmployeeRole = (typeof employeeRoles)[number]["value"];
export type EmployeeStatus = "pending" | "approved";
export type ReviewerAccess = "bootstrap" | "allowed" | "denied";

export type EmployeeInput = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  loginCode: string;
  password: string;
  photoDataUrl: string;
};

export type PublicEmployee = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  loginCode: string;
  photoDataUrl: string;
  status: EmployeeStatus;
  employeeCode: string | null;
  dashboardCode: string | null;
  role: EmployeeRole | null;
};

export function employeeRoleLabel(role: EmployeeRole) {
  return employeeRoles.find((item) => item.value === role)?.label ?? role;
}

export function employeePage(employee: Pick<PublicEmployee, "dashboardCode" | "role">, path: string) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (employee.role && employee.dashboardCode) {
    return `/${employee.role}/${employee.dashboardCode}${suffix}`;
  }
  return `/employee${suffix}`;
}

export function employeeHomePath(employee: Pick<PublicEmployee, "dashboardCode" | "role">) {
  return employeePage(employee, "/dashboard");
}

export async function readEmployeeSession(): Promise<PublicEmployee | null> {
  try {
    const body = await apiRequest<{ employee: PublicEmployee | null }>("/api/employee/session");
    return body.employee ? withProfilePhoto(body.employee) : null;
  } catch {
    return null;
  }
}

export async function reviewerAccess(): Promise<ReviewerAccess> {
  try {
    const body = await apiRequest<{ access: ReviewerAccess }>("/api/employee/access");
    return body.access;
  } catch {
    return "denied";
  }
}

export async function registerEmployee(input: EmployeeInput): Promise<PublicEmployee> {
  const body = await apiRequest<{ employee: PublicEmployee }>("/api/employee/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return withProfilePhoto(body.employee);
}

export async function updateEmployeeProfile(input: EmployeeInput): Promise<PublicEmployee> {
  const body = await apiRequest<{ employee: PublicEmployee }>("/api/employee/profile", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return withProfilePhoto(body.employee);
}

export async function loginEmployee(loginCode: string, password: string): Promise<PublicEmployee> {
  const body = await apiRequest<{ employee: PublicEmployee }>("/api/employee/login", {
    method: "POST",
    body: JSON.stringify({ loginCode, password }),
  });
  return withProfilePhoto(body.employee);
}

export async function listEmployeesForReview(): Promise<PublicEmployee[]> {
  const body = await apiRequest<{ employees: PublicEmployee[] }>("/api/employee/reviews");
  return body.employees.map(withProfilePhoto);
}

export async function approveEmployee(id: string): Promise<PublicEmployee> {
  const body = await apiRequest<{ employee: PublicEmployee }>("/api/employee/approve", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return withProfilePhoto(body.employee);
}

export async function allocateEmployeeRole(id: string, role: EmployeeRole): Promise<PublicEmployee> {
  const body = await apiRequest<{ employee: PublicEmployee }>("/api/employee/role", {
    method: "POST",
    body: JSON.stringify({ id, role }),
  });
  return withProfilePhoto(body.employee);
}

export async function logoutEmployee() {
  await apiRequest("/api/employee/logout", { method: "POST", body: "{}" });
}
