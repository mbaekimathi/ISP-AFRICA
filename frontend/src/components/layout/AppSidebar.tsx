import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LogoMark } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

export type SidebarItem = {
  label: string;
  to: string;
};

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
  }, [open, onClose]);

  const linkClass = (active: boolean) =>
    cn(
      "rounded-lg px-3 py-2 text-sm font-medium text-sidebar-muted hover:bg-white/5 hover:text-sidebar-foreground",
      active && "bg-sidebar-active text-white",
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
        "z-40 flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-lg:fixed max-lg:inset-y-0 max-lg:left-0 lg:sticky lg:top-0 lg:h-dvh",
        open ? "max-lg:flex" : "max-lg:hidden",
      )}
      aria-label={label}
    >
      <div className="border-b border-sidebar-border px-3 py-3">
        <Link to={homeTo} className="inline-flex items-center gap-2.5 rounded-md px-1" onClick={onClose}>
          <LogoMark variant={variant} />
          <span className="whitespace-nowrap text-sm font-semibold tracking-tight">
            ISP <span className="text-primary">CENTRIC</span>
          </span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-muted hover:bg-white/5 hover:text-sidebar-foreground"
          onClick={() => {
            onClose();
            if (window.history.length > 1) navigate(-1);
            else navigate("/");
          }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <Link
          to={dashboardTo}
          aria-current={isCurrent(dashboardTo, location.pathname, location.hash) ? "page" : undefined}
          className={linkClass(isCurrent(dashboardTo, location.pathname, location.hash))}
          onClick={onClose}
        >
          Dashboard
        </Link>
        {items.map((item) => {
          const active = isCurrent(item.to, location.pathname, location.hash);
          return (
            <Link
              key={`${item.to}-${item.label}`}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={linkClass(active)}
              onClick={onClose}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="grid gap-0.5 border-t border-sidebar-border p-3">
        {profile ? (
          <div className="mb-2 flex items-center gap-2.5 px-1">
            <img src={profile.photoUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-sidebar-foreground">{profile.name}</p>
              <p className="truncate text-xs text-sidebar-muted">{profile.role ?? profile.accountNumber ?? profile.detail}</p>
            </div>
          </div>
        ) : null}
        <Link
          to={settingsTo}
          aria-current={isCurrent(settingsTo, location.pathname, location.hash) ? "page" : undefined}
          className={linkClass(isCurrent(settingsTo, location.pathname, location.hash))}
          onClick={onClose}
        >
          {settingsLabel}
        </Link>
        <button
          type="button"
          className="rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-muted hover:bg-white/5 hover:text-sidebar-foreground"
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
