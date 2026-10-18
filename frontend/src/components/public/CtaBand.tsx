import { ArrowRight } from "lucide-react";
import { BackgroundGlow } from "@/components/public/BackgroundGlow";
import { Section } from "@/components/public/Section";
import { PrimaryButton } from "@/components/ui/Buttons";

type CtaBandProps = {
  id?: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaTo: string;
};

/** Closing band: one headline, one line, one primary CTA. */
export function CtaBand({ id, title, description, ctaLabel, ctaTo }: CtaBandProps) {
  return (
    <Section id={id}>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-12 text-center shadow-card sm:px-12 sm:py-16">
        <BackgroundGlow grid={false} />
        <div className="relative mx-auto max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">{description}</p>
          <div className="mt-8">
            <PrimaryButton to={ctaTo}>
              {ctaLabel}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PrimaryButton>
          </div>
        </div>
      </div>
    </Section>
  );
}
