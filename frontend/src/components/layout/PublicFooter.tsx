import { Link } from "react-router-dom";

export function PublicFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="page-shell flex flex-col gap-1 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>© {new Date().getFullYear()} ISP CENTRIC</p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
          <Link className="hover:text-foreground" to="/privacy">
            Privacy
          </Link>
          <Link className="hover:text-foreground" to="/terms">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
