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
