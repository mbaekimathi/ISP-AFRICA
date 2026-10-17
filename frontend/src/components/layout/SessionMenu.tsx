import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

type SessionMenuProps = {
  name: string;
  detail: string;
  photoUrl: string;
  profileTo: string;
  signOutTo: string;
  phone?: string;
  accountNumber?: string;
  role?: string;
  onSignOut: () => Promise<void> | void;
};

export function SessionMenu({ name, detail, photoUrl, profileTo, signOutTo, phone, accountNumber, role, onSignOut }: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setOpen(false);
    await onSignOut();
    navigate(signOutTo, { replace: true });
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-1.5 text-sm font-semibold text-foreground shadow-sm sm:pr-3"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${name}${role ? `, ${role}` : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <img src={photoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
        <span className="hidden max-w-[8rem] truncate sm:inline">{name}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={name}
          className="absolute right-0 z-50 mt-2 w-60 rounded-xl border border-border bg-surface p-2 shadow-card"
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <img src={photoUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{name}</p>
              {role ? <p className="truncate text-xs font-semibold text-accent">{role}</p> : null}
              {phone ? <p className="truncate text-xs text-muted-foreground">{phone}</p> : null}
              <p className="truncate text-xs text-muted-foreground">{detail}</p>
              {accountNumber ? <p className="truncate text-xs text-muted-foreground">{accountNumber}</p> : null}
            </div>
          </div>
          <Link
            role="menuitem"
            to={profileTo}
            className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-foreground hover:bg-surface-muted"
            onClick={() => setOpen(false)}
          >
            Profile
          </Link>
          <button
            type="button"
            role="menuitem"
            className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm font-medium text-foreground hover:bg-surface-muted"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
