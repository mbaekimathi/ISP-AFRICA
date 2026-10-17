import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { navItems } from "@/content/landing";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

function isCurrent(href: string, pathname: string, hash: string) {
  if (pathname !== "/") return false;
  if (href === "/#top") return hash === "" || hash === "#top";
  return hash === href.slice(1);
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.hash]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground xl:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-[var(--overlay)]" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-[70] flex w-[min(100%,20rem)] flex-col border-l border-border bg-surface shadow-lift focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-foreground">Menu</Dialog.Title>
            <Dialog.Close
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-foreground hover:bg-surface-muted"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Mobile">
            <ul className="grid gap-1">
              {navItems.map((item) => {
                const active = isCurrent(item.href, location.pathname, location.hash);
                return (
                  <li key={item.href}>
                    <Link
                      to={item.href}
                      className={cn(
                        "flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-foreground hover:bg-surface-muted",
                        active && "bg-secondary",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="grid gap-2 border-t border-border p-4">
            {user ? null : (
              <SecondaryButton to="/login" className="w-full">
                Login
              </SecondaryButton>
            )}
            <PrimaryButton to="/demo" className="w-full">
              Request a Demo
            </PrimaryButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
