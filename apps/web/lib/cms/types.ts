// Shapes the marketing pages render. Filled from the CMS (lib/cms/products.ts,
// lib/cms/site.ts) or from the frozen fallback (lib/cms/fallback/*).

/**
 * The industries the current portfolio covers, one per product. This is
 * the single source of truth for the "one industry at a time" marketing
 * copy repeated on the hero, footer and /about — those surfaces derive their
 * industry list from the products instead of holding their own copy.
 */
export type Industry =
  | "commerce"
  | "food"
  | "rentals"
  | "healthcare"
  | "nutrition"
  | "travel";

export interface ProductMediaImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  orientation: "landscape" | "portrait";
}

/** Icons are lucide export names, resolved by `ProductIcon` (components/marketing/icon.tsx). */
export interface ProductFeature {
  icon: string;
  title: string;
  description: string;
}

export interface ProductListing {
  /** Empty for a real platform with no live link yet (e.g. iOS under review). */
  url: string;
  artworkSrc: string;
}

export interface Product {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  longDescription: string;
  icon: string;
  status: "available" | "coming-soon";
  industry: Industry;
  /** Short bullets used wherever a product is summarized (/products rows, homepage cards). */
  highlights: string[];
  /** Honest launch target for a coming-soon product; omitted when there is no committed timeline. */
  eta?: string;
  features: ProductFeature[];
  benefits: string[];
  /** The product's own site. Pricing lives there, not here. */
  website?: string;
  /** Public pricing page, when the product has one. */
  pricingUrl?: string;
  /** Detail-page primary CTA for `available` products; must match where `website` goes. */
  ctaLabel?: string;
  ctaSubtext?: string;
  /** The real trial offer, stated as the product's own site states it. */
  trialLine?: string;
  /** JSON-LD `operatingSystem`; defaults to "Web" when omitted. */
  operatingSystem?: string;
  listings?: Partial<Record<"ios" | "android", ProductListing>>;
  /** Fe3dr's home-cook Android app, a second audience beyond `listings`. */
  vendorListing?: ProductListing;
  /** Real imagery for shipped products only; coming-soon products get none. */
  media?: {
    site?: ProductMediaImage;
    screenshots?: ProductMediaImage[];
  };
}

export interface TeamMember {
  slug: string;
  name: string;
  title: string;
  /** Only text actually published on the person's public profiles; never invented. */
  bio?: string;
  linkedIn: string;
  github: string;
  photo: string;
}

export interface Principle {
  title: string;
  body: string;
}

export interface Belief {
  label: string;
  title: string;
  body: string;
}

export interface OpenSourceRepo {
  name: string;
  description: string;
}
