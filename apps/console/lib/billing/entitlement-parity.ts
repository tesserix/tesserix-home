/**
 * The entitlement parity comparator: the console's stored plan-feature matrix
 * in, the product's compiled one in, a structured diff out.
 *
 * # A pure function, deliberately, and the same one `parity.ts` is
 *
 * No I/O, no database, no `server-only` import — not even a type import that
 * reaches one. The reasoning is `parity.ts`'s verbatim and both halves still
 * apply: it is exhaustively testable without a network, and it keeps no server
 * ancestry, so a console surface can render a stored report without dragging
 * `pg` into a browser bundle. `lib/money.ts` records what that costs when it
 * is got wrong — `tsc` and the whole vitest suite pass either way, and only
 * `next build` sees it.
 *
 * # ABSENCE IS NOT ZERO. This is the whole reason the module exists
 *
 * `0` is Disabled AND is the zero value of `value integer` — 0052's header and
 * `plangate`'s `IsAllowed` both turn on that. So the one thing this comparator
 * must never do is let a missing cell stand in for a disabled one: a console
 * whose rows failed to load would then compare parity-clean against a matrix
 * that disables everything, and the surface would say "the console agrees with
 * the gate" about a console holding nothing at all. A side that has no cell is
 * reported as `null` on that side, always, and the union below is what
 * guarantees a cell present on ONE side is still a cell that gets compared.
 *
 * It REPORTS; it never throws on a difference and never asserts equality — a
 * difference is a finding to be written to `plan_catalog_parity_runs` and read
 * by a human, not an exception that leaves the record with a hole in it.
 */

/**
 * One cell of the console's stored matrix.
 *
 * Structurally `EntitlementRow` from `lib/db/plan-catalog-repo.ts`, and named
 * here rather than imported from it for the module-ancestry reason above:
 * `plan-catalog-repo` is `server-only` and importing it — even as a type —
 * puts this module one edit away from carrying `pg` into a bundle. The same
 * split `parity.ts` keeps with `CatalogAmount`.
 */
export interface EntitlementCell {
  readonly plan: string;
  readonly feature: string;
  /** ONE integer read two ways: `0` Disabled, `-1` Unlimited, `-2`
   *  Negotiated, positive n a cap. Never normalised here. */
  readonly value: number;
}

/** Plan name -> feature name -> value, exactly as `EntitlementMatrix.plans`
 *  carries it. Typed structurally so this module needs no import from
 *  `lib/billing.ts` either. */
export type ProductMatrix = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * One `(plan, feature)` cell the two sides disagree about.
 *
 * Both sides are named on every difference, and `null` means THAT SIDE HAS NO
 * CELL — never "that side says zero". A reader who cannot tell those apart
 * cannot act on the row: one is a seed that never ran, the other is a policy
 * decision.
 */
export interface EntitlementDifference {
  readonly plan: string;
  readonly feature: string;
  readonly consoleValue: number | null;
  readonly productValue: number | null;
}

/** `plan` and `feature` are both free text at this layer, so they are joined
 *  on NUL rather than on a dot — which `plan.feature` would leave ambiguous
 *  for any name carrying one. */
function cellKey(plan: string, feature: string): string {
  return `${plan}\u0000${feature}`;
}

/**
 * Compare the console's stored entitlements against a product's compiled
 * matrix.
 *
 * Over the UNION of both key sets, so a cell present on only one side is
 * reported rather than dropped. Iterating either side alone is the bug this
 * shape exists to prevent: over the product's cells alone, a console row for a
 * feature the gate no longer has is invisible; over the console's alone, an
 * entire unseeded plan reads as agreement.
 *
 * Sorted by plan then feature, so the same drift produces the same report
 * twice and an operator comparing two runs sees drift rather than a reshuffle.
 */
export function compareEntitlements(
  consoleRows: readonly EntitlementCell[],
  productMatrix: ProductMatrix,
): EntitlementDifference[] {
  const consoleValues = new Map<string, number>();
  const cells = new Map<string, { plan: string; feature: string }>();

  for (const row of consoleRows) {
    const key = cellKey(row.plan, row.feature);
    consoleValues.set(key, row.value);
    cells.set(key, { plan: row.plan, feature: row.feature });
  }
  for (const [plan, features] of Object.entries(productMatrix)) {
    for (const feature of Object.keys(features)) {
      cells.set(cellKey(plan, feature), { plan, feature });
    }
  }

  const differences: EntitlementDifference[] = [];
  for (const [key, { plan, feature }] of cells) {
    // `has`, never a truthiness test or a `?? null` on the value: `0` is a
    // stored Disabled, so a falsy read would report every disabled cell as
    // missing — and, worse, would let a missing one pass as disabled.
    const consoleValue = consoleValues.has(key) ? (consoleValues.get(key) as number) : null;
    const productCells = productMatrix[plan];
    const productValue =
      productCells !== undefined && Object.hasOwn(productCells, feature)
        ? productCells[feature]
        : null;
    if (consoleValue !== productValue) {
      differences.push({ plan, feature, consoleValue, productValue });
    }
  }

  return differences.sort(
    (a, b) => a.plan.localeCompare(b.plan) || a.feature.localeCompare(b.feature),
  );
}
