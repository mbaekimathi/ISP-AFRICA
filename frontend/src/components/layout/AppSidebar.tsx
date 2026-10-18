import {
  ArrowLeft,
  Banknote,
  BarChart3,
  Bell,
  Building2,
  CirclePlus,
  CreditCard,
  Gauge,
  Import,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  Network,
  Package,
  Palette,
  Radio,
  Receipt,
  Router,
  Settings,
  SlidersHorizontal,
  UserRound,
  Users,
  Wifi,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LogoMark } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

export type SidebarItem = {
  label: string;
  to: string;
};

const ITEM_ICONS: Record<string, { icon: LucideIcon; chip: string }> = {
  Mikrotiks: { icon: Router, chip: "bg-sky-500/15 text-sky-400" },
  "Onboard Mikrotik": { icon: CirclePlus, chip: "bg-sky-500/15 text-sky-400" },
  Clients: { icon: Users, chip: "bg-emerald-500/15 text-emerald-400" },
  "Import Clients": { icon: Import, chip: "bg-emerald-500/15 text-emerald-400" },
  "ISP clients": { icon: Users, chip: "bg-emerald-500/15 text-emerald-400" },
  Billings: { icon: Receipt, chip: "bg-amber-500/15 text-amber-400" },
  "Gateway billings": { icon: CreditCard, chip: "bg-amber-500/15 text-amber-400" },
  Company: { icon: Building2, chip: "bg-indigo-500/15 text-indigo-400" },
  Profile: { icon: UserRound, chip: "bg-indigo-500/15 text-indigo-400" },
  Theme: { icon: Palette, chip: "bg-fuchsia-500/15 text-fuchsia-400" },
  Packages: { icon: Package, chip: "bg-cyan-500/15 text-cyan-400" },
  Payments: { icon: CreditCard, chip: "bg-green-500/15 text-green-400" },
  Communications: { icon: MessageSquare, chip: "bg-blue-500/15 text-blue-400" },
  Notifications: { icon: Bell, chip: "bg-amber-500/15 text-amber-400" },
  Settings: { icon: SlidersHorizontal, chip: "bg-slate-500/20 text-slate-300" },
  Live: { icon: Radio, chip: "bg-rose-500/15 text-rose-400" },
  "Port setup": { icon: Network, chip: "bg-cyan-500/15 text-cyan-400" },
  "PPPoE setup": { icon: KeyRound, chip: "bg-amber-500/15 text-amber-400" },
  "Hotspot setup": { icon: Wifi, chip: "bg-sky-500/15 text-sky-400" },
  "MikroTik setup": { icon: Wrench, chip: "bg-orange-500/15 text-orange-400" },
  "WinBox recovery": { icon: LifeBuoy, chip: "bg-rose-500/15 text-rose-400" },
  "PPPoE-clients": { icon: Users, chip: "bg-emerald-500/15 text-emerald-400" },
  "PPPoE-payment": { icon: Banknote, chip: "bg-green-500/15 text-green-400" },
  "PPPoE-usage": { icon: Gauge, chip: "bg-violet-500/15 text-violet-400" },
  "Remote access": { icon: MonitorSmartphone, chip: "bg-teal-500/15 text-teal-400" },
  "Hotspot-clients": { icon: Wifi, chip: "bg-sky-500/15 text-sky-400" },
  "Hotspot-payment": { icon: Banknote, chip: "bg-green-500/15 text-green-400" },
  "Hotspot-usage": { icon: BarChart3, chip: "bg-violet-500/15 text-violet-400" },
};

const FALLBACK_ICON = { icon: LayoutDashboard, chip: "bg-sidebar-active text-sidebar-accent" };

function LinkIcon({ icon: Icon, chip }: { icon: LucideIcon; chip: string }) {
  return (
    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", chip)} aria-hidden="true">
      <Icon className="h-4 w-4" />
    </span>
  );
}

type AppSidebarProps = {
  label: string;
  homeTo: string;
  variant?: "client" | "employee";
  items: readonly SidebarItem[];
  open: boolean;
  onClose: () => void;
  dashboardTo: string;
  settingsTo: string;
  settingsLabel?: string;
  notifyTo?: string;
  notifyLabel?: string;
  signOutTo: string;
  onSignOut: () => Promise<void> | void;
  profile?: {
    name: string;
    detail: string;
    phone?: string;
    accountNumber?: string;
    role?: string;
    photoUrl: string;
  } | null;
};

function isCurrent(to: string, pathname: string, hash: string) {
  if (to.startsWith("/#")) {
    if (pathname !== "/") return false;
    if (to === "/#top") return hash === "" || hash === "#top";
    return hash === to.slice(1);
  }
  return pathname === to;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-1.5 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-sidebar-muted/80">
      {children}
    </p>
  );
}

