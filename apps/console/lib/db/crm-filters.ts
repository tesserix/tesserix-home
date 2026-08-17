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
