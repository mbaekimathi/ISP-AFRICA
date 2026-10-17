import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { MobileNavigation } from "@/components/layout/MobileNavigation";
import { SessionMenu } from "@/components/layout/SessionMenu";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { navItems } from "@/content/landing";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

function isCurrent(href: string, pathname: string, hash: string) {
  if (pathname !== "/") return false;
  if (href === "/#top") return hash === "" || hash === "#top";
  return hash === href.slice(1);
}

export function PublicHeader() {
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
        scrolled ? "border-border bg-background/95 backdrop-blur-md" : "border-transparent bg-background/70 backdrop-blur-sm",
      )}
    >
      <div className="page-shell flex h-header items-center gap-3">
        <Link to="/" className="rounded-md" aria-label="ISP CENTRIC home">
          <Logo />
        </Link>
        <nav className="ml-6 hidden items-center gap-1 xl:flex" aria-label="Primary">
          {navItems.map((item) => {
            const active = isCurrent(item.href, location.pathname, location.hash);
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  "rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition duration-brand hover:text-foreground",
                  active && "text-foreground",
                )}
                aria-current={active ? "page" : undefined}
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
              profileTo="/account"
              signOutTo="/login"
              onSignOut={logout}
            />
          ) : (
            <div className="hidden sm:block">
              <SecondaryButton to="/login">Login</SecondaryButton>
            </div>
          )}
          <div className="hidden md:block">
            <PrimaryButton to="/demo">Request a Demo</PrimaryButton>
          </div>
          <MobileNavigation />
        </div>
      </div>
    </header>
  );
}
