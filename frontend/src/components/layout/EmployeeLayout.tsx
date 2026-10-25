import { Globe, Menu, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { SessionMenu } from "@/components/layout/SessionMenu";
import { SecondaryButton } from "@/components/ui/Buttons";
import { LiveClock } from "@/components/ui/LiveClock";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { employeeHomePath, employeePage, employeeRoleLabel } from "@/lib/employees";
import { clientHomePath } from "@/lib/accounts";
import { activePortal } from "@/lib/portal";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

const authPaths = new Set(["/employee/login", "/employee/signup", "/employee/account"]);

const companyLinks = [
  { label: "Profile", to: "/employee/company-settings/profile" },
  { label: "Packages", to: "/employee/company-settings/packages" },
  { label: "Payments", to: "/employee/company-settings/payments" },
  { label: "Communications", to: "/employee/company-settings/communications" },
  { label: "Adverts", to: "/employee/company-settings/adverts" },
];

const companyAdvertsLinks = [
  { label: "Adverts", to: "/employee/company-settings/adverts" },
];

const companyProfileLinks = [
  { label: "Profile", to: "/employee/company-settings/profile/profile" },
  { label: "Theme", to: "/employee/company-settings/profile/theme" },
];

const companyNotificationLinks = [
  { label: "Notifications", to: "/employee/company-settings/notifications" },
  { label: "Settings", to: "/employee/company-settings/notifications/settings" },
];

const companyCommunicationsLinks = [
  { label: "Notifications", to: "/employee/company-settings/notifications/settings" },
];

const dashboardLinks = [
  { label: "ISP clients", to: "/dashboard" },
  { label: "Billings", to: "/employee/company-settings/billings" },
];

const billingsLinks = [
  { label: "Billings", to: "/employee/company-settings/billings" },
  { label: "Gateway billings", to: "/employee/company-settings/billings/gateway" },
  { label: "Transaction charges", to: "/employee/company-settings/billings/gateway/charges" },
];

const companyPaymentsLinks = [
  { label: "Payments", to: "/employee/company-settings/payments" },
  { label: "Transaction charges", to: "/employee/company-settings/billings/gateway/charges" },
];

function employeeSidebarItems(pathname: string, director: boolean) {
  const path = pathname.replace(/^\/employee/, "").replace(/^\/[a-z-]+\/[A-Z0-9]+/, "");
  if (path === "/dashboard") return director ? dashboardLinks : [];
  if (path.startsWith("/company-settings/billings")) return billingsLinks;
  if (path === "/company-settings/payments") return companyPaymentsLinks;
  if (path.startsWith("/company-settings/notifications")) return companyNotificationLinks;
  if (path === "/company-settings/communications") return companyCommunicationsLinks;
  if (path === "/company-settings/adverts") return companyAdvertsLinks;
  if (path === "/company-settings") return companyLinks;
  if (path === "/company-settings/profile") return companyProfileLinks;
  return [];
}

export function EmployeeLayout() {
  const { user, ready: clientReady } = useAuth();
  const { employee, ready, logout, resume } = useEmployeeAuth();
  const location = useLocation();
  const [restoring, setRestoring] = useState(() => !authPaths.has(location.pathname) && activePortal() === "client");
  const restoreOnce = useRef(restoring);
  const showSidebar = !authPaths.has(location.pathname);
  const openPath = location.pathname === "/employee/login" || location.pathname === "/employee/signup";
  const roleLabel = employee?.role ? employeeRoleLabel(employee.role) : null;
  const identity = roleLabel ?? (employee ? `${employee.firstName} ${employee.lastName}` : "Employees");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!restoreOnce.current) return;
    restoreOnce.current = false;
    let cancelled = false;
    resume().finally(() => {
      if (!cancelled) setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, [resume]);

  if (!openPath && (!ready || !clientReady || restoring)) {
    return <LiveLoad label="Loading account" />;
  }

  if (!openPath && ready && clientReady && !employee) {
    return <Navigate to={user ? clientHomePath(user) : "/employee/login"} replace />;
  }

  if (!openPath && employee?.role && employee.dashboardCode) {
    const base = `/${employee.role}/${employee.dashboardCode}`;
    if (location.pathname !== base && !location.pathname.startsWith(`${base}/`)) {
      let rest = location.pathname.replace(/^\/employee(?:\/[A-Z0-9]+)?/, "");
      rest = rest.replace(/^\/[a-z-]+\/[A-Z0-9]+/, "");
      if (!rest.startsWith("/")) rest = `/${rest}`;
      if (rest === "/") rest = "/dashboard";
      return <Navigate to={`${base}${rest}`} replace />;
    }
  }

  return (
    <div className="employee-theme flex min-h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      {showSidebar && sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-[var(--overlay)] backdrop-blur-sm lg:hidden"
          aria-label="Close menu"
          onClick={closeSidebar}
        />
      ) : null}
      {showSidebar ? (
      <AppSidebar
        label={identity}
        homeTo="/employee/login"
        variant="employee"
        items={employeeSidebarItems(location.pathname, employee?.role === "director").map((item) => ({
          ...item,
          to: employee ? employeePage(employee, item.to.replace(/^\/employee/, "")) : item.to,
        }))}
        open={sidebarOpen}
        onClose={closeSidebar}
        dashboardTo={employee ? employeeHomePath(employee) : "/employee/dashboard"}
        settingsTo={employee ? employeePage(employee, "/company-settings") : "/employee/company-settings"}
        settingsLabel="Company settings"
        notifyTo={employee ? employeePage(employee, "/company-settings/notifications") : "/employee/company-settings/notifications"}
        signOutTo="/employee/login"
        onSignOut={logout}
        profile={
          employee
            ? {
                name: `${employee.firstName} ${employee.lastName}`,
                role: roleLabel ?? undefined,
                phone: employee.phone,
                detail: employee.email,
                accountNumber: employee.employeeCode ?? undefined,
                photoUrl: employee.photoDataUrl,
              }
            : null
        }
      />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-50 border-b border-border/80 bg-surface/80 shadow-header backdrop-blur-md">
        <div className="app-bar">
          {showSidebar ? (
          <button
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground shadow-xs transition duration-fast ease-out hover:bg-surface lg:hidden"
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          ) : null}
          <Link to="/employee/login" className={showSidebar ? "rounded-md lg:hidden" : "rounded-md"} aria-label="ISP CENTRIC employees">
            <Logo variant="employee" />
          </Link>
          <span className="hidden items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-accent sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            Staff console
          </span>
          <LiveClock />
          <nav className="ml-auto flex items-center gap-2 border-l border-border pl-3 max-sm:border-l-0 max-sm:pl-0" aria-label={identity}>
            <NotificationBell
              feedPath="/api/employee/company/notifications/feed"
              to={employee ? employeePage(employee, "/company-settings/notifications") : "/employee/company-settings/notifications"}
              enabled={Boolean(employee)}
            />
            <ThemeToggle />
            {employee ? (
              <SessionMenu
                name={`${employee.firstName} ${employee.lastName}`}
                role={roleLabel ?? undefined}
                phone={employee.phone}
                detail={employee.email}
                accountNumber={employee.employeeCode ?? undefined}
                photoUrl={employee.photoDataUrl}
                dashboardTo={employeeHomePath(employee)}
                profileTo={employeePage(employee, "/account")}
                signOutTo="/employee/login"
                onSignOut={logout}
              />
            ) : (
              <div className="hidden sm:block">
                <SecondaryButton to="/employee/login">Employee login</SecondaryButton>
              </div>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <footer className="mt-auto border-t border-border bg-surface">
        <div className="app-footer">
          <p>© {new Date().getFullYear()} ISP CENTRIC</p>
          <nav aria-label="Employee footer" className="flex flex-wrap gap-x-4 gap-y-1">
            <Link
              className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
              to={employee ? employeePage(employee, "/reviews") : "/employee/reviews"}
            >
              <Users className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
              Roles
            </Link>
            <Link className="inline-flex items-center gap-1.5 text-foreground hover:text-primary" to="/">
              <Globe className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
              Public site
            </Link>
          </nav>
        </div>
        </footer>
      </div>
    </div>
  );
}
