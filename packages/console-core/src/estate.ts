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
  /**
   * Where `entries` was COUNTED from — which is not the same question as
   * `migrated`, and conflating them is what made the estate map lie.
   *
   * Until tesserix-home#406 there were only two states and `migrated` could
   * stand in for both: a migrated product's count came from console-core, an
   * unmigrated one's came from apps/web's rail. Mark8ly is now a third:
   * `entries` is `mark8lyNav.length`, counted from console-core, while
   * `migrated` stays false because the rail has not shipped — its one entry
   * is `pending`, and `routes.ts` is explicit that a pending entry links
   * NOWHERE, "not in-app (the page does not exist) and not to apps/web
   * either". Rendering "· still in apps/web" off `migrated` therefore made a
   * false claim about a count that did not come from apps/web and does not
   * point there.
   *
   * OPTIONAL, and absence means `"apps/web"` — the meaning every existing
   * entry already had, so no other product changes. Declare it only when the
   * count is derived from a console-core nav.
   */
  readonly entriesFrom?: "console-core" | "apps/web";
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
  /**
   * The contract endpoints this product's rail renders from (design D4).
   *
   * Optional, and the absence is the mechanism, exactly as it is for
   * `endUserLookup` above: absence means the product declares none, so a
   * product is excluded because it has not declared itself in rather than
   * because a list somewhere remembered to leave it out. The rail renders only
   * what is declared here — a product's rail IS its declaration — so a later
   * product joining costs the console one line rather than a new branch.
   *
   * Additive and optional on purpose. `console-core` compiles into three apps
   * (web, mobile, console); a required field here would be a compile error in
   * every one of them for a mechanism only one product uses today.
   *
   * NOT a claim about everything the product implements. Mark8ly is
   * conformant across far more of the contract than it declares here; what
   * this field carries is what the console renders, which is the only thing
   * this package can check.
   */
  readonly contracts?: readonly ContractId[];
}

/**
 * An endpoint id from the product-admin integration contract's closed
 * vocabulary — what a product DECLARES it implements, not a path.
 *
 * Deliberately narrow: it names only the ids this package renders a rail from
 * today. The contract's own vocabulary is seventeen ids (v3, 2026-08-29) and
 * lives in `@tesserix/admin-conformance`'s `contract.ts`, which is not in this
 * repo — restating all seventeen here would create a second copy of a closed
 * vocabulary that this package cannot check itself against, and the copy would
 * drift the way `estate.ts`'s own transcribed numbers already have.
 *
 * ADD, NEVER RENAME — the rule `contract.ts` states for itself, and it binds
 * here for a sharper reason: a renamed id turns a product's declaration into
 * "not implemented", which the conformance suite reports as a PASS. A typo is
 * therefore silent in both directions, so this union exists to make an id a
 * compile-time fact rather than a string a rail happened to spell right.
 */
