import { apiRequest, withProfilePhoto } from "@/lib/api";

export type ClientStaffStatus = "pending" | "active" | "suspended";

export const clientStaffRoles = [
  { value: "isp-technician", label: "ISP Technician" },
  { value: "isp-customercare", label: "ISP Customer Care" },
  { value: "isp-manager", label: "ISP Manager" },
] as const;

export type ClientStaffRole = (typeof clientStaffRoles)[number]["value"];

export function clientStaffRoleLabel(role: ClientStaffRole) {
  return clientStaffRoles.find((item) => item.value === role)?.label ?? role;
}

export type ClientStaff = {
  id: string;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  phone: string;
  loginCode: string;
  photoDataUrl: string;
  status: ClientStaffStatus;
  role: ClientStaffRole | null;
  createdAt: string | null;
};

export type ClientStaffInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  loginCode: string;
  password: string;
  photoDataUrl: string;
};

export async function listClientStaff(): Promise<ClientStaff[]> {
  const body = await apiRequest<{ staff: ClientStaff[] }>("/api/client/staff");
  return body.staff.map(withProfilePhoto);
}

export async function createClientStaff(input: ClientStaffInput): Promise<ClientStaff> {
  const body = await apiRequest<{ staff: ClientStaff }>("/api/client/staff", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return withProfilePhoto(body.staff);
}

export async function updateClientStaff(id: string, input: ClientStaffInput): Promise<ClientStaff> {
  const body = await apiRequest<{ staff: ClientStaff }>(`/api/client/staff/${id}/update`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return withProfilePhoto(body.staff);
}

export async function approveClientStaff(id: string, role: ClientStaffRole): Promise<ClientStaff> {
  const body = await apiRequest<{ staff: ClientStaff }>(`/api/client/staff/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
  return withProfilePhoto(body.staff);
}

export async function changeClientStaff(id: string, action: "suspend" | "unsuspend"): Promise<ClientStaff> {
  const body = await apiRequest<{ staff: ClientStaff }>(`/api/client/staff/${id}/${action}`, {
    method: "POST",
    body: "{}",
  });
  return withProfilePhoto(body.staff);
}

export async function removeClientStaff(id: string): Promise<void> {
  await apiRequest(`/api/client/staff/${id}/remove`, { method: "POST", body: "{}" });
}
