import * as Dialog from "@radix-ui/react-dialog";
import { Boxes, Home, Info, Mail, Menu, Sparkles, Workflow, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { SessionMenu } from "@/components/layout/SessionMenu";
import { GhostButton, PrimaryButton } from "@/components/ui/Buttons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { clientPage } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

const NAV_LINKS = [
  { to: "/top", label: "Top", icon: Home },
  { to: "/features", label: "Features", icon: Sparkles },
  { to: "/solutions", label: "Solutions", icon: Boxes },
  { to: "/how-it-works", label: "How it works", icon: Workflow },
  { to: "/about", label: "About", icon: Info },
  { to: "/contact", label: "Contact", icon: Mail },
] as const;

/* Token-based icon chips — no literal palette colors. */
const CHIPS = [
  "bg-primary/10 text-primary",
  "bg-accent/10 text-accent",
  "bg-success/10 text-success",
  "bg-warning/10 text-warning",
  "bg-info/10 text-info",
  "bg-secondary text-secondary-foreground",
] as const;

function isActive(to: string, pathname: string) {
  if (to === "/top") return pathname === "/" || pathname === "/top";
  return pathname === to;
}

function MobileDrawer() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay z-[60]" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-[70] flex w-[min(100%,20rem)] flex-col border-l border-border bg-surface-raised shadow-lift focus:outline-none data-[state=open]:animate-[drawer-in-right_220ms]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-foreground">Menu</Dialog.Title>
            <Dialog.Close
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-foreground transition duration-fast ease-out hover:bg-surface-muted"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Mobile">
            <ul className="grid gap-1">
              {NAV_LINKS.map((item, index) => {
                const active = isActive(item.to, location.pathname);
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-foreground transition duration-fast ease-out hover:bg-surface-muted",
                        active && "bg-secondary",
                      )}
                    >
                      <span
                        className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", CHIPS[index % CHIPS.length])}
                        aria-hidden="true"
                      >
                        <item.icon className="h-4 w-4" />
                      </span>
                      {item.label}
                      {active ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="grid gap-2 border-t border-border p-4">
            {user ? null : (
              <GhostButton to="/login" className="w-full">
                Login
              </GhostButton>
            )}
            <PrimaryButton to="/signup" className="w-full">
              Get started
            </PrimaryButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PublicNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const { user, logout } = useAuth();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition duration-brand ease-brand",
        scrolled
          ? "border-border/80 bg-surface/80 shadow-header backdrop-blur-xl"
          : "border-border/40 bg-surface/60 backdrop-blur-md",
      )}
    >
      <div className="page-shell relative flex h-header items-center gap-3">
        <Link to="/top" className="rounded-md" aria-label="ISP CENTRIC home">
          <Logo />
        </Link>
        <nav
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex"
          aria-label="Primary"
        >
          {NAV_LINKS.map((item) => {
            const active = isActive(item.to, location.pathname);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition duration-fast ease-out hover:text-foreground",
                  "after:absolute after:inset-x-3 after:bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity",
                  active && "text-foreground after:opacity-100",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {user ? (
            <SessionMenu
              name={`${user.firstName} ${user.lastName}`}
              detail={user.email}
              photoUrl={user.photoDataUrl}
              dashboardTo={clientPage(user, "/dashboard")}
              profileTo="/account"
              signOutTo="/login"
              onSignOut={logout}
            />
          ) : (
            <GhostButton to="/login" className="hidden sm:inline-flex">
              Login
            </GhostButton>
          )}
          <PrimaryButton to="/signup" className="hidden sm:inline-flex">
            Get started
          </PrimaryButton>
          <MobileDrawer />
        </div>
      </div>
    </header>
  );
}
