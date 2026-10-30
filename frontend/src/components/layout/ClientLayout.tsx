import { ArrowLeft, Globe, Menu, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { SessionMenu } from "@/components/layout/SessionMenu";
import { LiveClock } from "@/components/ui/LiveClock";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { clientPage } from "@/lib/accounts";
import { apiRequest } from "@/lib/api";
import { employeeHomePath, readEmployeeSession, type PublicEmployee } from "@/lib/employees";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

const CODE_SEGMENT = /^\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}(?=\/|$)/;
const STAFF_ROLE_SEGMENT = /^\/isp-(?:technician|customercare|manager)(?=\/|$)/;

const sectionLinks = [
  { label: "Mikrotiks", to: "/mikrotiks" },
  { label: "Clients", to: "/clients" },
  { label: "Billings", to: "/billings" },
  { label: "HR", to: "/hr" },
];

const mikrotikLinks = [
  { label: "Onboard Mikrotik", to: "/mikrotiks/onboard" },
  { label: "Import Clients", to: "/mikrotiks/import-clients" },
];

const settingsLinks = [
  { label: "Company", to: "/account/settings/isp-company" },
  { label: "Packages", to: "/account/settings/isp-package" },
  { label: "Payments", to: "/account/settings/isp-payments" },
  { label: "Communications", to: "/account/settings/isp-communications" },
];

const advertsLink = { label: "Adverts", to: "/account/settings/isp-adverts" };

const advertLinks = [
  { label: "Adverts", to: "/account/settings/isp-adverts" },
];

const ispCompanyLinks = [
  { label: "Company", to: "/account/settings/isp-company/company" },
  { label: "Theme", to: "/account/settings/isp-company/theme" },
];

const notificationLinks = [
  { label: "Notifications", to: "/account/settings/isp-notifications" },
  { label: "Settings", to: "/account/settings/isp-notifications/settings" },
];

const communicationsLinks = [
  { label: "Notifications", to: "/account/settings/isp-notifications/settings" },
];

const hrLinks = [
  { label: "Employees", to: "/hr" },
  { label: "Pending approvals", to: "/hr/pending" },
  { label: "Add employee", to: "/hr?add=1" },
];

const technicianLinks = [
  { label: "Tickets", to: "/tickets" },
  { label: "New client onboarding", to: "/onboard" },
  { label: "Materials", to: "/materials" },
  { label: "My account", to: "/account" },
];

const onboardLinks = [{ label: "Onboard client", to: "/onboard?add=1" }];

const ticketLinks = [
  { label: "New tickets", to: "/tickets?tab=new", status: "new" },
  { label: "Onboarding", to: "/tickets?tab=onboarding", status: "onboarding" },
  { label: "Pending activation", to: "/tickets?tab=pending", status: "pending_activation" },
  { label: "Completed", to: "/tickets?tab=completed", status: "" },
  { label: "Faulty tickets", to: "/faulty", status: "" },
];

const customercareLinks = [
  { label: "Tickets", to: "/tickets" },
  { label: "Clients", to: "/clients" },
];


const customerClientLinks = [
  { label: "PPPoE clients", to: "/clients" },
  { label: "Hotspot clients", to: "/clients/hotspot" },
];

const createTicketLinks = [{ label: "Create ticket", to: "/tickets?add=1" }];

function pagePath(pathname: string, code: string | null | undefined) {
  const stripped = pathname.replace(STAFF_ROLE_SEGMENT, "");
  if (!code) return stripped;
  const base = `/${code}`;
  if (stripped === base || stripped.startsWith(`${base}/`)) return stripped.slice(base.length) || "/";
  return stripped;
}

