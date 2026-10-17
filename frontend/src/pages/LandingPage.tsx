import {
  AboutSection,
  BenefitsSection,
  FAQSection,
  FeaturesSection,
  FinalCtaSection,
  HeroSection,
  HowItWorksSection,
  InterfaceSection,
  SecuritySection,
  SolutionsSection,
} from "@/components/landing/LandingSections";
import { usePageMeta } from "@/hooks/usePageMeta";

export function LandingPage() {
  usePageMeta(
    "ISP CENTRIC — ISP Billing and Network Management",
    "Manage subscribers, simplify billing, track payments, and bring your internet operations together with ISP CENTRIC.",
  );

  return (
    <>
      <HeroSection />
      <BenefitsSection />
      <FeaturesSection />
      <SolutionsSection />
      <HowItWorksSection />
      <InterfaceSection />
      <SecuritySection />
      <AboutSection />
      <FAQSection />
      <FinalCtaSection />
    </>
  );
}
