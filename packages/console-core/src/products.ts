/**
 * The products the console can serve a rail for, as data.
 *
 * # Why this exists
 *
 * Product identity was smeared across three places that did not agree with
 * each other: `routes.ts` knew products only as an id PREFIX (`kora.*`,
 * `mark8ly.*`), `estate.ts` had a product list that is a display model for the
 * estate map, and `apps/console/components/nav/sidebar.tsx` hand-built a
 * two-entry `RAILS` object. Nothing tied a rail to the federation slug its
 * pages fetch with, so `mark8lyNav` existed, was tested, and was rendered by
 * nothing — a rail can only appear if somebody remembers to add it to a fourth
 * list.
 *
 * This table is that missing join. Adding a product here is what makes a rail
 * possible; the renderer derives it rather than being edited in parallel.
 *
 * # Identity only — no presentation
 *
 * `RAILS` in `sidebar.tsx` also carries `mark`, `logo`, `onLight` and
 * `section`. Those stay there. They are `apps/console/public/` asset concerns,
 * and console-core is consumed by web, mobile AND console as a pure data
 * package — `routes.ts` refuses even a VALUE import of `Capability` for that
 * reason. What lives here is what all three consumers would agree on: the
 * federation slug, the display name, the rail, and what the product's admin
 * contract declares.
 *
 * # Why only mark8ly and kora
 *
 * Scope is products that DECLARE contract endpoints in their
 * `admin-conformance.json`. HomeChef, DevAI, Dwellm8 and HMS declare none, so
 * a rail for them would link to pages whose platform-api reads answer 400 —
 * the product is not a federation source at all. They belong here on the day
 * they declare, not before. `estate.ts` lists them because the estate map's
 * job is to show the whole estate including what has not moved; this table's
 * job is the opposite.
 */
import { koraNav, mark8lyNav, platformNav, type NavEntry } from "./nav";

interface ProductEntry {
  /**
   * The platform-api federation slug — the literal value sent as `?source=`.
   *
   * Declared, NOT derived from `estate.ts`'s `context`. `EstateProduct.context`
   * is documented as "Rail context key, as used by apps/web's `RailContext`",
   * and its own comment records that Fe3dr's context is `"homechef"` — so that
   * field already diverges from product identity for at least one product.
   * Deriving a wire value from a field that is allowed to diverge would make
   * the next divergence a silent 400 instead of a compile error.
   *
   * It happens to equal the registry key for both products today. It is still
   * written out, because the key is a console-side name and this is a value on
   * the wire; a product that renamed one and not the other must be able to say
   * so here.
   */
  readonly source: string;
  /** Display name, as an operator reads it on the rail. */
  readonly label: string;
  /**
   * The product's rail.
   *
   * The rail is identity, not presentation: it is the list of route ids this
   * product's operator surfaces have, and route identity is exactly what this
   * package owns. How a renderer draws it — icons, logo, section heading — is
   * the renderer's business.
   */
  readonly nav: readonly NavEntry[];
  /**
   * The §3.4 entity types the product declares in its `admin-conformance.json`.
   *
   * `entities` is ONE contract endpoint id; the types under it are
   * product-defined, which is why the contract marks it `requiresSubtypes` and
   * why platform-api takes them as `FEDERATION_<SLUG>_ENTITIES` rather than
   * knowing any of them itself. So the list has to be carried per product —
   * there is no universal vocabulary to fall back on, and a type not declared
   * upstream is a 400 from `/admin/entities/{type}`.
   *
   * Verified against `mark8ly/admin-conformance.json` and
   * `kora/admin-conformance.json`.
   */
  readonly entities: readonly string[];
  /**
   * Whether the product declares the §3.1 `kpis` endpoint.
   *
   * Per-product and declared rather than assumed: a product may implement the
   * contract without a business-metrics surface at all, and asking one that
   * does not is a 404 on a page whose whole content is that read.
   *
   * This is the DECLARATION, not the runtime answer. Kora declares `kpis` and
   * its implementation currently answers 501 ("uninstrumented"), which is a
   * state a renderer shows; it is not a reason to record the declaration as
   * absent, because that would make the console stop asking and never notice
   * when it is instrumented.
   */
  readonly kpis: boolean;
}

