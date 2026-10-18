import { useEffect, useRef, useState } from "react";
import { Activity, KeyRound, LockKeyhole, type LucideIcon } from "lucide-react";
import { CtaBand } from "@/components/public/CtaBand";
import { PageHeader } from "@/components/public/PageHeader";
import { Section } from "@/components/public/Section";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";

const COPY = {
  meta: {
    title: "How it works — ISP CENTRIC",
    description: "Connect your MikroTik, add packages and clients, and get paid automatically.",
  },
  header: {
    eyebrow: "How it works",
    title: "Live in three steps.",
    description: "From a router on your bench to a network that bills itself.",
  },
  steps: [
    {
      title: "Connect your MikroTik",
      text: "Link a router over a secure tunnel in a few minutes.",
    },
    {
      title: "Add packages and clients",
      text: "Define the plans you sell and attach them to subscribers.",
    },
    {
      title: "Get paid automatically",
      text: "Invoices, payments, and reconnects run on their own.",
    },
  ],
  security: {
    title: "Secure by design",
    chips: [
      { icon: LockKeyhole, label: "Encrypted connections" },
      { icon: KeyRound, label: "Role-based access" },
      { icon: Activity, label: "Activity logs" },
    ] as { icon: LucideIcon; label: string }[],
  },
  cta: {
    title: "Ready to connect?",
    description: "Create your account and onboard your first router today.",
    ctaLabel: "Get started",
    ctaTo: "/signup",
  },
};

function Stepper() {
  const ref = useRef<HTMLOListElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (
      typeof IntersectionObserver !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative mt-14">
      {/* Vertical connector — mobile only, draws top to bottom */}
      <div
        aria-hidden="true"
        className="absolute bottom-10 left-5 top-5 origin-top border-l-2 border-dashed border-primary/40 transition-transform duration-1000 ease-out motion-reduce:transition-none lg:hidden"
        style={{ transform: visible ? "scaleY(1)" : "scaleY(0)" }}
      />
      {/* Horizontal connector — desktop only, draws left to right */}
      <div
        aria-hidden="true"
        className="absolute left-[18%] right-[18%] top-5 hidden origin-left border-t-2 border-dashed border-primary/40 transition-transform duration-1000 ease-out motion-reduce:transition-none lg:block"
        style={{ transform: visible ? "scaleX(1)" : "scaleX(0)" }}
      />
      <ol ref={ref} className="relative grid gap-10 lg:grid-cols-3 lg:gap-6">
        {COPY.steps.map((step, index) => (
          <li key={step.title} className="flex items-start gap-4 lg:flex-col lg:items-center lg:text-center">
            <span
              className={cn(
                "z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground shadow-sm",
                "transition-opacity duration-500 motion-reduce:transition-none",
                visible ? "opacity-100" : "opacity-0",
              )}
              style={{ transitionDelay: `${index * 150}ms` }}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="min-w-0 lg:mt-4">
              <h2 className="text-base font-semibold text-foreground">{step.title}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HowItWorksPage() {
  usePageMeta(COPY.meta.title, COPY.meta.description);

  return (
    <>
      <Section>
        <PageHeader
          eyebrow={COPY.header.eyebrow}
          title={COPY.header.title}
          description={COPY.header.description}
        />
        <Stepper />
        <div className="mx-auto mt-14 w-fit rounded-2xl border border-border bg-surface px-6 py-5 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{COPY.security.title}</p>
          <ul className="mt-3 flex flex-wrap justify-center gap-2">
            {COPY.security.chips.map((chip) => (
              <li
                key={chip.label}
                className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
              >
                <chip.icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {chip.label}
              </li>
            ))}
          </ul>
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
