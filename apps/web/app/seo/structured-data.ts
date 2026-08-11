import type { TeamMember } from "@/app/(marketing)/about/team";

/**
 * JSON-LD builders for the marketing site.
 *
 * Every fact emitted here must be independently verifiable — this file backs
 * the Organization/WebSite schema on the root layout and the
 * SoftwareApplication/BreadcrumbList schema on product detail pages, and
 * those are read by crawlers and due-diligence reviewers alike. In
 * particular: no `offers`/price (pricing was deliberately removed from the
 * site), no `aggregateRating` (there are no verified ratings), and no
 * invented founding date, employee count, or award.
 */

export const SITE_URL = "https://tesserix.app";

/** Verified company facts — the single source for the Organization schema. */
export const COMPANY = {
  legalName: "Tesserix Pty Ltd",
  brandName: "Tesserix",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.png`,
  description:
    "Tesserix is a small product studio building specialized SaaS, one industry at a time.",
  email: "sales@tesserix.app",
  acn: "694 070 865",
  abn: "59 694 070 865",
  address: {
    streetAddress: "5 Tagu Place",
    addressLocality: "Kings Park",
    addressRegion: "NSW",
    postalCode: "2148",
    addressCountry: "AU",
  },
  /** Real product domains with a live site — omit anything unshipped. */
  productDomains: ["https://mark8ly.com", "https://fe3dr.com", "https://dwellm8.com"],
  socialProfiles: [
    "https://x.com/tesserix_app",
    "https://au.linkedin.com/company/tesserix-pty-ltd",
    "https://github.com/tesserix",
  ],
} as const;

interface SchemaOrgPerson {
  "@type": "Person";
  name: string;
  jobTitle: string;
  sameAs: string[];
}

interface OrganizationSchema {
  "@context": "https://schema.org";
  "@type": "Organization";
  name: string;
  legalName: string;
  url: string;
  logo: string;
  description: string;
  address: {
    "@type": "PostalAddress";
    streetAddress: string;
    addressLocality: string;
    addressRegion: string;
    postalCode: string;
    addressCountry: string;
  };
  identifier: Array<{
    "@type": "PropertyValue";
    propertyID: string;
    value: string;
  }>;
  sameAs: string[];
  founder: SchemaOrgPerson[];
  contactPoint: {
    "@type": "ContactPoint";
    contactType: string;
    email: string;
  };
}

/** Builds the Organization JSON-LD emitted once, on the root layout. */
export function buildOrganizationSchema(team: TeamMember[]): OrganizationSchema {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: COMPANY.brandName,
    legalName: COMPANY.legalName,
    url: COMPANY.url,
    logo: COMPANY.logo,
    description: COMPANY.description,
    address: {
      "@type": "PostalAddress",
      ...COMPANY.address,
    },
    identifier: [
      { "@type": "PropertyValue", propertyID: "ACN", value: COMPANY.acn },
      { "@type": "PropertyValue", propertyID: "ABN", value: COMPANY.abn },
    ],
    sameAs: [...COMPANY.socialProfiles, ...COMPANY.productDomains],
    founder: team.map((member) => ({
      "@type": "Person",
      name: member.name,
      jobTitle: member.title,
      sameAs: [member.linkedIn, member.github].filter(Boolean),
    })),
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "sales",
      email: COMPANY.email,
    },
  };
}

interface WebSiteSchema {
  "@context": "https://schema.org";
  "@type": "WebSite";
  name: string;
  url: string;
}

/** Builds the WebSite JSON-LD emitted once, on the root layout. */
export function buildWebSiteSchema(): WebSiteSchema {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: COMPANY.brandName,
    url: COMPANY.url,
  };
}

export interface ProductSchemaInput {
  title: string;
  description: string;
  status: "available" | "coming-soon";
}

interface SoftwareApplicationSchema {
  "@context": "https://schema.org";
  "@type": "SoftwareApplication";
  name: string;
  description: string;
  url: string;
  applicationCategory: string;
  operatingSystem: string;
  releaseStatus: "https://schema.org/OnlineOnly" | "https://schema.org/PreOrder";
  // Deliberately no `offers`/`aggregateRating` — see file header.
}

/**
 * Builds the SoftwareApplication JSON-LD for a product detail page, sourced
 * entirely from `products-data.ts`. No price, no rating — see file header.
 */
export function buildProductSchema(
  slug: string,
  product: ProductSchemaInput,
): SoftwareApplicationSchema {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: product.title,
    description: product.description,
    url: `${SITE_URL}/products/${slug}`,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    releaseStatus:
      product.status === "available"
        ? "https://schema.org/OnlineOnly"
        : "https://schema.org/PreOrder",
  };
}

interface BreadcrumbListSchema {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: Array<{
    "@type": "ListItem";
    position: number;
    name: string;
    item: string;
  }>;
}

export interface BreadcrumbEntry {
  name: string;
  path: string;
}

/** Builds a BreadcrumbList JSON-LD from an ordered list of page entries. */
export function buildBreadcrumbSchema(entries: BreadcrumbEntry[]): BreadcrumbListSchema {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: `${SITE_URL}${entry.path}`,
    })),
  };
}
