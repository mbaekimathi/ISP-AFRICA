import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SectionProps = {
  id?: string;
  labelledBy?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
};

/** Public-site section: consistent vertical rhythm, content capped by --page-max. */
export function Section({ id, labelledBy, className, innerClassName, children }: SectionProps) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("scroll-mt-24 py-16 sm:py-24", className)}>
      <div className={cn("page-shell", innerClassName)}>{children}</div>
    </section>
  );
}
