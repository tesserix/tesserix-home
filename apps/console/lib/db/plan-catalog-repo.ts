// `server-only` for the same reason `lib/db/tesserix.ts` carries it: this
// module reaches `pg`, and a client component that reaches it must fail the
// build with the import chain named rather than `Can't resolve 'net'` from
// somewhere inside the driver.
import "server-only";

import type { Difference, CatalogAmount, TaxBehavior } from "@/lib/billing/parity";
import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { tesserixQuery } from "./tesserix";

/**
 * The two statements the parity check needs: read the expected side, record
 * what the comparison found.
 *
 * Kept out of `lib/billing/parity.ts` on purpose — that module is a pure
 * function with no server ancestry so P1b can render a report from a client
 * component, and one `pg` import here would end that property for both.
 */

interface WindowRow {
  mode: StripeMode;
  day: string;
  clean: boolean;
}

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

/**
 * The four states 0033 and 0034's CHECK admits.
 *
 * Not a boolean, and not three. A run that could not reach Stripe is not
 * clean, and a mode that has never been bootstrapped has not drifted.
 */
export type ParityOutcome = "clean" | "differences" | "failed" | "not_bootstrapped";

export interface ParityRun {
  /** Which Stripe account this run compared against. Required, never
   *  defaulted: 0034 dropped the column's default precisely so a writer that
   *  forgot could not file a live run under `test`. */
  readonly mode: StripeMode;
  readonly outcome: ParityOutcome;
  /** Empty on `clean`, on `failed`, and on `not_bootstrapped` — the last of
   *  which is the one worth stating, because the comparator DOES produce a
   *  report there (42 `price_missing_in_stripe`) and it is deliberately
   *  discarded. See `lib/billing/parity-run.ts`. */
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
 * route turns that into a 500 and the script into a distinct exit code, so the
 * CronJob's own alerting covers the gap.
 */
export async function recordParityRun(run: ParityRun): Promise<void> {
  await tesserixQuery(
    `INSERT INTO plan_catalog_parity_runs (mode, outcome, difference_count, differences, error)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [run.mode, run.outcome, run.differences.length, JSON.stringify(run.differences), run.error],
  );
}

/** One day of one mode's window. `day` is `YYYY-MM-DD` in UTC. */
export interface ParityWindowDay {
  readonly day: string;
  readonly clean: boolean;
}

/** One mode's answer. `satisfied` means every day in the window is clean. */
export interface ParityWindowMode {
  readonly mode: StripeMode;
  readonly days: readonly ParityWindowDay[];
  readonly satisfied: boolean;
}

/** Both modes' answers, and the conjunction that is #327's gate. */
export interface ParityWindowStatus {
  readonly days: number;
  readonly modes: readonly ParityWindowMode[];
  readonly satisfied: boolean;
}

/** The longest window this will answer for. A guard on the generated series,
 *  not a policy: #327 asks for 7 and nobody has a use for a year. */
const MAX_WINDOW_DAYS = 366;

/**
 * Is the observation window satisfied, per mode?
 *
 * This is the query #327 will cite, and it exists so "is the window
 * satisfied?" has a mechanical answer rather than one assembled by reading
 * rows in `psql`. P2 revokes mark8ly's Stripe write key on the answer.
 *
 * # A missing day is NOT clean
 *
 * The single most important property, and the reason this generates a day
 * series and left-joins it rather than filtering the table. The obvious
 * query — "no non-clean rows in the last 7 days" — is TRUE OF AN EMPTY TABLE.
 * A window satisfied by a check that never ran is the one outcome that must be
 * impossible here, and it is the outcome a CronJob that silently failed to
 * start produces. Absence of evidence, never evidence of agreement.
 *
 * # Days, not runs
 *
 * Seven clean runs in one afternoon is one clean day. Counting rows would
 * report a satisfied week within an hour of deploying the check.
 *
 * # A day needs a clean run AND no other kind
 *
 * The strict reading, and it is a choice the schema does not force. A day
 * holding a 03:00 `failed` and an operator's 09:00 `clean` does not count: the
 * re-run does not erase the run that did not succeed. This gates a credential
 * revocation, so a day anyone could argue about is a day that does not count —
 * and it errs in the recoverable direction, where the cost is waiting another
 * week rather than revoking a key on a week that had a hole in it.
 *
 * # UTC, explicitly
 *
 * Every boundary is computed `AT TIME ZONE 'UTC'` rather than in the session's
 * zone. "Which day was that run on" must not depend on the timezone of
 * whatever connection happens to ask, or the same rows answer differently to
 * the CronJob and to an operator.
 *
 * @param days the window length. #327's number is 7, but it belongs to the
 *   caller — a function that hard-coded it would answer 7 to someone who asked
 *   for 3.
 */
export async function readWindowStatus(days: number): Promise<ParityWindowStatus> {
  // Validated at the boundary rather than interpolated and hoped about: a
  // non-integer reaches `make_interval`, and a large one generates a series
  // nobody asked for.
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new Error(
      `readWindowStatus: the window must be a whole number of days between 1 and ${MAX_WINDOW_DAYS}, got ${days}`,
    );
  }

  const rows = await tesserixQuery<WindowRow>(
    `WITH bounds AS (
         SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AS today
       ),
       window_days AS (
         SELECT generate_series(
                  b.today - make_interval(days => $1::int - 1),
                  b.today,
                  interval '1 day'
                ) AS day
           FROM bounds b
       ),
       modes AS (
         SELECT unnest($2::text[]) AS mode
       )
     SELECT m.mode,
            to_char(d.day, 'YYYY-MM-DD') AS day,
            (
              EXISTS (
                SELECT 1 FROM plan_catalog_parity_runs r
                 WHERE r.mode = m.mode
                   AND date_trunc('day', r.ran_at AT TIME ZONE 'UTC') = d.day
                   AND r.outcome = 'clean'
              )
              AND NOT EXISTS (
                SELECT 1 FROM plan_catalog_parity_runs r
                 WHERE r.mode = m.mode
                   AND date_trunc('day', r.ran_at AT TIME ZONE 'UTC') = d.day
                   AND r.outcome <> 'clean'
              )
            ) AS clean
       FROM modes m
       CROSS JOIN window_days d
      ORDER BY d.day`,
    [days, [...STRIPE_MODES]],
  );

  // Grouped in the order `STRIPE_MODES` declares rather than the order the
  // rows arrive, so a caller rendering this gets test then live every time —
  // and so a mode with NO rows at all is still present. A query returning only
  // the modes found in the table would omit live entirely today, and a caller
  // reducing over "every mode returned" would find the gate satisfied because
  // the failing side was invisible.
  const modes = STRIPE_MODES.map((mode) => {
    const modeDays = rows
      .filter((row) => row.mode === mode)
      .map((row) => ({ day: row.day, clean: row.clean }));
    return {
      mode,
      days: modeDays,
      // `every` on an empty list is `true`, which would be exactly the wrong
      // answer for a mode the query somehow returned no days for. The length
      // check is what keeps "no days" from reading as "all days clean".
      satisfied: modeDays.length === days && modeDays.every((d) => d.clean),
    };
  });

  return { days, modes, satisfied: modes.every((m) => m.satisfied) };
}
