import { Outlet } from "react-router-dom";
import { PublicFooter } from "@/components/public/PublicFooter";
import { PublicNavbar } from "@/components/public/PublicNavbar";

export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <PublicNavbar />
      <main id="main" className="relative flex-1">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[26rem] bg-gradient-glow"
          aria-hidden="true"
        />
        <Outlet />
      </main>
      <PublicFooter />
    </div>
  );
}
