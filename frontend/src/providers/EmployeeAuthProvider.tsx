import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  allocateEmployeeRole,
  approveEmployee,
  loginEmployee,
  logoutEmployee,
  readEmployeeSession,
  registerEmployee,
  updateEmployeeProfile,
  type EmployeeInput,
  type EmployeeRole,
  type PublicEmployee,
} from "@/lib/employees";
import { logoutAccount } from "@/lib/accounts";
import { activePortal, clearActivePortal, rememberPortal } from "@/lib/portal";

type EmployeeAuthValue = {
  employee: PublicEmployee | null;
  ready: boolean;
  register: (input: EmployeeInput) => Promise<void>;
  login: (loginCode: string, password: string) => Promise<PublicEmployee>;
  approve: (id: string) => Promise<void>;
  allocateRole: (id: string, role: EmployeeRole) => Promise<void>;
  saveProfile: (input: EmployeeInput) => Promise<void>;
  resume: () => Promise<PublicEmployee | null>;
  logout: () => Promise<void>;
};

const EmployeeAuthContext = createContext<EmployeeAuthValue | null>(null);

export function EmployeeAuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<PublicEmployee | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      readEmployeeSession().then((account) => {
        if (cancelled || activePortal() === "client") return;
        setEmployee(account);
      });
    };
    readEmployeeSession().then((account) => {
      if (cancelled) return;
      setEmployee(activePortal() === "client" ? null : account);
      setReady(true);
    });
    const onPortal = (event: Event) => {
      const portal = (event as CustomEvent).detail;
      if (portal === "client" || portal === "signed-out") setEmployee(null);
    };
    window.addEventListener("focus", sync);
    window.addEventListener("isp-active-account", onPortal);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", sync);
      window.removeEventListener("isp-active-account", onPortal);
    };
  }, []);

  const register = useCallback(async (input: EmployeeInput) => {
    await registerEmployee(input);
  }, []);

  const login = useCallback(async (loginCode: string, password: string) => {
    await logoutAccount();
    rememberPortal("employee");
    const account = await loginEmployee(loginCode, password);
    setEmployee(account);
    return account;
  }, []);

  const approve = useCallback(async (id: string) => {
    await approveEmployee(id);
    setEmployee(await readEmployeeSession());
  }, []);

  const allocateRole = useCallback(async (id: string, role: EmployeeRole) => {
    await allocateEmployeeRole(id, role);
    setEmployee(await readEmployeeSession());
  }, []);

  const saveProfile = useCallback(async (input: EmployeeInput) => {
    setEmployee(await updateEmployeeProfile(input));
  }, []);

  const resume = useCallback(async () => {
    const account = await readEmployeeSession();
    if (!account) return null;
    rememberPortal("employee");
    setEmployee(account);
    return account;
  }, []);

  const logout = useCallback(async () => {
    await logoutEmployee();
    await logoutAccount();
    clearActivePortal();
    setEmployee(null);
  }, []);

  const value = useMemo(
    () => ({ employee, ready, register, login, approve, allocateRole, saveProfile, resume, logout }),
    [employee, ready, register, login, approve, allocateRole, saveProfile, resume, logout],
  );

  return <EmployeeAuthContext.Provider value={value}>{children}</EmployeeAuthContext.Provider>;
}

export function useEmployeeAuth() {
  const context = useContext(EmployeeAuthContext);
  if (!context) {
    throw new Error("useEmployeeAuth must be used within EmployeeAuthProvider");
  }
  return context;
}
