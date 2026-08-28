// `server-only` for the same reason `publish-executor.ts` and
// `publish-repo.ts` carry it: this module reaches `pg` (through
// `archivedStripePriceIds`) and `stripe` (through `stripe-read.ts`) via its
// default dependencies. A client component that reaches it must fail the
// build with the import chain named rather than `Can't resolve 'net'` from
// inside either driver.
import "server-only";

import { archivedStripePriceIds, type ArchivedStripePrice } from "@/lib/db/publish-repo";
import type { StripePriceLike } from "./parity";
import { SINGLE_SOURCE } from "./source-policy";
import { stripePriceReader, type StripeMode } from "./stripe-read";

/**
 * Orphan detection: the ONE thing the parity check (`parity.ts`) is
 * structurally unable to see.
 *
 * # The blind spot, precisely
 *
 * `compareCatalogToStripe` only ever looks at Prices that carry a
 * `lookup_key` — that is how it joins Stripe's observed side back to the
 * catalog's expected side at all. A `replace_price` operation
 * (`publish-plan.ts`) creates a NEW Price, moves the lookup key onto it with
 * `transfer_lookup_key`, and archives the OLD id — and 0038's header names
 * the failure mode this module exists to catch: if that archive call never
 * lands (a crash between the create succeeding and the archive being made,
 * or the archive call itself failing), the old Price is left `active: true`
 * with NO lookup key. The comparator has nothing to join it against, so a
 * parity run reports `clean` — correctly, by its own rules — while an
 * abandoned Price with a live Subscription attached to it keeps billing
 * forever, invisible to the one check that exists to catch drift.
 *
 * # Why this is a cross-reference, not a Stripe scan
 *
 * The universe of "every Price Stripe considers active" is not what this
 * asks. It asks a narrower, answerable question: of the Price ids THIS
 * CATALOG'S OWN LOG believes it archived (`archivedStripePriceIds`,
 * `publish-repo.ts`), which ones does Stripe still consider active? An id
 * Stripe reports active that the log never touched is not this module's
 * concern — it might be a different product's Price, or a Price this
 * catalog has simply never interacted with, and `findOrphans` has no basis
 * to say anything about it either way.
 */

/** One archived-in-the-log-but-active-in-Stripe Price. */
export interface Orphan {
  readonly priceId: string;
  readonly lookupKey: string | null;
  readonly source: string;
}

/**
 * Both dependencies `findOrphans` needs, injected — the same discipline
 * `PublishExecutorDeps` (`publish-executor.ts`) uses and for the identical
 * reason: this file's own test never touches a real database or the
 * network, only `defaultOrphanDetectorDeps`'s wiring does, and that wiring
 * is exercised through the integration suites for `publish-repo.ts` and
 * `stripe-read.ts` individually rather than here.
 */
export interface OrphanDetectorDeps {
  archivedPrices(mode: StripeMode): Promise<readonly ArchivedStripePrice[]>;
  activePrices(mode: StripeMode): Promise<readonly StripePriceLike[]>;
}

export const defaultOrphanDetectorDeps: OrphanDetectorDeps = {
  archivedPrices: (mode) => archivedStripePriceIds(mode, SINGLE_SOURCE),
  activePrices: (mode) => stripePriceReader.listPrices(mode),
};

/**
 * The archived-in-the-log ids that Stripe still reports `active` for
 * `mode` — see this module's header for what that combination means and why
 * `parity.ts` cannot find it on its own.
 *
 * A `Set` over `activePrices`' ids, not a second query per archived row:
 * `stripePriceReader.listPrices` already pages through every active Price
 * for the mode in one call (`stripe-read.ts`), so cross-referencing in
 * memory here is one Stripe call total rather than one per candidate — the
 * same reasoning `parity.ts`'s comparator applies to its own observed side.
 */
export async function findOrphans(
  mode: StripeMode,
  deps: OrphanDetectorDeps = defaultOrphanDetectorDeps,
): Promise<Orphan[]> {
  const [archived, active] = await Promise.all([
    deps.archivedPrices(mode),
    deps.activePrices(mode),
  ]);
  const activeIds = new Set(active.map((p) => p.id));

  return archived
    .filter((entry) => activeIds.has(entry.stripePriceId))
    .map((entry) => ({
      priceId: entry.stripePriceId,
      lookupKey: entry.lookupKey,
      source: entry.source,
    }));
}
