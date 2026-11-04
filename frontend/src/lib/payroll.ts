import { apiRequest, withProfilePhoto } from "@/lib/api";
import type { ClientStaff } from "@/lib/clientStaff";

export type PayCycle = "weekly" | "biweekly" | "monthly";
export type PayMethod = "mpesa" | "bank" | "cash";
export type PayrollKind = "salary" | "bonus" | "loan" | "advance" | "repayment" | "deduction";

export const payCycles: { value: PayCycle; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
];

export const payMethods: { value: PayMethod; label: string }[] = [
  { value: "mpesa", label: "M-Pesa" },
  { value: "bank", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
];

export const payrollKinds: { value: PayrollKind; label: string; out: boolean }[] = [
  { value: "salary", label: "Salary payment", out: true },
  { value: "bonus", label: "Bonus", out: true },
  { value: "loan", label: "Loan", out: true },
  { value: "advance", label: "Salary advance", out: true },
  { value: "repayment", label: "Loan repayment", out: false },
  { value: "deduction", label: "Deduction", out: false },
];

export function payrollKindLabel(kind: PayrollKind) {
  return payrollKinds.find((item) => item.value === kind)?.label ?? kind;
}

export function payMethodLabel(method: PayMethod) {
  return payMethods.find((item) => item.value === method)?.label ?? method;
}

export function payCycleLabel(cycle: PayCycle) {
  return payCycles.find((item) => item.value === cycle)?.label ?? cycle;
}

export type PayrollAccount = {
  id: string;
  staffId: string;
  employeeNo: string;
  baseSalary: number;
  payCycle: PayCycle;
  payMethod: PayMethod;
  mpesaPhone: string;
  bankName: string;
  bankBranch: string;
  bankAccount: string;
  nationalId: string;
  kraPin: string;
  notes: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PayrollSummary = {
  paidOut: number;
  paidMonth: number;
  deducted: number;
  outstanding: number;
};

export type PayrollEmployee = {
  staff: ClientStaff;
  account: PayrollAccount | null;
  summary: PayrollSummary;
};

export type PayrollTransaction = {
  id: string;
  staffId: string;
  kind: PayrollKind;
  amount: number;
  period: string;
  method: PayMethod;
  reference: string;
  notes: string;
  createdAt: string | null;
};

export type PayrollAccountView = PayrollEmployee & {
  transactions: PayrollTransaction[];
};

export type PayrollAccountInput = {
  employeeNo: string;
  baseSalary: number;
  payCycle: PayCycle;
  payMethod: PayMethod;
  mpesaPhone: string;
  bankName: string;
  bankBranch: string;
  bankAccount: string;
  nationalId: string;
  kraPin: string;
  notes: string;
};

export type PayrollTransactionInput = {
  kind: PayrollKind;
  amount: number;
  period: string;
  method: PayMethod;
  reference: string;
  notes: string;
};

function cleanEntry(entry: PayrollEmployee): PayrollEmployee {
  return { ...entry, staff: withProfilePhoto(entry.staff) };
}

export async function listPayroll(): Promise<PayrollEmployee[]> {
  const body = await apiRequest<{ employees: PayrollEmployee[] }>("/api/client/payroll");
  return body.employees.map(cleanEntry);
}

export async function payrollAccount(staffId: string): Promise<PayrollAccountView> {
  const body = await apiRequest<PayrollAccountView>(`/api/client/payroll/${staffId}`);
  return { ...body, staff: withProfilePhoto(body.staff) };
}

export async function savePayrollAccount(staffId: string, input: PayrollAccountInput): Promise<PayrollEmployee> {
  const body = await apiRequest<PayrollEmployee>(`/api/client/payroll/${staffId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return cleanEntry(body);
}

export async function addPayrollTransaction(
  staffId: string,
  input: PayrollTransactionInput,
): Promise<PayrollAccountView> {
  const body = await apiRequest<PayrollAccountView>(`/api/client/payroll/${staffId}/transactions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { ...body, staff: withProfilePhoto(body.staff) };
}

export async function removePayrollTransaction(staffId: string, txId: string): Promise<PayrollAccountView> {
  const body = await apiRequest<PayrollAccountView>(`/api/client/payroll/${staffId}/transactions/${txId}/remove`, {
    method: "POST",
    body: "{}",
  });
  return { ...body, staff: withProfilePhoto(body.staff) };
}

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 0 }).format(amount);
}
