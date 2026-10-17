import type { ReactNode } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";

export function CallToAction({
  title,
  titleId,
  description,
  primaryTo = "/demo",
  primaryLabel = "Request a Demo",
  secondaryTo = "/#features",
  secondaryLabel = "Explore Features",
  children,
}: {
  title: string;
  titleId?: string;
  description: string;
  primaryTo?: string;
  primaryLabel?: string;
  secondaryTo?: string;
  secondaryLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-surface px-6 py-10 shadow-lift sm:px-10 sm:py-12">
      <div className="pointer-events-none absolute inset-0 network-glow opacity-80" aria-hidden="true" />
      <div className="relative max-w-2xl">
        <h2 id={titleId} className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h2>
        <p className="mt-4 text-base leading-7 text-muted-foreground">{description}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <PrimaryButton to={primaryTo}>{primaryLabel}</PrimaryButton>
          <SecondaryButton to={secondaryTo}>{secondaryLabel}</SecondaryButton>
        </div>
        {children}
      </div>
    </div>
  );
}
