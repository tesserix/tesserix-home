import { describe, expect, it } from "vitest";

import type { ArchivedStripePrice } from "@/lib/db/publish-repo";
import type { StripePriceLike } from "./parity";
import { findOrphans, type OrphanDetectorDeps } from "./orphans";
import { SINGLE_SOURCE } from "./source-policy";

/**
 * `findOrphans`'s whole test surface: both dependencies are injected (see
 * `OrphanDetectorDeps` below), the same discipline `publish-executor.test.ts`
 * uses for `PublishExecutorDeps` — no `tesserixTx`, no `stripe` import, no
 * `vi.mock`. This is the parity blind spot itself under test (0038's header,
 * spec §9.2): a Price the log believes it archived, but that Stripe still
 * reports `active`, is invisible to `parity.ts` forever, because the
 * comparator only ever looks at `lookup_key`-bearing Prices and an archived
 * id has none. Nothing here is provable from `parity.test.ts`'s fixtures —
 * this module exists because that comparator structurally cannot see it.
 */

const OLD_PRICE_ID = "price_archived_1";
const OTHER_ARCHIVED_PRICE_ID = "price_archived_2";

function price(id: string): StripePriceLike {
  return {
    id,
    lookup_key: null,
    currency: "usd",
    unit_amount: 1000,
    tax_behavior: "unspecified",
    active: true,
  };
}

/** A fake log holding exactly the archived rows a test wants to see, and a
 *  fake Stripe read returning exactly the ids a test wants to call "still
 *  active" — mirrors `defaultOrphanDetectorDeps`'s two dependencies one for
 *  one, so a test never has to touch a real database or the network to
 *  prove `findOrphans` cross-references them correctly. */
function makeDeps(params: {
  archived: readonly ArchivedStripePrice[];
  activeIds: readonly string[];
}): OrphanDetectorDeps {
  return {
    archivedPrices: async () => params.archived,
    activePrices: async () => params.activeIds.map(price),
  };
}

describe("findOrphans", () => {
  it("finds a price that was archived in the log but is still active in Stripe", async () => {
    // THE failure the parity check structurally cannot see: parity.ts skips
    // every price with a null lookup_key, and a transferred-away price has
    // one — this is what a `replace_price` leaves behind on the OLD id once
    // `transfer_lookup_key` has moved the key to the new Price. A publish
    // that reports `succeeded` here, with the matching `archive` call never
    // having landed (or having landed against the wrong id), leaves exactly
    // this: a row the log calls archived, still `active: true` in Stripe.
    const deps = makeDeps({
      archived: [{ stripePriceId: OLD_PRICE_ID, lookupKey: "mark8ly_pro_monthly_developed_v1", source: SINGLE_SOURCE }],
      activeIds: [OLD_PRICE_ID],
    });

    const orphans = await findOrphans("test", deps);

    expect(orphans.map((o) => o.priceId)).toEqual([OLD_PRICE_ID]);
  });

  it("finds nothing when every archived price really is archived", async () => {
    const deps = makeDeps({
      archived: [{ stripePriceId: OLD_PRICE_ID, lookupKey: "mark8ly_pro_monthly_developed_v1", source: SINGLE_SOURCE }],
      activeIds: [],
    });

    await expect(findOrphans("test", deps)).resolves.toEqual([]);
  });

  it("only reports the archived ids that are ALSO active — an active price the log never touched is not an orphan", async () => {
    const deps = makeDeps({
      archived: [
        { stripePriceId: OLD_PRICE_ID, lookupKey: "mark8ly_pro_monthly_developed_v1", source: SINGLE_SOURCE },
        { stripePriceId: OTHER_ARCHIVED_PRICE_ID, lookupKey: "mark8ly_starter_annual_developed_v1", source: SINGLE_SOURCE },
      ],
      // A THIRD id, never mentioned in the log at all, is live for an
      // unrelated reason — findOrphans only ever cross-references the log's
      // OWN archived ids, never enumerates everything Stripe considers
      // active.
      activeIds: [OLD_PRICE_ID, "price_unrelated_and_never_archived"],
    });

    const orphans = await findOrphans("test", deps);

    expect(orphans.map((o) => o.priceId)).toEqual([OLD_PRICE_ID]);
  });
});
