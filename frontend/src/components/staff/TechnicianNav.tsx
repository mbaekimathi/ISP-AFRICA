import { CirclePlus, LifeBuoy, Package, UserRound, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { clientPage } from "@/lib/accounts";
import { useAuth } from "@/providers/AuthProvider";

export const technicianLinks = [
  { label: "Tickets", to: "/tickets", icon: LifeBuoy, chip: "bg-amber-500/15 text-amber-400" },
  { label: "New client onboarding", to: "/onboard", icon: CirclePlus, chip: "bg-emerald-500/15 text-emerald-400" },
  { label: "Materials", to: "/materials", icon: Package, chip: "bg-cyan-500/15 text-cyan-400" },
  { label: "My account", to: "/account", icon: UserRound, chip: "bg-indigo-500/15 text-indigo-400" },
];

export const customercareLinks = [
  { label: "Tickets", to: "/tickets", icon: LifeBuoy, chip: "bg-amber-500/15 text-amber-400" },
  { label: "Clients", to: "/clients", icon: Users, chip: "bg-violet-500/15 text-violet-400" },
];

function StaffMobileNav({ links }: { links: typeof technicianLinks }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <nav className="mt-6 grid grid-cols-2 gap-3 lg:hidden" aria-label="Staff menu">
      {links.map((item) => (
        <Link
          key={item.to}
          to={clientPage(user, item.to)}
          className="panel flex flex-col items-start gap-3 p-4 transition hover:border-primary/40"
        >
          <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${item.chip}`} aria-hidden="true">
            <item.icon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function TechnicianMobileNav() {
  return <StaffMobileNav links={technicianLinks} />;
}

export function CustomerCareMobileNav() {
  return <StaffMobileNav links={customercareLinks} />;
}
