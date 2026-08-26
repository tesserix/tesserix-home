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
  /**
   * May the console's identity lookup return this product's END USERS —
   * its customers, patients, residents, leads — as opposed to the staff and
   * operators who run it?
   *
   * Optional, defaulting to FALSE, and no product declares `true` today. The
   * default is the entire mechanism: a product is excluded from end-user
   * lookup because it has not declared itself in, not because a list somewhere
   * remembered to leave it out. Exclusion by absence cannot be forgotten; a
   * denylist can, and gets edited by whoever is adding a product in a hurry.
   *
   * WHY DEFAULT FALSE — what this protects.
   *
   * HMS is the sharpest case, and the reason the default is not "true for
   * everything we already query". Its patients are Data Principals, and the
   * product enforces their protections in layers the console cannot see from
   * here: row-level security on the tables, OpenFGA checks that a care
   * relationship actually exists between this clinician and this patient,
   * facility and department scoping, ABAC on top of that, and consent-based
   * sharing that the patient can withdraw. A console-level "find this person
   * everywhere" is, by construction, a query that answers before any of those
   * run. It would either bypass them outright or have to be built as
   * break-glass — a deliberate, time-boxed override carrying its own audit
   * trail and its own justification field. Neither is a default.
   *
   * HMS #808 sharpens it further: it makes the CRM boundary a LAWFUL-BASIS
   * boundary, not a storage one. Contacts sit under legitimate interest and
   * marketing consent; clinical data sits under DPDP health processing. Those
   * are different legal grounds for holding the same human's data. Joining
   * them into one identity graph does not merely widen a query — it merges two
   * lawful bases into a single record with no basis of its own, which is the
   * kind of thing that is hard to un-merge once an operator has read it.
   *
   * The other six products are at the default for the ordinary reason: nobody
   * has decided yet. That is the intended state. Flipping this to `true` is a
   * decision a product makes about its own users, recorded here in the commit
   * that makes it, with the reasoning beside it — and `estate.test.ts` fails
   * the moment one does, so the flip cannot land silently.
   *
   * Note the honest limit of this field, which is stated in the issue and
   * accepted: the CONSOLE declares on the product's behalf. It is weaker than
   * the product declaring through an API of its own. It holds because v1
   * returns no end-user rows at all, so there is nothing yet for a product API
   * to serve. When products do serve end-user lookup, this field stays the
   * gate and their API becomes the source.
   */
  readonly endUserLookup?: boolean;
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
    // 8 is apps/web's rail, which is what this field means while `migrated` is
    // false — EstateMap renders it as "8 rail entries · still in apps/web", and
    // apps/web really does ship eight.
    //
    // NOT revised to 3 yet, though the mark8ly integration design does revise
    // it: that 3 is the console rail's target (CSM migration fast-path review,
    // arbitrage appeals, app credentials), and none of the three has a contract
    // endpoint to render from — the fast-path review route is written but
    // unmounted upstream (tesserix/mark8ly#281), and the other two live on
    // mark8ly's own admin surface rather than /admin/*. Writing 3 here today
    // would put "3 rail entries · still in apps/web" on a status board whose
    // whole job is being honest about what has actually moved.
    //
    // When `mark8lyNav` lands, this becomes `mark8lyNav.length` and gets the
    // same test kora has — the count checked against the nav it actually ships
    // rather than transcribed.
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
    // 3, down from 4, down from 5. Both reductions are the same rule applied
    // twice: #139 retired the audit trail into the estate-wide audit log, and
    // Kora's feedback is now one half of what its own `/admin/inbox` already
    // merges, so it belongs in the estate Inbox (§8.5, tesserix/kora#474).
    //
    // Neither capability LEFT the console — both moved to a platform surface,
    // which is not counted in any product's rail. A falling count here reads as
    // loss and is the opposite: it is consolidation. Checked against
    // koraNav.length in estate.test.ts.
    entries: 3,
    migrated: true,
    summary: "Food index and users; its audit trail and feedback are in the estate-wide audit log and inbox.",
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
    // No `endUserLookup` declaration — and deliberately no explicit `false`
    // either. Writing `endUserLookup: false` here would make HMS the product
    // that was remembered, which is the convention this field replaces: it
    // reads as a special case, and a special case is something a future edit
    // can decide no longer applies. HMS is excluded by the same absence as
    // every other product. See `EstateProduct.endUserLookup` for why patient
    // data in particular must not be reachable this way.
    summary: "No rail yet. Healthcare platform in build; billing metadata is specified to live in a shared, PHI-free control plane.",
  },
] as const;

/** Products still rendering from `apps/web`'s own nav config. */
export function unmigrated(): readonly EstateProduct[] {
  return ESTATE.filter((product) => !product.migrated);
}

/**
 * Does this entry DECLARE end-user lookup?
 *
 * The one place the optional field is read, so the `undefined`-means-no
 * decision is made once. `=== true` rather than a truthiness check: only the
 * literal boolean counts as a declaration.
 *
 * Exported as a pure predicate over an entry — separate from the
 * context-keyed accessor below — so it can be exercised against a product that
 * DOES declare, without a product in ESTATE having to declare one. A test that
 * can only ever observe `false` cannot tell the difference between a field
 * that defaults to false and a function that returns false.
 */
export function declaresEndUserLookup(product: EstateProduct): boolean {
  return product.endUserLookup === true;
}

/**
 * May the identity lookup return end-user rows for this rail context?
 *
 * An accessor rather than exported table access, for the same reason
 * `routeCapability` is one in `routes.ts`: callers get the default applied for
 * them, so a product without a declaration can never be read as `undefined` —
 * a value that is falsy in an `if` but passes a `!== false` check, and which
 * the day someone writes `if (product.endUserLookup !== false)` becomes an
 * accidental opt-in for every product at once.
 *
 * Fails closed on an unknown context. A caller asking about a product this
 * package has never heard of gets `false`, not a throw and not a permissive
 * fallback: "we do not know this product" and "this product has not opted in"
 * deserve the same answer, and it is no.
 *
 * The console has no end-user lookup to gate yet — v1 returns staff and
 * operators only. This ships with the field so that when the first product
 * opts in, the gate already exists and is already tested, rather than being
 * written by whoever is also writing the feature that wants it open.
 */
export function allowsEndUserLookup(context: string): boolean {
  const product = ESTATE.find((entry) => entry.context === context);
  return product !== undefined && declaresEndUserLookup(product);
}

/**
 * Every product currently declaring end-user lookup. Empty today, deliberately.
 *
 * Exported so a renderer or a test can state the whole set rather than probing
 * it one context at a time — a probe only covers the products someone thought
 * to name, which is the failure mode this field exists to remove.
 */
export function endUserLookupProducts(): readonly EstateProduct[] {
  return ESTATE.filter(declaresEndUserLookup);
}
