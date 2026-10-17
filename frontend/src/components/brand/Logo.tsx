export function LogoMark({ className = "h-8 w-8", variant = "client" }: { className?: string; variant?: "client" | "employee" }) {
  const employee = variant === "employee";
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-sidebar" />
      <path
        d="M16 16 9.5 10.5M16 16 23 8.5M16 16 24.5 18M16 16 11 23.5"
        stroke={employee ? "#FDBA74" : "#BFDBFE"}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.7" fill={employee ? "#FFF7ED" : "#F8FBFF"} />
      <circle cx="9" cy="10" r="2.1" fill={employee ? "#FDBA74" : "#67E8F9"} />
      <circle cx="23.2" cy="8.2" r="2.1" fill={employee ? "#2DD4BF" : "#93C5FD"} />
      <circle cx="24.6" cy="18.4" r="2.1" fill={employee ? "#C2410C" : "#3B82F6"} />
      <circle cx="10.6" cy="23.6" r="2.1" fill={employee ? "#14B8A6" : "#22D3EE"} />
    </svg>
  );
}

export function Logo({ className = "", variant = "client" }: { className?: string; variant?: "client" | "employee" }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark variant={variant} />
      <span className="whitespace-nowrap text-[0.95rem] font-semibold tracking-tight text-foreground">
        ISP <span className="text-primary">CENTRIC</span>
      </span>
    </span>
  );
}
