import { ArrowRight, Building2, Store, Wifi, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/public/PageHeader";
import { Reveal } from "@/components/public/Reveal";
import { Section } from "@/components/public/Section";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";

const COPY = {
  meta: {
    title: "Solutions — ISP CENTRIC",
    description: "Subscriber billing, hotspot access, and multi-site operations for every kind of ISP.",
  },
  header: {
    eyebrow: "Solutions",
    title: "Built for every kind of ISP.",
    description: "One workspace that fits the way you actually run your network.",
  },
  cards: [
    {
      icon: Store,
      chip: "bg-primary/10 text-primary",
      title: "Small ISPs and startups",
      text: "Orderly billing from day one, without enterprise overhead.",
      tags: ["Simple setup", "Subscriber billing"],
    },
    {
      icon: Wifi,
      chip: "bg-accent/10 text-accent",
      title: "Hotspot operators",
      text: "Sell access by voucher or payment, no front desk required.",
      tags: ["Vouchers", "Guest payments"],
    },
    {
      icon: Building2,
      chip: "bg-success/10 text-success",
      title: "Growing multi-site networks",
      text: "Add routers, sites, and staff without splitting your records.",
      tags: ["Multi-router", "Staff roles"],
    },
  ] as { icon: LucideIcon; chip: string; title: string; text: string; tags: string[] }[],
  cta: { label: "Get started", to: "/signup" },
};

export function SolutionsPage() {
  usePageMeta(COPY.meta.title, COPY.meta.description);

  return (
    <Section>
      <PageHeader
        eyebrow={COPY.header.eyebrow}
        title={COPY.header.title}
        description={COPY.header.description}
      />
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {COPY.cards.map((card, index) => (
          <Reveal key={card.title} delay={index * 90}>
            <div className="flex h-full flex-col rounded-2xl border border-border bg-surface p-6 shadow-card">
              <span
                className={cn("inline-flex h-10 w-10 items-center justify-center rounded-xl", card.chip)}
                aria-hidden="true"
              >
                <card.icon className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-base font-semibold text-foreground">{card.title}</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{card.text}</p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {card.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
              <Link
                to={COPY.cta.to}
                className="mt-auto inline-flex w-fit items-center gap-1.5 pt-5 text-sm font-semibold text-primary transition duration-fast ease-out hover:text-primary-hover"
              >
                {COPY.cta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
