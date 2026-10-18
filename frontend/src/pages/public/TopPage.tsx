import { Globe, MousePointerClick, ShieldCheck, type LucideIcon } from "lucide-react";
import { BackgroundGlow } from "@/components/public/BackgroundGlow";
import { CtaBand } from "@/components/public/CtaBand";
import { LiveChip } from "@/components/public/LiveChip";
import { OrbitGlobe } from "@/components/public/OrbitGlobe";
import { RotatingGlobe } from "@/components/public/RotatingGlobe";
import { Reveal } from "@/components/public/Reveal";
import { Section } from "@/components/public/Section";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";

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
  pillars: [
    {
      icon: Globe,
      chip: "bg-primary/10 text-primary",
      title: "Anywhere",
      text: "Access from any device, in any country.",
    },
    {
      icon: ShieldCheck,
      chip: "bg-accent/10 text-accent",
      title: "Secure",
      text: "Encrypted, role-based and built to protect your customers.",
    },
    {
      icon: MousePointerClick,
      chip: "bg-success/10 text-success",
      title: "Simple",
      text: "Set up in minutes. No training needed.",
    },
  ] as { icon: LucideIcon; chip: string; title: string; text: string }[],
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

      <Section>
        <div className="grid gap-4 sm:grid-cols-3">
          {COPY.pillars.map((pillar, index) => (
            <Reveal key={pillar.title} delay={index * 90}>
              <div className="h-full rounded-2xl border border-border bg-surface p-6 shadow-card">
                <span
                  className={cn("inline-flex h-10 w-10 items-center justify-center rounded-xl", pillar.chip)}
                  aria-hidden="true"
                >
                  <pillar.icon className="h-5 w-5" />
                </span>
                <h2 className="mt-4 text-base font-semibold text-foreground">{pillar.title}</h2>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{pillar.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <CtaBand
        title={COPY.cta.title}
        description={COPY.cta.description}
        ctaLabel={COPY.cta.ctaLabel}
        ctaTo={COPY.cta.ctaTo}
      />
    </>
  );
}
