import { Hero } from "@/components/marketing/hero";
import { Marquee } from "@/components/marketing/marquee";
import { StatsSection } from "@/components/marketing/stats-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { AboutTeaser } from "@/components/marketing/about-teaser";
import { ContactCTA } from "@/components/marketing/contact-cta";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Marquee />
      <StatsSection />
      <FeaturesSection />
      <AboutTeaser />
      <ContactCTA />
    </>
  );
}
