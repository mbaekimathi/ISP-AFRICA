import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { approveAccount, enterClientPortal, loginWithCode, logoutAccount, readSession, registerAccount, updateAccountProfile, type AccountInput, type PublicAccount } from "@/lib/accounts";
import { logoutEmployee } from "@/lib/employees";
import { activePortal, clearActivePortal, rememberPortal } from "@/lib/portal";

type AuthContextValue = {
  user: PublicAccount | null;
  ready: boolean;
  register: (input: AccountInput) => Promise<void>;
  login: (loginCode: string, password: string) => Promise<PublicAccount>;
  approve: (id: string) => Promise<void>;
  openAsClient: (id: string) => Promise<PublicAccount>;
  saveProfile: (input: AccountInput) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicAccount | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      readSession().then((account) => {
        if (cancelled || activePortal() === "employee") return;
        setUser((current) =>
          JSON.stringify(current) === JSON.stringify(account) ? current : account,
        );
      });
    };
    readSession().then((account) => {
      if (cancelled) return;
      setUser(activePortal() === "employee" ? null : account);
      setReady(true);
    });
    const onPortal = (event: Event) => {
      const portal = (event as CustomEvent).detail;
      if (portal === "employee" || portal === "signed-out") setUser(null);
    };
    window.addEventListener("focus", sync);
    window.addEventListener("isp-active-account", onPortal);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", sync);
      window.removeEventListener("isp-active-account", onPortal);
    };
  }, []);

  const register = useCallback(async (input: AccountInput) => {
    await registerAccount(input);
  }, []);

  const login = useCallback(async (loginCode: string, password: string) => {
    await logoutEmployee();
    rememberPortal("client");
    const account = await loginWithCode(loginCode, password);
    setUser(account);
    return account;
  }, []);

  const approve = useCallback(async (id: string) => {
    await approveAccount(id);
    setUser(await readSession());
  }, []);

  const openAsClient = useCallback(async (id: string) => {
    const account = await enterClientPortal(id);
    rememberPortal("client");
    setUser(account);
    return account;
  }, []);

  const saveProfile = useCallback(async (input: AccountInput) => {
    setUser(await updateAccountProfile(input));
  }, []);

  const logout = useCallback(async () => {
    await logoutAccount();
    await logoutEmployee();
    clearActivePortal();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, register, login, approve, openAsClient, saveProfile, logout }),
    [user, ready, register, login, approve, openAsClient, saveProfile, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
