import { Link } from "react-router-dom";
import { LogoMark } from "@/components/brand/Logo";

const FOOTER_LINKS = [
  { to: "/top", label: "Top" },
  { to: "/features", label: "Features" },
  { to: "/solutions", label: "Solutions" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
] as const;

export function PublicFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="page-shell flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
        <Link to="/top" className="inline-flex items-center gap-2 rounded-md" aria-label="ISP CENTRIC home">
          <LogoMark className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            ISP <span className="text-primary">CENTRIC</span>
          </span>
        </Link>
        <nav aria-label="Footer" className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          {FOOTER_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="inline-flex min-h-11 items-center rounded text-xs font-medium text-muted-foreground transition duration-fast ease-out hover:text-foreground sm:min-h-0 sm:py-1"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="text-caption text-subtle">© {new Date().getFullYear()} ISP CENTRIC</p>
      </div>
    </footer>
  );
}
