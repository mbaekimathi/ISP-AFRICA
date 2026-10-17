import { ArrowRight, PackagePlus, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

function PackageAction({
  to,
  icon,
  title,
  description,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="group flex h-full flex-col rounded-2xl border border-border bg-surface p-5 shadow-card transition duration-brand ease-brand hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-6"
    >
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <h2 className="mt-4 text-base font-semibold tracking-tight sm:text-lg">{title}</h2>
      <p className="mt-1 flex-1 text-sm leading-6 text-muted-foreground">{description}</p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
        Open packages
        <ArrowRight className="h-4 w-4 transition duration-brand ease-brand group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

export function BillingsPage() {
  const { user } = useAuth();
  usePageMeta("Billings — ISP CENTRIC", "Edit default packages or register new packages.");
  const packagesTo = user ? clientPage(user, "/account/settings/isp-package") : "/account/settings/isp-package";

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Billings"
        description="Choose how this account is billed. Edit a default package, or register one of your own."
      />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <PackageAction
          to={`${packagesTo}#registered-packages`}
          icon={<Pencil className="h-5 w-5" aria-hidden="true" />}
          title="Edit default packages"
          description="Company packages start here as defaults. Change the name, price, speed, or routers for this account."
        />
        <PackageAction
          to={`${packagesTo}#register-package`}
          icon={<PackagePlus className="h-5 w-5" aria-hidden="true" />}
          title="Register a new package"
          description="Add a package with its own price and speed, then attach it to the routers on this account."
        />
      </div>
    </div>
  );
}
