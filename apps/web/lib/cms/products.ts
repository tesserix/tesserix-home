// Server-only: reads the CMS (see lib/cms/client.ts). Client components get products as props
// and import the pure helpers from ./helpers.
import { find, mediaUrl, opt, orFallback, type Media } from "./client";
import { fallbackProducts } from "./fallback/products";
import type { Industry, Product, ProductListing, ProductMediaImage } from "./types";
import type { Products } from "./helpers";

export * from "./helpers";

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

/** The product, or undefined; `hasOwn` so a slug like "constructor" is not a product. */
export async function getProduct(slug: string): Promise<Product | undefined> {
  const products = await getProducts();
  return Object.hasOwn(products, slug) ? products[slug] : undefined;
}