export function AppSidebar({
  label,
  homeTo,
  variant = "client",
  items,
  open,
  onClose,
  dashboardTo,
  settingsTo,
  settingsLabel = "Account settings",
  notifyTo,
  notifyLabel = "Notify",
  signOutTo,
  onSignOut,
  profile,
}: AppSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    onClose();
  }, [location.pathname, location.hash, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const linkClass = (active: boolean) =>
    cn(
      "relative flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-white",
      active && "bg-sidebar-active text-white",
      active &&
        "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-sidebar-accent before:content-['']",
    );

  async function signOut() {
    onClose();
    await onSignOut();
    navigate(signOutTo, { replace: true });
  }

  return (
    <aside
      id="app-sidebar"
      className={cn(
        "z-40 flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-lift max-lg:motion-safe:animate-[drawer-in-left_200ms] lg:sticky lg:top-0 lg:h-dvh",
        open ? "max-lg:flex" : "max-lg:hidden",
      )}
      aria-label={label}
    >
      <div className="border-b border-sidebar-border px-3 py-3">
        <Link to={homeTo} className="inline-flex items-center gap-2.5 rounded-md px-1" onClick={onClose}>
          <LogoMark variant={variant} />
          <span className="whitespace-nowrap text-sm font-semibold tracking-tight">
            ISP <span className="text-sidebar-foreground">CENTRIC</span>
          </span>
        </Link>
        {variant === "employee" ? (
          <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-sidebar-accent/40 bg-sidebar-accent/10 px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-sidebar-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-sidebar-accent" aria-hidden="true" />
            Staff console
          </span>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <SectionLabel>Menu</SectionLabel>
        <button
          type="button"
          className="relative flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-foreground transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-white"
          onClick={() => {
            onClose();
            if (window.history.length > 1) navigate(-1);
            else navigate("/");
          }}
        >
          <LinkIcon icon={ArrowLeft} chip="bg-slate-500/20 text-slate-300" />
          Back
        </button>
        <Link
          to={dashboardTo}
          aria-current={isCurrent(dashboardTo, location.pathname, location.hash) ? "page" : undefined}
          className={linkClass(isCurrent(dashboardTo, location.pathname, location.hash))}
          onClick={onClose}
        >
          <LinkIcon icon={LayoutDashboard} chip="bg-sky-500/15 text-sky-400" />
          <span className="truncate">Dashboard</span>
        </Link>
        {items.map((item) => {
          const active = isCurrent(item.to, location.pathname, location.hash);
          const { icon, chip } = ITEM_ICONS[item.label] ?? FALLBACK_ICON;
          return (
            <Link
              key={`${item.to}-${item.label}`}
              to={item.to}
              aria-current={active ? "page" : undefined}
              title={item.label}
              className={cn(linkClass(active), "truncate")}
              onClick={onClose}
            >
              <LinkIcon icon={icon} chip={chip} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="grid gap-0.5 border-t border-sidebar-border p-3">
        <SectionLabel>Account</SectionLabel>
        {profile ? (
          <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-sidebar-border bg-sidebar-hover p-2.5">
            <img
              src={profile.photoUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-sidebar-border"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-sidebar-foreground" title={profile.name}>
                {profile.name}
              </p>
              <p className="truncate text-xs text-sidebar-muted">
                {profile.role ?? profile.accountNumber ?? profile.detail}
              </p>
            </div>
          </div>
        ) : null}
        <Link
          to={settingsTo}
          aria-current={isCurrent(settingsTo, location.pathname, location.hash) ? "page" : undefined}
          title={settingsLabel}
          className={linkClass(isCurrent(settingsTo, location.pathname, location.hash))}
          onClick={onClose}
        >
          <LinkIcon icon={Settings} chip="bg-violet-500/15 text-violet-400" />
          <span className="truncate">{settingsLabel}</span>
        </Link>
        {notifyTo ? (
          <Link
            to={notifyTo}
            aria-current={isCurrent(notifyTo, location.pathname, location.hash) ? "page" : undefined}
            title={notifyLabel}
            className={linkClass(isCurrent(notifyTo, location.pathname, location.hash))}
            onClick={onClose}
          >
            <LinkIcon icon={Bell} chip="bg-amber-500/15 text-amber-400" />
            <span className="truncate">{notifyLabel}</span>
          </Link>
        ) : null}
        <button
          type="button"
          className="relative flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-foreground transition-colors duration-fast ease-out hover:bg-sidebar-hover hover:text-white"
          onClick={() => void signOut()}
        >
          <LinkIcon icon={LogOut} chip="bg-rose-500/15 text-rose-400" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