function linksForPage(pathname: string, advertsEnabled: boolean) {
  if (pathname === "/dashboard" || pathname.endsWith("/dashboard"))
    return advertsEnabled ? [...sectionLinks, advertsLink] : sectionLinks;
  const router = pathname.match(/^\/mikrotiks\/([^/]+)/);
  if (router && router[1] !== "onboard" && router[1] !== "import-clients") {
    const id = router[1];
    return [
      { label: "Live", to: `/mikrotiks/${id}` },
      { label: "Port setup", to: `/mikrotiks/${id}/ports` },
      { label: "PPPoE setup", to: `/mikrotiks/${id}/pppoe` },
      { label: "Hotspot setup", to: `/mikrotiks/${id}/hotspot` },
      { label: "MikroTik setup", to: `/mikrotiks/${id}/setup` },
      { label: "WinBox recovery", to: `/mikrotiks/${id}/recovery` },
    ];
  }
  if (
    pathname === "/mikrotiks" ||
    pathname === "/mikrotiks/onboard" ||
    pathname === "/mikrotiks/import-clients" ||
    pathname.endsWith("/mikrotiks")
  )
    return mikrotikLinks;
  const subscriber = pathname.match(/^\/pppoe\/([^/]+)/);
  if (subscriber && subscriber[1] !== "register") {
    const id = subscriber[1];
    return [
      { label: "Client payments", to: `/pppoe/${id}/transactions` },
      { label: "Client usage", to: `/pppoe/${id}` },
      { label: "Remote access", to: `/pppoe/${id}/remote-access` },
      { label: "All clients", to: "/clients" },
    ];
  }
  const guest = pathname.match(/^\/hotspot\/([^/]+)/);
  if (guest) {
    const id = guest[1];
    return [
      { label: "Client payments", to: "/clients/hotspot/payments" },
      { label: "Client usage", to: `/hotspot/${id}` },
      { label: "All clients", to: "/clients/hotspot" },
    ];
  }
  if (pathname === "/clients" || pathname === "/clients/payments" || pathname === "/clients/usage" || pathname.startsWith("/pppoe")) {
    return [
      { label: "PPPoE-clients", to: "/clients" },
      { label: "PPPoE-payment", to: "/clients/payments" },
      { label: "PPPoE-usage", to: "/clients/usage" },
      { label: "Hotspot-clients", to: "/clients/hotspot" },
      { label: "Import Clients", to: "/mikrotiks/import-clients" },
    ];
  }
  if (pathname === "/clients/hotspot" || pathname === "/clients/hotspot/payments" || pathname === "/clients/hotspot/usage") {
    return [
      { label: "Hotspot-clients", to: "/clients/hotspot" },
      { label: "Hotspot-payment", to: "/clients/hotspot/payments" },
      { label: "Hotspot-usage", to: "/clients/hotspot/usage" },
      { label: "PPPoE-clients", to: "/clients" },
    ];
  }
  if (pathname === "/hr" || pathname === "/hr/pending" || pathname.endsWith("/hr") || pathname.endsWith("/hr/pending")) {
    return hrLinks;
  }
  if (pathname === "/billings" || pathname.endsWith("/billings") || pathname.endsWith("/billings/gateway")) {
    return [
      { label: "Transactions", to: "/billings" },
      { label: "Gateway billings", to: "/billings/gateway" },
      { label: "Packages", to: "/account/settings/isp-package" },
    ];
  }
  if (pathname.startsWith("/account/settings/isp-notifications")) return notificationLinks;
  if (pathname.endsWith("/account/settings/isp-communications")) return communicationsLinks;
  if (pathname.endsWith("/account/settings/isp-adverts")) return advertLinks;
  if (pathname === "/account/settings" || pathname.endsWith("/account/settings"))
    return advertsEnabled ? [...settingsLinks, advertsLink] : settingsLinks;
  if (pathname.endsWith("/account/settings/isp-company")) return ispCompanyLinks;
  return [];
}

