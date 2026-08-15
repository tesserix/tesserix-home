/**
 * The estate: every rail context the platform console covers, and whether its
 * IA has moved into this package yet.
 *
 * This is deliberately a SUMMARY, not the nav trees themselves. Copying five
 * products' full navigation here would be the migration, not a description of
 * it — and would immediately drift from `apps/web/lib/products/nav-config.ts`,
 * which remains the source of truth until each product actually moves.
 *
 * Counts are top-level rail entries (a collapsible group counts as one), read
 * from `nav-config.ts` on 2026-08-15. `migrated: true` means the product's nav,
 * route identity and icon keys live in this package — today only Kora.
 */
export interface EstateProduct {
  /** Display name. Distinct from `context`: Fe3dr's context is "homechef". */
  readonly name: string;
  /** Rail context key, as used by apps/web's `RailContext`. */
  readonly context: string;
  /** Top-level rail entries; a collapsible group counts as one. */
  readonly entries: number;
  /** Has this product's IA moved into console-core? */
  readonly migrated: boolean;
  /** What the rail holds, for a reader who has never seen the product. */
  readonly summary: string;
}

export const ESTATE: readonly EstateProduct[] = [
  {
    name: "Platform",
    context: "platform",
    entries: 17,
    migrated: false,
    summary: "Estate-wide operations: tickets, health, domains, governance.",
  },
  {
    name: "Mark8ly",
    context: "mark8ly",
    entries: 8,
    migrated: false,
    summary: "Tenants, onboarding, subscriptions and leads.",
  },
  {
    name: "Fe3dr",
    context: "homechef",
    entries: 9,
    migrated: false,
    summary: "The largest rail: chefs, orders, payments, marketing.",
  },
  {
    name: "DevAI",
    context: "devai",
    entries: 4,
    migrated: false,
    summary: "Overview plus deep links into shared observability.",
  },
  {
    name: "Dwellm8",
    context: "dwellm8",
    entries: 4,
    migrated: false,
    summary: "Overview plus shared health and incidents.",
  },
  {
    name: "Kora",
    context: "kora",
    entries: 5,
    migrated: true,
    summary: "Food index, audit trail, feedback and users.",
  },
] as const;

/** Products still rendering from `apps/web`'s own nav config. */
export function unmigrated(): readonly EstateProduct[] {
  return ESTATE.filter((product) => !product.migrated);
}