export type ContractId = "inbox";

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
    // 1, down from 8 — and the number now means something different, which is
    // the change, not the digit.
    //
    // WHAT #405 ESTABLISHED, AND STILL HOLDS. While `migrated` is false this
    // field meant "apps/web's rail", because that is where the IA still lived
    // and EstateMap renders it as "N rail entries · still in apps/web". On
    // that reading 8 was right and the design's 3 would have been a forecast
    // printed on a status board whose whole job is being honest about what has
    // actually moved. apps/web really does ship eight, and still does.
    //
    // WHAT CHANGED FIRST (tesserix-home#405, 2026-08-30). This comment used to
    // say all three of the design's targets lacked an endpoint, citing
    // tesserix/mark8ly#281 as unmounted. **That issue is closed.**
    // `platformadmin/routes.go:294` mounts `NewInboxActionsHandler` and
    // `inbox_action_migration.go` implements the `migration_fast_path` kind,
    // with route tests over it — and both routes answer 401 rather than 404 in
    // production, against a control of 404 for an invented path. So one of the
    // three has a contract endpoint to render from.
    //
    // The realistic target is therefore ONE entry, not three, and the other
    // two are deferred BY DECISION rather than by absence — the integration
    // design §5: arbitrage appeals and app credentials "are not on the list…
    // /admin/inbox already carries the appeal queue as a `kind`. A dedicated
    // surface for either is reassessed after the queue lands." App
    // credentials additionally live on mark8ly's own admin surface rather
    // than /admin/*, and need a `rotate-credentials` capability that does not
    // exist. See `mark8lyNav` for the same record in the file that would
    // otherwise look two entries short.
    //
    // WHAT CHANGED SECOND (tesserix-home#406). `mark8lyNav` now exists, so
    // there is a console-side rail to count and this literal is CHECKED
    // against it — `estate.test.ts` fails the moment the two disagree, the
    // same guard Kora's 4 has had since #139. A literal rather than an import
    // of `mark8lyNav.length`, exactly as Kora does it: estate.ts stays free of
    // a runtime dependency on nav.ts, and the test is what makes the number
    // trustworthy. That is the whole point of the change — the previous 8 was
    // TRANSCRIBED, which is precisely why the citation above could go stale
    // for a fortnight with nobody noticing. A comment naming an issue number
    // is making a checkable claim; a number nothing checks is worse.
    //
    // KNOWN COLLISION, recorded rather than papered over. `migrated` stays
    // false — correctly: nothing renders `mark8lyNav` yet, the one route is
    // `pending`, and the field means what it says. But that leaves EstateMap
    // rendering "1 rail entry · still in apps/web", and this one entry is not
    // in apps/web at all. The card is now understating mark8ly's eight web
    // entries in order to state the console's one. Deriving from the rail was
    // asked for by #405 and #406 both, and it is the right mechanism; the
    // stale half is EstateMap's suffix, which assumes a product's rail lives
    // in exactly one of two places. Fixing that is a separate change to
    // apps/console — out of scope here, and named so the next reader finds a
    // known wart rather than a fresh bug.
    entries: 1,
    migrated: false,
    // Counted from `mark8lyNav`, not from apps/web's eight — see
    // `entriesFrom`'s own doc for why this had to become explicit rather than
    // being inferred from `migrated`. This is what stops the estate map
    // rendering "1 rail entry · still in apps/web", which was false in both
    // halves: the count is not apps/web's, and the entry it counts is
    // `pending` and links nowhere.
    entriesFrom: "console-core",
    // The one contract endpoint the rail renders from. `inbox` and not also
    // the actions endpoint: `POST /admin/inbox/{id}/actions/{actionId}` is
    // v2's way of invoking an action an inbox item already declares, not a
    // separate declarable id — the same reason the contract makes
    // `purge/preview` not a separate id from `tenant-purge`.
    //
    // Under-declared on purpose relative to what mark8ly implements: its
    // `Platform integration v1` milestone closed conformant across most of
    // the vocabulary. This field carries what the CONSOLE renders, which is
    // the only half this package can check — see `EstateProduct.contracts`.
    contracts: ["inbox"],
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
    // 4, up from 3, down from 5 before that. The two retirements are the
    // same rule applied twice: #139 retired the audit trail into the
    // estate-wide audit log, and Kora's feedback is now one half of what its
    // own `/admin/inbox` already merges, so it belongs in the estate Inbox
    // (§8.5, tesserix/kora#474). Neither capability LEFT the console — both
    // moved to a platform surface, which is not counted in any product's
    // rail.
    //
    // The rise back to 4 is Kora's own: `kora.aiMetrics` is a real fourth
    // page, the full surface behind the overview's AI-resolution tiles.
    // Checked against koraNav.length in estate.test.ts, so this literal
    // tracks the rail rather than needing to be remembered by hand.
    entries: 4,
    migrated: true,
    summary: "Food index, users and AI metrics; its audit trail and feedback are in the estate-wide audit log and inbox.",
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
