// `server-only` for the same reason `lib/db/tesserix.ts` carries it: this
// module reaches `pg`, and a client component that reaches it must fail the
// build with the import chain named rather than `Can't resolve 'net'` from
// somewhere inside the driver.
import "server-only";

import type { Difference, CatalogAmount, TaxBehavior } from "@/lib/billing/parity";
import { tesserixQuery } from "./tesserix";

/**
 * The two statements the parity check needs: read the expected side, record
 * what the comparison found.
 *
 * Kept out of `lib/billing/parity.ts` on purpose — that module is a pure
 * function with no server ancestry so P1b can render a report from a client
 * component, and one `pg` import here would end that property for both.
 */

interface AmountRow {
  lookup_key: string;
  currency: string;
  /** `bigint` arrives from `pg` as a STRING, because a `bigint` does not fit a
   *  JS number in general. See {@link toMinorUnits} for why this one does. */
  unit_amount_minor: string;
  tax_behavior: TaxBehavior;
}

/**
 * Narrow a `bigint` column to the `number` the comparator compares with.
 *
 * Stripe's `unit_amount` is a JS number, so the narrowing has to happen
 * somewhere; doing it HERE, at the boundary, means the comparator never sees a
 * value it cannot compare. The catalog's largest amount is IDR annual at
 * 1,198,800,000 — five orders of magnitude inside `Number.MAX_SAFE_INTEGER` —
 * but the guard is explicit rather than assumed, because "one currency
 * devaluation away" is exactly why part 1 chose `bigint` for the column.
 *
 * Throwing is right here and would be wrong in the comparator: this is a read
 * that cannot produce a usable value, and the route turns it into a `failed`
 * run with a reason. Silently rounding would produce a `clean` run that
 * compared the wrong number.
 */
function toMinorUnits(raw: string, lookupKey: string, currency: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `plan_catalog_amounts.unit_amount_minor for ${lookupKey}/${currency} exceeds the safe integer range`,
    );
  }
  return value;
}

/**
 * Every catalog amount, joined to the `lookup_key` it belongs to.
 *
 * 78 rows across 42 keys. The fan-out is not collapsed here — the comparator
 * groups them, because grouping is part of the comparison it is tested on.
 *
 * Ordered so a report reads the same way twice; the comparator sorts its own
 * output, but a deterministic read makes a `psql` session diffable too.
 */
export async function readCatalogAmounts(): Promise<CatalogAmount[]> {
  const rows = await tesserixQuery<AmountRow>(
    `SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_amounts a
       JOIN plan_catalog_prices p ON p.id = a.price_id
      ORDER BY p.lookup_key, a.currency`,
  );
  return rows.map((row) => ({
    lookupKey: row.lookup_key,
    currency: row.currency,
    unitAmountMinor: toMinorUnits(row.unit_amount_minor, row.lookup_key, row.currency),
    taxBehavior: row.tax_behavior,
  }));
}

/** The three states `0033`'s CHECK admits. Not a boolean — a run that could
 *  not reach Stripe is not clean, and must not be storable as if it were. */
export type ParityOutcome = "clean" | "differences" | "failed";

export interface ParityRun {
  readonly outcome: ParityOutcome;
  /** Empty on `clean` and on `failed`; a failed run produced no comparison. */
  readonly differences: readonly Difference[];
  /** Non-null exactly when `outcome` is `failed`, per 0033's CHECK. */
  readonly error: string | null;
}

/**
 * Write one run.
 *
 * `difference_count` is derived HERE rather than taken from the caller, so the
 * count and the report cannot disagree at the call site. 0033 additionally
 * refuses a row where they do — belt and braces, because the window's whole
 * value is that these rows can be trusted a week later.
 *
 * This function DOES throw. Every other failure in the check becomes a stored
 * `failed` row, but a write that fails has nowhere to store anything; the
 * route turns that into a 500 so the CronJob's own alerting covers the gap.
 */
export async function recordParityRun(run: ParityRun): Promise<void> {
  await tesserixQuery(
    `INSERT INTO plan_catalog_parity_runs (outcome, difference_count, differences, error)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [run.outcome, run.differences.length, JSON.stringify(run.differences), run.error],
  );
}
