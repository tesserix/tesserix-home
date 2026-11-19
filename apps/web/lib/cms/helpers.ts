// Safe to import from client components: pure functions and types only.
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

