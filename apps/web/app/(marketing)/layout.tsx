import { Navbar } from "@/components/common/navbar";
import { Footer } from "@/components/common/footer";
import type { Metadata } from "next";
import { getProducts, industryListPlain, isComingSoon } from "@/lib/cms/products";
import { getTeam } from "@/lib/cms/site";
import { buildOrganizationSchema } from "@/app/seo/structured-data";

/**
 * Blueprint grid background — the Structured Light plan's spec'd but
 * never-built background layer (plan §2). A fixed, full-viewport hairline
 * grid sitting behind all marketing content; masked to fade out past 70% of
 * the viewport height so it doesn't compete with the footer. Scoped to this
 * `(marketing)` layout only, so admin routes are unaffected.
 */
function BlueprintGrid() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[-1]"
      style={{
        backgroundImage:
          "linear-gradient(to right, rgba(11,14,20,0.028) 1px, transparent 1px), linear-gradient(to bottom, rgba(11,14,20,0.028) 1px, transparent 1px)",
        backgroundSize: "72px 72px",
        maskImage: "linear-gradient(black, black 70%, transparent)",
        WebkitMaskImage: "linear-gradient(black, black 70%, transparent)",
      }}
    />
  );
}

// Content comes from the CMS at request time; without this the pages prerendered at build
// (where CMS_URL is unset and the fallback renders) would never refresh.
export const revalidate = 60;

/** The live industry list in the description; the root layout's static copy covers every other route. */
export async function generateMetadata(): Promise<Metadata> {
  const description = `Tesserix is a small product studio building specialized SaaS — one industry at a time. ${industryListPlain(await getProducts())}.`;
  return { description, openGraph: { description }, twitter: { description } };
}

export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [products, team] = await Promise.all([getProducts(), getTeam()]);
  const organizationSchema = buildOrganizationSchema(team);
  const navProducts = Object.values(products).map((p) => ({
    slug: p.slug,
    name: p.title,
    description: p.tagline,
    icon: p.icon,
    href: `/products/${p.slug}`,
    comingSoon: isComingSoon(products, p.slug),
  }));
  return (
    <div className="flex min-h-screen flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <BlueprintGrid />
      <Navbar products={navProducts} />
      <main id="main-content" className="flex-1">{children}</main>
      <Footer products={products} industries={industryListPlain(products)} />
    </div>
  );
}
