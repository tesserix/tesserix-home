/**
 * The Product filter's "no product assigned" option.
 *
 * A sentinel rather than an empty string because an absent `product` key
 * already means "no product filter at all" (filterClause adds no clause),
 * and the two must stay distinguishable: one means "every row", the other
 * means "only rows with a null product". Every import and every migrated
 * lead lands with a null product, so without this option the filter hides
 * exactly the rows an operator is most likely looking for.
 *
 * Lives in its own module because both the repo (server) and the filter bar
 * (client) compare against it, and a duplicated literal that drifts by one
 * character fails silently — the filter would simply match nothing.
 */
export const UNASSIGNED_PRODUCT = "__unassigned__";

/**
 * The "no product chosen yet" option on a product *picker* (as opposed to
 * `UNASSIGNED_PRODUCT`, which is a *filter* value). Radix's `Select` cannot
 * hold an empty-string item value (see `components/kit/filter-bar.tsx`), so
 * the pickers carry this sentinel and strip it back to `undefined` before
 * the write.
 *
 * Lives here, next to `UNASSIGNED_PRODUCT`, for the same reason: three
 * modules compared against their own copy of the literal — the new-org form,
 * the action that reads its `FormData`, and the detail view's
 * new-opportunity form — and a copy that drifts by one character fails
 * silently, writing "__none__" into `crm_opportunities.product` as if it
 * were a real product. A `"use server"` file may only export async
 * functions, so the action layer cannot be the home for it.
 */
export const NO_PRODUCT_VALUE = "__none__";

/**
 * Follower bands for the browse surface's `followers` filter.
 *
 * Bounds are inclusive integers, not the raw `[min, max)` half-open ranges
 * seen elsewhere in this file's neighbourhood — `max: null` on the top band
 * means "no upper bound" rather than "exclusive infinity", which keeps the
 * repo's `BETWEEN`-style predicate simple. A NULL `followers_count` matches
 * none of these bands; the repo adds that `IS NOT NULL` explicitly rather
 * than this module trying to encode "absent" as a band.
 *
 * Exported (not inlined in the repo) because the filter bar (Task 6) needs
 * the same labels and bounds to render its options — a second, hand-copied
 * copy of "1000" and "9999" is how a band's edge drifts out of sync with
 * what the repo actually filters on.
 */
export const FOLLOWER_BANDS = {
  under1k: { label: "Under 1k", min: 0, max: 999 },
  k1to10k: { label: "1k–10k", min: 1000, max: 9999 },
  over10k: { label: "10k+", min: 10000, max: null },
} as const;

export type FollowerBand = keyof typeof FOLLOWER_BANDS;

export function isFollowerBand(value: string): value is FollowerBand {
  return Object.hasOwn(FOLLOWER_BANDS, value);
}