// `as const satisfies Record<string, ProductEntry>` for the reason `ROUTES`
// gives: it keeps the literal keys so `ProductId` is a real union, while still
// checking every entry against the shape. Annotating the table as
// `Record<string, ProductEntry>` would widen the keys to `string` and collapse
// `ProductId` into it.
export const PRODUCTS = {
  kora: {
    source: "kora",
    label: "Kora",
    nav: koraNav,
    // `users` and `foods`, in the order kora's declaration lists them.
    // `foods` is Kora-specific and is the clearest illustration of why this
    // list cannot be shared: no other product has it.
    entities: ["users", "foods"],
    // Declared in kora/admin-conformance.json. Answers 501 today — see
    // `ProductEntry.kpis` for why that is not recorded as `false`.
    kpis: true,
  },
  mark8ly: {
    source: "mark8ly",
    label: "Mark8ly",
    nav: mark8lyNav,
    // `tenants` here is mark8ly's §3.4 entity type — the federated read. It is
    // NOT `platform.tenants`, which is the estate-wide directory on the
    // platform rail. Same word, two surfaces; routes.ts records the same
    // distinction on those two route ids.
    entities: ["tenants", "users"],
    kpis: true,
  },
} as const satisfies Record<string, ProductEntry>;

export type ProductId = keyof typeof PRODUCTS & string;

/**
 * Every product id, for exhaustive iteration.
 *
 * Derived from `PRODUCTS` rather than listed, for the reason `ROUTE_IDS` is
 * derived from `ROUTES`: a hand-maintained copy stops covering new entries
 * without failing, which quietly narrows every guard built on it.
 */
export const PRODUCT_IDS = Object.keys(PRODUCTS) as readonly ProductId[];

// Same widening problem `getRoute` documents in routes.ts: indexing PRODUCTS
// with the union yields a union of each entry's exact literal type, not a
// uniform ProductEntry. The explicit return type re-widens.
function getProduct(id: ProductId): ProductEntry {
  return PRODUCTS[id];
}

/** The federation slug to send as `?source=` — see `ProductEntry.source`. */
export function productSource(id: ProductId): string {
  return getProduct(id).source;
}

/** Display name — see `ProductEntry.label`. */
export function productLabel(id: ProductId): string {
  return getProduct(id).label;
}

/** The product's rail — see `ProductEntry.nav`. */
export function productNav(id: ProductId): readonly NavEntry[] {
  return getProduct(id).nav;
}

/**
 * The entity types this product declares — see `ProductEntry.entities`.
 *
 * An accessor rather than exported table access, for the reason `isPending`
 * is one: a caller that reached into the table would be free to read a
 * missing product as "no types", and "this product serves no records" is a
 * very different statement from "this product is not in the registry".
 */
export function productEntities(id: ProductId): readonly string[] {
  return getProduct(id).entities;
}

/** Whether the product declares §3.1 `kpis` — see `ProductEntry.kpis`. */
export function productDeclaresKpis(id: ProductId): boolean {
  return getProduct(id).kpis;
}

/**
 * A rail the console can render: every product, plus the platform rail.
 *
 * `"platform"` is not a product and must not become one — it has no federation
 * slug, no entity types and no `admin-conformance.json`, because it IS the
 * estate rather than a source within it. Adding it to `PRODUCTS` would mean
 * inventing all three. So the rail set is the product set plus one, expressed
 * here as a union rather than by loosening the product table.
 */
export type RailId = ProductId | "platform";

/**
 * Every rail, platform first.
 *
 * Platform leads because it is the console's default context and the one its
 * own home page serves; the products follow in registry order. Derived from
 * `PRODUCT_IDS`, so adding a product to the registry is the only change a new
 * rail needs — which is the point of this module.
 */
export const RAIL_IDS: readonly RailId[] = ["platform", ...PRODUCT_IDS];

/**
 * The rail's nav entries.
 *
 * Lives here rather than in `nav.ts` because it must know about `PRODUCTS`,
 * and `PRODUCTS` imports the rails from `nav.ts` as values — putting this the
 * other way round would make the two modules a runtime cycle. `nav.ts` stays
 * the file that DECLARES rails; this is the file that indexes them.
 */
export function railNav(id: RailId): readonly NavEntry[] {
  return id === "platform" ? platformNav : productNav(id);
}
