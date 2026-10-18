import { HandHeart, ShieldCheck, Signal, type LucideIcon } from "lucide-react";
import { GlobeGraphic } from "@/components/public/GlobeGraphic";
import { PageHeader } from "@/components/public/PageHeader";
import { Reveal } from "@/components/public/Reveal";
import { Section } from "@/components/public/Section";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";

const COPY = {
  meta: {
    title: "About — ISP CENTRIC",
    description: "ISP CENTRIC builds simple, secure operations software for internet providers everywhere.",
  },
  header: {
    eyebrow: "About",
    title: "Software for the people who keep others online.",
    description:
      "We build the operational layer for internet providers: billing, payments, and network tools that stay out of your way. Every screen is designed to be secure, simple, and usable from anywhere.",
  },
  values: [
    {
      icon: Signal,
      chip: "bg-primary/10 text-primary",
      title: "Reliable",
      text: "Tools that keep working when your network is busiest.",
    },
    {
      icon: ShieldCheck,
      chip: "bg-accent/10 text-accent",
      title: "Secure",
      text: "Customer records protected by design, not by promise.",
    },
    {
      icon: HandHeart,
      chip: "bg-success/10 text-success",
      title: "Human support",
      text: "Real people who understand how ISPs actually operate.",
    },
  ] as { icon: LucideIcon; chip: string; title: string; text: string }[],
  reach: "Serving ISPs worldwide",
};

export function AboutPage() {
  usePageMeta(COPY.meta.title, COPY.meta.description);

  return (
    <Section>
      <PageHeader
        eyebrow={COPY.header.eyebrow}
        title={COPY.header.title}
        description={COPY.header.description}
      />
      <div className="mt-14 grid gap-4 sm:grid-cols-3">
        {COPY.values.map((value, index) => (
          <Reveal key={value.title} delay={index * 90}>
            <div className="h-full rounded-2xl border border-border bg-surface p-6 text-center shadow-card">
              <span
                className={cn("inline-flex h-10 w-10 items-center justify-center rounded-xl", value.chip)}
                aria-hidden="true"
              >
                <value.icon className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-base font-semibold text-foreground">{value.title}</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{value.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
      <div className="mx-auto mt-16 flex max-w-xs flex-col items-center text-center">
        <GlobeGraphic className="w-full opacity-60" />
        <p className="mt-4 text-sm font-medium uppercase tracking-[0.2em] text-subtle">{COPY.reach}</p>
      </div>
    </Section>
  );
}
