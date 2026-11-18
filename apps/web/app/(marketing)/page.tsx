import { Hero } from "@/components/marketing/hero";
import { ProductsGrid } from "@/components/marketing/products-grid";
import { BeliefsSection } from "@/components/marketing/beliefs-section";
import { AboutTeaser } from "@/components/marketing/about-teaser";
import { OpenSourceStrip } from "@/components/marketing/open-source-strip";
import { ContactCTA } from "@/components/marketing/contact-cta";
import { getProducts } from "@/lib/cms/products";
import { getBeliefs, getOpenSource } from "@/lib/cms/site";

export default async function HomePage() {
  const [products, beliefs, repos] = await Promise.all([getProducts(), getBeliefs(), getOpenSource()]);
  return (
    <>
      <Hero products={products} />
      <ProductsGrid products={products} />
      <BeliefsSection beliefs={beliefs} />
      <AboutTeaser products={products} />
      <OpenSourceStrip repos={repos} />
      <ContactCTA />
    </>
  );
}
