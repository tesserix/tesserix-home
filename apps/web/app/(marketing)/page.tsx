import { Hero } from "@/components/marketing/hero";
import { ProductsGrid } from "@/components/marketing/products-grid";
import { BeliefsSection } from "@/components/marketing/beliefs-section";
import { AboutTeaser } from "@/components/marketing/about-teaser";
import { ContactCTA } from "@/components/marketing/contact-cta";

export default function HomePage() {
  return (
    <>
      <Hero />
      <ProductsGrid />
      <BeliefsSection />
      <AboutTeaser />
      <ContactCTA />
    </>
  );
}
