import { UserRound } from "lucide-react";
import { CustomerCareMobileNav, TechnicianMobileNav } from "@/components/staff/TechnicianNav";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useAuth } from "@/providers/AuthProvider";

export function ClientStaffDashboardPage() {
  usePageMeta("Staff portal — ISP CENTRIC", "ISP employee portal.");
  const { user } = useAuth();
  const delegate = user?.delegate;
  const firstName = delegate?.name.split(" ")[0];

  return (
    <div className="page-shell flex min-h-[60vh] items-center justify-center py-14">
      <div className="panel w-full max-w-md p-8 text-center">
        <span
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <UserRound className="h-7 w-7" />
        </span>
        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          {delegate?.title ?? "ISP employee"}
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          Welcome{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Your {delegate?.title ?? "staff"} workspace is being set up. Check back soon.
        </p>
      </div>
      {delegate?.role === "isp-technician" ? <TechnicianMobileNav /> : null}
      {delegate?.role === "isp-customercare" ? <CustomerCareMobileNav /> : null}
    </div>
  );
}
