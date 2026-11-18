import type { Industry, Product } from "./types";

// Pure helpers over a product map. Every surface that renders products — the
// navbar, the homepage stack, /products, the detail page, the waitlist — reads
// launch state and the industry list through these rather than restating them;
// they used to each hold a copy and drifted.

export type Products = Record<string, Product>;

export function countWord(count: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[count] ?? String(count);
}

/** Slugs whose status is "available". Flipping a status is what triggers the waitlist announcement. */
export function launchedProductSlugs(products: Products): string[] {
  return Object.values(products)
    .filter((p) => p.status === "available")
    .map((p) => p.slug);
}

/** Display title for a slug, for email subject/body copy. */
export function productTitle(products: Products, slug: string): string {
  return products[slug]?.title ?? slug;
}

/** Unknown slugs read as coming-soon — never advertise something unconfirmed. */
export function isComingSoon(products: Products, slug: string): boolean {
  return products[slug]?.status !== "available";
}

/** Industries covered by the lineup, in portfolio order. */
export function industryNames(products: Products): Industry[] {
  return Object.values(products).map((p) => p.industry);
}

/** "Commerce, food, healthcare, …" — a sentence-start list (hero, footer, /about metadata). */
export function industryListPlain(products: Products): string {
  return industryNames(products)
    .map((name, index) => (index === 0 ? `${name[0].toUpperCase()}${name.slice(1)}` : name))
    .join(", ");
}

function oxfordJoin(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Industry list minus one, with an Oxford "and" — for copy that already named that industry's product. */
export function industryListExcluding(products: Products, exclude: Industry): string {
  return oxfordJoin(industryNames(products).filter((name) => name !== exclude));
}

/** Industries of products not yet launched, with an Oxford "and". */
export function upcomingIndustryList(products: Products): string {
  return oxfordJoin(
    Object.values(products)
      .filter((p) => p.status !== "available")
      .map((p) => p.industry),
  );
}

// --- CMS reads -------------------------------------------------------------

import { find, mediaUrl, opt, orFallback, type Media } from "./client";
import { fallbackProducts } from "./fallback/products";
import type { ProductListing, ProductMediaImage } from "./types";

type ProductDoc = {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  longDescription?: string | null;
  icon?: string | null;
  status: Product["status"];
  industry: Industry;
  highlights?: string[] | null;
  eta?: string | null;
  features?: { icon?: string | null; title: string; description: string }[] | null;
  benefits?: string[] | null;
  website?: string | null;
  pricingUrl?: string | null;
  ctaLabel?: string | null;
  ctaSubtext?: string | null;
  trialLine?: string | null;
  operatingSystem?: string | null;
  listings?: { platform: "ios" | "android"; url?: string | null }[] | null;
  vendorListingUrl?: string | null;
  siteImage?: Media | number | null;
  screenshots?: (Media | number)[] | null;
};

const BADGES = { ios: "/badges/app-store-badge.svg", android: "/badges/google-play-badge.png" } as const;

function image(m: Media | number | null | undefined): ProductMediaImage | undefined {
  const src = mediaUrl(m);
  if (!src || typeof m !== "object" || !m) return undefined;
  const width = m.width ?? 0;
  const height = m.height ?? 0;
  return { src, alt: m.alt ?? "", width, height, orientation: width > height ? "landscape" : "portrait" };
}

function media(d: ProductDoc): Product["media"] {
  // Imagery only for shipped products: a mockup for unreleased software erodes trust.
  if (d.status !== "available") return undefined;
  const site = image(d.siteImage);
  const shots = (d.screenshots ?? []).map(image).filter((s): s is ProductMediaImage => Boolean(s));
  if (!site && !shots.length) return undefined;
  return { site, screenshots: shots.length ? shots : undefined };
}

function listings(d: ProductDoc): Product["listings"] {
  if (!d.listings?.length) return undefined;
  const out: Partial<Record<"ios" | "android", ProductListing>> = {};
  for (const l of d.listings) out[l.platform] = { url: l.url ?? "", artworkSrc: BADGES[l.platform] };
  return out;
}

function toProduct(d: ProductDoc): Product {
  return {
    slug: d.slug,
    title: d.title,
    tagline: d.tagline,
    description: d.description,
    longDescription: d.longDescription ?? "",
    icon: d.icon ?? "Package",
    status: d.status,
    industry: d.industry,
    highlights: d.highlights ?? [],
    eta: opt(d.eta),
    features: (d.features ?? []).map((f) => ({ icon: f.icon ?? "Package", title: f.title, description: f.description })),
    benefits: d.benefits ?? [],
    website: opt(d.website),
    pricingUrl: opt(d.pricingUrl),
    ctaLabel: opt(d.ctaLabel),
    ctaSubtext: opt(d.ctaSubtext),
    trialLine: opt(d.trialLine),
    operatingSystem: opt(d.operatingSystem),
    listings: listings(d),
    vendorListing: d.vendorListingUrl ? { url: d.vendorListingUrl, artworkSrc: BADGES.android } : undefined,
    media: media(d),
  };
}

/** Published products keyed by slug, in `order`; the static lineup when the CMS is unreadable. */
export function getProducts(): Promise<Products> {
  const read = (find("products") as Promise<ProductDoc[]>).then((docs) =>
    Object.fromEntries(docs.map((d) => [d.slug, toProduct(d)])),
  );
  return orFallback(read, fallbackProducts);
}

export async function getProduct(slug: string): Promise<Product | undefined> {
  return (await getProducts())[slug];
}
