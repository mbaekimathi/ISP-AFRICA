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

export type StaffPerformanceDay = {
  date: string;
  logins: string[];
  firstLogin: string | null;
  sessions: number;
  minutesInSession: number;
  minutesLate: number;
  live: boolean;
};

export type PerformanceWorkday = { start: string; end: string };

export type TicketStageTargets = { new: number; onboarding: number; pendingActivation: number; fault: number };

export type PerformanceSettings = { workday: PerformanceWorkday; stages: TicketStageTargets };

export async function performanceSettings(): Promise<PerformanceSettings> {
  return apiRequest<PerformanceSettings>("/api/client/performance-settings");
}

export async function savePerformanceSettings(input: PerformanceSettings): Promise<PerformanceSettings> {
  return apiRequest<PerformanceSettings>("/api/client/performance-settings", {
    method: "POST",
    body: JSON.stringify({
      dayStart: input.workday.start,
      dayEnd: input.workday.end,
      stages: input.stages,
    }),
  });
}

export type StaffPerformanceTicket = {
  id: string;
  kind: string;
  status: string;
  clientName: string;
  createdAt: string;
  stageMinutes: { new: number | null; onboarding: number | null; pendingActivation: number | null; fault: number | null };
  breached: boolean;
};

export type StaffPerformance = {
  range: { from: string; to: string };
  workday: PerformanceWorkday;
  stages: TicketStageTargets;
  days: StaffPerformanceDay[];
  tickets: { attended: number; byStatus: Record<string, number>; items: StaffPerformanceTicket[] };
};

export async function staffPerformance(id: string, from: string, to: string): Promise<StaffPerformance> {
  return apiRequest(`/api/client/staff/${id}/performance?from=${from}&to=${to}`);
}
