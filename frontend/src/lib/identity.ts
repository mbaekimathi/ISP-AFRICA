const CLIENT_ACCOUNTS_KEY = "isp-centric-accounts";
const EMPLOYEE_ACCOUNTS_KEY = "isp-centric-employees";

type IdentityRecord = {
  username?: string;
  email?: string;
  phone?: string;
  loginCode?: string;
};

export function phoneDigits(value: string) {
  return value.replace(/\D/g, "");
}

function readIdentities(key: string): IdentityRecord[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as IdentityRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function assertNotUsedByOtherPortal(
  fields: { username: string; email: string; phone: string; loginCode: string },
  portal: "client" | "employee",
) {
  const otherLabel = portal === "client" ? "employee" : "ISP client";
  const records = readIdentities(portal === "client" ? EMPLOYEE_ACCOUNTS_KEY : CLIENT_ACCOUNTS_KEY);
  const username = fields.username.trim().toLowerCase();
  const email = fields.email.trim().toLowerCase();
  const phone = phoneDigits(fields.phone);
  const loginCode = fields.loginCode.trim();

  if (records.some((record) => record.username?.trim().toLowerCase() === username)) {
    throw new Error(`That username is already used by an ${otherLabel} account.`);
  }
  if (records.some((record) => record.email?.trim().toLowerCase() === email)) {
    throw new Error(`That email is already used by an ${otherLabel} account.`);
  }
  if (phone && records.some((record) => phoneDigits(record.phone ?? "") === phone)) {
    throw new Error(`That phone number is already used by an ${otherLabel} account.`);
  }
  if (records.some((record) => record.loginCode?.trim() === loginCode)) {
    throw new Error(`That login code is already used by an ${otherLabel} account.`);
  }
}