export function ClientLayout() {
  const { user, ready, logout } = useAuth();
  const { employee, ready: employeeReady, resume } = useEmployeeAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const [staffSession, setStaffSession] = useState<PublicEmployee | null>(null);
  const [resumingStaff, setResumingStaff] = useState(false);

  useEffect(() => {
    if (!ready || !employeeReady || !user || employee) {
      setStaffSession(null);
      return;
    }
    let cancelled = false;
    readEmployeeSession().then((account) => {
      if (!cancelled) setStaffSession(account);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, employeeReady, user, employee]);

  const returnToStaff = useCallback(() => {
    setResumingStaff(true);
    resume()
      .then((account) => {
        if (account) {
          navigate(employeeHomePath(account));
        } else {
          setStaffSession(null);
        }
      })
      .finally(() => setResumingStaff(false));
  }, [resume, navigate]);
  const staffRole = user?.delegate?.kind === "isp-employee" ? user.delegate.role ?? null : null;
  const isStaff = staffRole !== null;
  const [ticketCounts, setTicketCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (staffRole !== "isp-technician" && staffRole !== "isp-customercare") return;
    apiRequest<{ onboardings: { status: string }[] }>("/api/client/onboardings")
      .then((body) => {
        const counts: Record<string, number> = {};
        for (const row of body.onboardings) counts[row.status] = (counts[row.status] ?? 0) + 1;
        setTicketCounts(counts);
      })
      .catch(() => {});
  }, [staffRole]);
  const page = pagePath(location.pathname, user?.dashboardCode);
  const clientSidebar =
    staffRole === "isp-technician"
      ? (page === "/dashboard"
          ? technicianLinks
          : page === "/onboard"
            ? onboardLinks
            : page === "/tickets"
              ? ticketLinks.map((item) => ({
                    ...item,
                    label: item.status ? `${item.label} (${ticketCounts[item.status] ?? 0})` : item.label,
                  }))
              : []
        ).map((item) => ({
          ...item,
          to: user ? clientPage(user, item.to) : item.to,
        }))
      : staffRole === "isp-customercare"
        ? (page === "/dashboard"
            ? customercareLinks
            : page === "/tickets"
              ? createTicketLinks
              : page.startsWith("/clients")
                ? customerClientLinks
                : []
          ).map((item) => ({ ...item, to: user ? clientPage(user, item.to) : item.to }))
        : isStaff
        ? []
        : linksForPage(page, Boolean(user?.advertsEnabled)).map((item) => ({
            ...item,
            to: user ? clientPage(user, item.to) : item.to,
          }));
  const clientLabel = user?.clientCode ?? (user ? `${user.firstName} ${user.lastName}` : "ISP client");

  if (!ready || !employeeReady) {
    return <LiveLoad />;
  }

  if (employee) {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.dashboardCode) {
    const rolePrefix =
      user.delegate?.kind === "isp-employee" && user.delegate.role ? `/${user.delegate.role}` : "";
    const base = `${rolePrefix}/${user.dashboardCode}`;
    if (location.pathname !== base && !location.pathname.startsWith(`${base}/`)) {
      const legacy = /^\/dashboard\/[^/]+$/.test(location.pathname);
      const stripped = location.pathname.replace(STAFF_ROLE_SEGMENT, "").replace(CODE_SEGMENT, "");
      const rest = legacy ? "/dashboard" : stripped || "/dashboard";
      return <Navigate to={`${base}${rest}`} replace />;
    }
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      {sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-[var(--overlay)] backdrop-blur-sm lg:hidden"
          aria-label="Close menu"
          onClick={closeSidebar}
        />
      ) : null}
      <AppSidebar
        label={clientLabel}
        homeTo={isStaff ? clientPage(user, "/dashboard") : clientPage(user, "/account")}
        items={clientSidebar}
        open={sidebarOpen}
        onClose={closeSidebar}
        dashboardTo={clientPage(user, "/dashboard")}
        settingsTo={isStaff ? undefined : clientPage(user, "/account/settings")}
        notifyTo={isStaff ? undefined : clientPage(user, "/account/settings/isp-notifications")}
        signOutTo="/login"
        onSignOut={logout}
        profile={
          user
            ? {
                name: user.delegate?.name || `${user.firstName} ${user.lastName}`,
                phone: user.delegate ? undefined : user.phone,
                detail: user.delegate ? user.delegate.title : user.email,
                accountNumber: user.clientCode ?? undefined,
                role: user.delegate?.title,
                photoUrl: user.photoDataUrl,
              }
            : null
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-50 border-b border-border/80 bg-surface/80 shadow-header backdrop-blur-md">
          <div className="app-bar">
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground shadow-xs transition duration-fast ease-out hover:bg-surface lg:hidden"
              aria-label="Open menu"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <Link to={clientPage(user, "/account")} className="rounded-md lg:hidden" aria-label={clientLabel}>
              <Logo />
            </Link>
            <LiveClock />
            <div className="ml-auto flex items-center gap-2 border-l border-border pl-3 max-sm:border-l-0 max-sm:pl-0">
              {user.delegate ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-accent"
                  title={`${user.delegate.title} — owner-only settings stay locked`}
                >
                  <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {user.delegate.name ? `${user.delegate.name} · staff` : "Staff view"}
                  </span>
                </span>
              ) : null}
              {staffSession ? (
                <button
                  type="button"
                  onClick={returnToStaff}
                  disabled={resumingStaff}
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-accent transition duration-fast ease-out hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  title={`Back to staff console — ${staffSession.firstName} ${staffSession.lastName}`}
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Staff console</span>
                </button>
              ) : null}
              <NotificationBell
                feedPath="/api/notifications/feed"
                to={clientPage(user, "/account/settings/isp-notifications")}
                enabled={Boolean(user)}
              />
              <ThemeToggle />
              {user ? (
                <SessionMenu
                  name={user.delegate?.name || `${user.firstName} ${user.lastName}`}
                  phone={user.delegate ? undefined : user.phone}
                  detail={user.delegate ? user.delegate.title : user.email}
                  accountNumber={user.clientCode ?? undefined}
                  role={user.delegate?.title}
                  photoUrl={user.photoDataUrl}
                  dashboardTo={clientPage(user, "/dashboard")}
                  profileTo={isStaff ? undefined : clientPage(user, "/account")}
                  signOutTo="/login"
                  onSignOut={logout}
                />
              ) : null}
            </div>
          </div>
        </header>
        <main id="main" className="flex-1">
          <Outlet />
        </main>
        <footer className="mt-auto border-t border-border bg-surface">
          <div className="app-footer">
            <p>© {new Date().getFullYear()} ISP CENTRIC</p>
            <nav aria-label="Account footer" className="flex flex-wrap gap-x-4 gap-y-1">
              <Link
                className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
                to={clientPage(user, "/account")}
              >
                <UserRound className="h-3.5 w-3.5 text-indigo-500" aria-hidden="true" />
                Account
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
