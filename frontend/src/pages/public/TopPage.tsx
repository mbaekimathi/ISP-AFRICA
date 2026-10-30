import { BackgroundGlow } from "@/components/public/BackgroundGlow";
import { CtaBand } from "@/components/public/CtaBand";
import { LiveChip } from "@/components/public/LiveChip";
import { OrbitGlobe } from "@/components/public/OrbitGlobe";
import { RotatingGlobe } from "@/components/public/RotatingGlobe";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { usePageMeta } from "@/hooks/usePageMeta";

const COPY = {
  meta: {
    title: "ISP CENTRIC — Run your ISP from anywhere",
    description:
      "Secure, simple billing and network management, accessible anywhere in the world.",
  },
  hero: {
    headlineAccent: "CENTRIC",
    headlineBase: "ISP",
    subline:
      "Billing, staff, hotspot and network operations in one secure workspace — responsive on phone, tablet, and desktop.",
    primaryCta: { label: "Get started", to: "/signup" },
    secondaryCta: { label: "Check our features", to: "/features" },
    live: "Online",
  },
  cta: {
    title: "Ready in minutes.",
    description: "Create your account and bring your subscribers, billing, and routers into one place.",
    ctaLabel: "Get started",
    ctaTo: "/signup",
  },
};

export function TopPage() {
  usePageMeta(COPY.meta.title, COPY.meta.description);

  return (
    <>
      <section className="relative overflow-hidden">
        <BackgroundGlow />
        <div className="page-shell relative grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-2 lg:py-28">
          <div>
            <h1 className="text-6xl font-bold tracking-tight text-foreground sm:text-7xl lg:text-8xl">
              {COPY.hero.headlineBase}
              <span className="text-accent">{COPY.hero.headlineAccent}</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-7 text-muted-foreground sm:text-lg">
              {COPY.hero.subline}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <PrimaryButton to={COPY.hero.primaryCta.to}>{COPY.hero.primaryCta.label}</PrimaryButton>
              <SecondaryButton to={COPY.hero.secondaryCta.to}>{COPY.hero.secondaryCta.label}</SecondaryButton>
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <OrbitGlobe>
              <RotatingGlobe />
            </OrbitGlobe>
            <LiveChip label={COPY.hero.live} className="absolute right-2 top-2 sm:right-6 sm:top-6" />
          </div>
        </div>
      </section>

      <CtaBand
        title={COPY.cta.title}
        description={COPY.cta.description}
        ctaLabel={COPY.cta.ctaLabel}
        ctaTo={COPY.cta.ctaTo}
      />
    </>
  );
}
