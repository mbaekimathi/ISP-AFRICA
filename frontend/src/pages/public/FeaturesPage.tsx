import type { ReactNode } from "react";
import { CtaBand } from "@/components/public/CtaBand";
import { PageHeader } from "@/components/public/PageHeader";
import { PreviewFrame } from "@/components/public/PreviewFrame";
import { Reveal } from "@/components/public/Reveal";
import { Section } from "@/components/public/Section";
import { HotspotPortalDemo } from "@/components/public/previews/HotspotPortalDemo";
import { LiveMonitorPreview } from "@/components/public/previews/LiveMonitorPreview";
import { PppoePayDemo } from "@/components/public/previews/PppoePayDemo";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";

const COPY = {
  meta: {
    title: "Features — ISP CENTRIC",
    description:
      "PPPoE self-service payments, a hotspot portal that just works, and live network monitoring.",
  },
  header: {
    eyebrow: "Features",
    title: "Everything you need, nothing you don't.",
    description: "Billing, payments, and monitoring in one place your customers can actually use.",
  },
  rows: [
    {
      title: "PPPoE pay page",
      benefit: "Customers pay and reconnect themselves.",
      chips: ["M-Pesa via Daraja", "Auto-reconnect", "Try the demo"],
      label: "pay.ispcentric.app",
      ariaLabel: "Interactive demo of the PPPoE pay page shown when a subscription expires: pick a package, enter an M-Pesa number, and pay.",
      designWidth: 480,
      designHeight: 640,
      interactive: true,
      preview: <PppoePayDemo />,
      frameClass: "mx-auto max-w-[30rem]",
    },
    {
      title: "Hotspot portal",
      benefit: "Vouchers and logins that just work.",
      chips: ["Voucher codes", "Guest payments", "Try the demo"],
      label: "wifi.ispcentric.app",
      ariaLabel: "Interactive demo of the hotspot portal shown when a session expires: pick a bundle, enter an M-Pesa number, and pay.",
      designWidth: 400,
      designHeight: 780,
      interactive: true,
      preview: <HotspotPortalDemo />,
      frameClass: "mx-auto max-w-[24rem]",
    },
    {
      title: "Live monitoring",
      benefit: "See your network in real time.",
      chips: ["Live status", "Usage meters", "Router health"],
      label: "live.ispcentric.app",
      ariaLabel: "Preview of live router monitoring showing CPU, uplink and memory meters with clients online, uptime, and latency.",
      designWidth: 720,
      designHeight: 460,
      preview: <LiveMonitorPreview />,
      frameClass: "",
    },
  ] as {
    title: string;
    benefit: string;
    chips: string[];
    label: string;
    ariaLabel: string;
    designWidth: number;
    designHeight: number;
    interactive?: boolean;
    preview: ReactNode;
    frameClass: string;
  }[],
  cta: {
    title: "Try it free",
    description: "Create your account and see these screens working on your own network.",
    ctaLabel: "Get started",
    ctaTo: "/signup",
  },
};

export function FeaturesPage() {
  usePageMeta(COPY.meta.title, COPY.meta.description);

  return (
    <>
      <Section>
        <PageHeader
          eyebrow={COPY.header.eyebrow}
          title={COPY.header.title}
          description={COPY.header.description}
        />
        <div className="mt-16 grid gap-16 sm:mt-20 sm:gap-24">
          {COPY.rows.map((row, index) => (
            <Reveal key={row.title}>
              <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
                <div className={cn(index % 2 === 1 && "lg:order-2")}>
                  <h2 className="text-2xl font-semibold tracking-tight text-foreground">{row.title}</h2>
                  <p className="mt-3 text-base leading-7 text-muted-foreground">{row.benefit}</p>
                  <ul className="mt-5 flex flex-wrap gap-2">
                    {row.chips.map((chip) => (
                      <li
                        key={chip}
                        className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted-foreground"
                      >
                        {chip}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={cn(index % 2 === 1 && "lg:order-1")}>
                  <PreviewFrame
                    label={row.label}
                    ariaLabel={row.ariaLabel}
                    designWidth={row.designWidth}
                    designHeight={row.designHeight}
                    interactive={row.interactive}
                    className={row.frameClass}
                  >
                    {row.preview}
                  </PreviewFrame>
                </div>
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
