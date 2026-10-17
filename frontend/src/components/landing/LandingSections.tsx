import { ArrowRight } from "lucide-react";
import { NetworkBackground } from "@/components/landing/NetworkBackground";
import { FeatureCard } from "@/components/landing/FeatureCard";
import { SolutionCard } from "@/components/landing/SolutionCard";
import { StepCard } from "@/components/landing/StepCard";
import { FAQAccordion } from "@/components/landing/FAQAccordion";
import { CallToAction } from "@/components/landing/CallToAction";
import { HeroPreview, DashboardPreview } from "@/components/previews/DashboardPreview";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { Section, SectionHeading } from "@/components/ui/SectionHeading";
import { benefits, features, securityPoints, solutions, steps } from "@/content/landing";

export function HeroSection() {
  return (
    <section id="top" className="section-anchor relative overflow-hidden">
      <NetworkBackground />
      <div className="page-shell relative grid items-center gap-12 py-16 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:py-24">
        <div>
          <p className="inline-flex items-center rounded-full border border-border bg-surface/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            ISP billing and network operations
          </p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.35rem] lg:leading-[1.08]">
            One Platform. <span className="hero-highlight">Complete Control of Your ISP.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
            Manage subscribers, simplify billing, track payments, and bring your internet operations together in one intelligent platform.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <PrimaryButton to="/demo">
              Request a Demo
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PrimaryButton>
            <SecondaryButton to="/#features">Explore Features</SecondaryButton>
          </div>
        </div>
        <HeroPreview />
      </div>
    </section>
  );
}

export function BenefitsSection() {
  return (
    <Section id="benefits" labelledBy="benefits-heading">
      <div className="page-shell">
        <SectionHeading
          id="benefits-heading"
          eyebrow="Benefits"
          title="A clearer way to run an internet business"
          description="ISP CENTRIC is planned as the operating layer for subscriber services, billing, and the daily work around them."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {benefits.map((item) => (
            <FeatureCard key={item.title} {...item} />
          ))}
        </div>
      </div>
    </Section>
  );
}

export function FeaturesSection() {
  return (
    <Section id="features" labelledBy="features-heading" className="bg-surface-muted/60">
      <div className="page-shell">
        <SectionHeading
          id="features-heading"
          eyebrow="Features"
          title="The capabilities the platform is being built around"
          description="Each area below is part of the product direction. Nothing on this page is a live billing system."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {features.map((item) => (
            <FeatureCard key={item.title} {...item} />
          ))}
        </div>
      </div>
    </Section>
  );
}

export function SolutionsSection() {
  return (
    <Section id="solutions" labelledBy="solutions-heading">
      <div className="page-shell">
        <SectionHeading
          id="solutions-heading"
          eyebrow="Solutions"
          title="Shaped for the way different providers operate"
          description="The same subscriber and billing model is intended to support several kinds of internet businesses."
        />
        <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {solutions.map((item) => (
            <SolutionCard key={item.title} {...item} />
          ))}
        </div>
      </div>
    </Section>
  );
}

export function HowItWorksSection() {
  return (
    <Section id="how-it-works" labelledBy="how-heading" className="bg-surface-muted/60">
      <div className="page-shell">
        <SectionHeading
          id="how-heading"
          eyebrow="How it works"
          title="From packages to a picture of the business"
          description="A straightforward operating sequence for teams that sell internet service."
        />
        <ol className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step.title}>
              <StepCard index={index + 1} title={step.title} description={step.description} />
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

export function InterfaceSection() {
  return (
    <Section id="interface" labelledBy="interface-heading">
      <div className="page-shell">
        <SectionHeading
          id="interface-heading"
          eyebrow="Product interface"
          title="A preview of the workspace"
          description="This illustration shows the intended application layout. It uses sample numbers and is separate from the future signed-in product."
        />
        <div className="mt-10">
          <DashboardPreview />
        </div>
      </div>
    </Section>
  );
}

export function SecuritySection() {
  return (
    <Section id="security" labelledBy="security-heading" className="bg-surface-muted/60">
      <div className="page-shell">
        <SectionHeading
          id="security-heading"
          eyebrow="Security and reliability"
          title="Principles for a system that holds customer records"
          description="These are design intentions. This site does not claim a certification, a guaranteed uptime figure, or absolute protection."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {securityPoints.map((item) => (
            <FeatureCard key={item.title} {...item} />
          ))}
        </div>
      </div>
    </Section>
  );
}

export function AboutSection() {
  return (
    <Section id="about" labelledBy="about-heading">
      <div className="page-shell grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
        <SectionHeading
          id="about-heading"
          eyebrow="About"
          title="Software for operators, not a generic storefront"
          description="ISP CENTRIC is being built for teams that sell internet access and need the business records to stay as organized as the network."
        />
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
          <p className="text-base leading-7 text-muted-foreground">
            The public site introduces the product and the visual system that later screens will share. Subscriber management, billing, payments, and network tools will live in the authenticated application, using the same colors, type, and components you see here.
          </p>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Until that workspace is available, you can review the planned capabilities and leave a demo request. Requests stay in your browser until the delivery endpoint is connected.
          </p>
        </div>
      </div>
    </Section>
  );
}

export function FAQSection() {
  return (
    <Section id="faq" labelledBy="faq-heading" className="bg-surface-muted/60">
      <div className="page-shell grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <SectionHeading
          id="faq-heading"
          eyebrow="Questions"
          title="Frequently asked questions"
          description="Straight answers about what ISP CENTRIC is, and what is still to come."
        />
        <FAQAccordion />
      </div>
    </Section>
  );
}

export function FinalCtaSection() {
  return (
    <Section id="contact" labelledBy="contact-heading">
      <div className="page-shell">
        <CallToAction
          titleId="contact-heading"
          title="See how ISP CENTRIC can fit your operation"
          description="Request a demo to talk through subscriber records, billing, and the workflow your team uses today. The form checks your details locally and explains that delivery is not connected yet."
          secondaryTo="/#how-it-works"
          secondaryLabel="See How It Works"
        />
      </div>
    </Section>
  );
}
