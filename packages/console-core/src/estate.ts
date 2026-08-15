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
 *
 * SCOPE — the estate is larger than this list, deliberately.
 *
 * ArgoCD's prod app-of-apps also runs FanZone (~25 services), Guardix,
 * Gameverse, Horoscope, Social, Blog and Planning Poker. They are excluded on
 * purpose: the console's first cut covers Platform, Mark8ly, Fe3dr, DevAI,
 * Dwellm8, Kora and HMS.
 *
 * Recorded here so the omission reads as a decision rather than an oversight.
 * A console whose thesis is "one place to control every product" and whose map
 * covers half the products is making a claim it cannot support — the honest
 * position is a stated scope, revisited when the first cut lands.
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
    // The rail is thin; the product is not. Three of its four entries are
    // shared platform routes. DevAI itself runs pipeline and SRE dashboards of
    // its own, and meters every LLM call to integer micro-USD per user — the
    // only product in the estate that already answers "what does this user
    // cost". A thin rail here means "not yet surfaced", not "little to show".
    summary: "Rail is mostly shared platform routes; the product runs its own dashboards and an LLM cost ledger.",
  },
  {
    name: "Dwellm8",
    context: "dwellm8",
    entries: 4,
    migrated: false,
    // Same shape as DevAI, and the same correction. Three of four entries are
    // shared routes, but Dwellm8 ships its own operator app — triage,
    // approvals, reconcile, dispute — over a double-entry money module with
    // settlements, mandates and TDS obligations. Aggregation and deep links
    // are the useful contribution here, not rebuilding what exists.
    summary: "Rail is mostly shared platform routes; the product ships its own operator app over a double-entry ledger.",
  },
  {
    name: "Kora",
    context: "kora",
    entries: 5,
    migrated: true,
    summary: "Food index, audit trail, feedback and users.",
  },
  {
    name: "HMS",
    context: "hms",
    // No rail in nav-config.ts — HMS has no console presence at all. Recorded
    // as zero rather than omitted, because "a product we do not surface" is a
    // fact worth carrying: HMS is the one product where console decisions can
    // still shape the product rather than retrofit it.
    entries: 0,
    migrated: false,
    summary: "No rail yet. Healthcare platform in build; billing metadata is specified to live in a shared, PHI-free control plane.",
  },
] as const;

/** Products still rendering from `apps/web`'s own nav config. */
export function unmigrated(): readonly EstateProduct[] {
  return ESTATE.filter((product) => !product.migrated);
}
