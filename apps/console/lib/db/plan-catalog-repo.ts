// `server-only` for the same reason `lib/db/tesserix.ts` carries it: this
// module reaches `pg`, and a client component that reaches it must fail the
// build with the import chain named rather than `Can't resolve 'net'` from
// somewhere inside the driver.
import "server-only";

import type { Difference, CatalogAmount, TaxBehavior } from "@/lib/billing/parity";
import type { CatalogSource } from "@/lib/billing/source-policy";
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
  /** Whether ANY run — clean or not — was recorded for this day. See
   *  {@link ParityWindowDay.ran}. */
  ran: boolean;
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

function toCatalogAmount(row: AmountRow): CatalogAmount {
  return {
    lookupKey: row.lookup_key,
    currency: row.currency,
    unitAmountMinor: toMinorUnits(row.unit_amount_minor, row.lookup_key, row.currency),
    taxBehavior: row.tax_behavior,
  };
}

/**
 * Every catalog amount currently published to `mode`, joined to the
 * `lookup_key` it belongs to.
 *
 * # The bug this replaces
 *
 * 0035 made the catalog versioned: `plan_catalog_prices` now carries a
 * `revision_id`, and a draft's rows and the published rows coexist in the
 * same table with the same `lookup_key`. Reading every row — what this
 * function did before 0035 — reads BOTH the moment a draft exists: duplicate
 * lookup keys, and the comparator's grouping (`catalogCoverage` in
 * `lib/billing/parity.ts`) silently merges a draft and the published catalog
 * into one report. That is the same class of silent false positive 0032's
 * `tax_behavior` normalisation was written to avoid, reintroduced by
 * omission — so the filter lands with the schema, not after.
 *
 * # Joined through the publication, not a status column
 *
 * A status column on the revision cannot express "test is ahead of live",
 * which is the NORMAL state here (see 0035): live has never been published.
 * Publication is a fact about a `(mode, revision)` pair, so this joins
 * through `plan_catalog_publications` rather than filtering prices by a flag
 * that would have to live on the wrong table.
 *
 * # A mode with no publication returns empty, and never throws
 *
 * `not_bootstrapped` (see `performParityCheck` in `lib/billing/parity-run.ts`)
 * is DERIVED from an empty catalog read plus an empty Stripe read. If this
 * threw instead for a never-published mode, every unpublished mode would
 * report `failed` forever rather than the accurate "nothing here yet".
 *
 * Ordered so a report reads the same way twice; the comparator sorts its own
 * output, but a deterministic read makes a `psql` session diffable too.
 *
 * # Does not filter by `source`
 *
 * This query has no `AND p.source = ...`, and that is safe only because every
 * row in `plan_catalog_prices` today has `source = 'mark8ly'`. It stops being
 * safe the moment a second source exists: two products sharing a lookup-key
 * convention would merge into one report exactly the way a draft and a
 * published revision merged before this function filtered by publication —
 * same bug, different axis. The fix when that day comes is `AND p.source =
 * $2`, threading the source through as a second parameter; it is not added
 * here because a parameter with exactly one legal value today is scope this
 * function does not need yet.
 */
export async function readCatalogAmounts(mode: StripeMode): Promise<CatalogAmount[]> {
  const rows = await tesserixQuery<AmountRow>(
    `SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_publications pub
       JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL
      ORDER BY p.lookup_key, a.currency`,
    [mode],
  );
  return rows.map(toCatalogAmount);
}

interface CatalogRowRaw extends AmountRow {
  plan: string;
  period: string;
  tier: string;
  source: CatalogSource;
}

/** {@link CatalogAmount} plus the descriptor columns the comparator has no use
 *  for but a human reading the catalog needs. */
export interface CatalogRow extends CatalogAmount {
  readonly plan: string;
  readonly period: string;
  readonly tier: string;
  readonly source: CatalogSource;
}

function toCatalogRow(row: CatalogRowRaw): CatalogRow {
  return { ...toCatalogAmount(row), plan: row.plan, period: row.period, tier: row.tier, source: row.source };
}

/**
 * Every catalog row currently published to `mode` — the console's read
 * surface for #326, and a WIDER projection of the same join
 * {@link readCatalogAmounts} runs.
 *
 * # Why this exists beside `readCatalogAmounts` rather than replacing it
 *
 * `readCatalogAmounts` is on the parity-check path (`lib/billing/parity-run.ts`
 * -> `performParityCheck`), and its projection is deliberately narrow: the
 * comparator only ever looks at `lookup_key`, `currency`, `unit_amount_minor`
 * and `tax_behavior`. Widening THAT function's SELECT to add `plan`, `period`,
 * `tier` and `source` would cost the comparator nothing today, but it would
 * mean the query that gates a Stripe write-key revocation (#327) changes shape
 * every time the console UI wants one more display column — coupling a
 * read-only report to a credential decision for no reason. Two functions with
 * the same `WHERE`, reading different columns off the same join, keep those
 * changes independent.
 *
 * Every other property is identical to `readCatalogAmounts` — including that a
 * mode with no publication returns `[]` rather than throwing, and that this
 * does NOT filter by `source` yet (see that function's doc comment for why
 * that is currently safe and what the fix looks like when it stops being so).
 */
export async function readCatalogRows(mode: StripeMode): Promise<CatalogRow[]> {
  const rows = await tesserixQuery<CatalogRowRaw>(
    `SELECT p.lookup_key, p.plan, p.period, p.tier, p.source,
            a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_publications pub
       JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL
      ORDER BY p.lookup_key, a.currency`,
    [mode],
  );
  return rows.map(toCatalogRow);
}

interface PublicationRow {
  id: string;
  revision_id: string;
}

/**
 * The publication currently live for `mode` — `null` if the mode has never
 * been published.
 *
 * Same `WHERE` as {@link readCatalogAmounts}, because the two answer related
 * questions ("what does this mode read as?" and "which publication is
 * that?") and must never be able to disagree about which row is current.
 */
export async function readLivePublication(
  mode: StripeMode,
): Promise<{ id: string; revisionId: string } | null> {
  const rows = await tesserixQuery<PublicationRow>(
    `SELECT pub.id, pub.revision_id
       FROM plan_catalog_publications pub
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL`,
    [mode],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, revisionId: rows[0].revision_id };
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
  /**
   * Which publication (see 0035) the read side of this run was checked
   * against — `null` for a mode with no publication yet, which is exactly
   * `not_bootstrapped`.
   *
   * Set by `performParityCheck` from `readLivePublication(mode)`, read at the
   * same moment as the catalog it names, and written by `recordParityRun`
   * into `plan_catalog_parity_runs.publication_id`. This is the field that
   * makes a `clean` row still mean something after the catalog it was checked
   * against is superseded — without it, republishing invalidates every prior
   * `clean` row silently, and #326's 7-day window loses the ability to say
   * WHICH catalog it observed.
   */
  readonly publicationId: string | null;
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
    `INSERT INTO plan_catalog_parity_runs (mode, outcome, difference_count, differences, error, publication_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      run.mode,
      run.outcome,
      run.differences.length,
      JSON.stringify(run.differences),
      run.error,
      // Nullable, and expected to be null for `not_bootstrapped`: 0035 puts
      // no CHECK across this column, because "never published" is the
      // ordinary state a run can be evidence of, not a defect in the row.
      run.publicationId,
    ],
  );
}

/** One day of one mode's window. `day` is `YYYY-MM-DD` in UTC. */
export interface ParityWindowDay {
  readonly day: string;
  readonly clean: boolean;
  /**
   * Was any run — clean, dirty, failed, or not_bootstrapped — recorded for
   * this day at all?
   *
   * Added after the console surface shipped without it (P3's review, against
   * prod data): `clean: false` alone cannot tell a day the check ran and
   * found a problem apart from a day the check never ran, and the console
   * rendered both in the same "not clean" red — the exact overstatement this
   * function's own "absence of evidence, never evidence of agreement" comment
   * exists to prevent, reintroduced one layer up. `ran` is what lets a caller
   * draw that line for every day, not just the ones after the mode's most
   * recent run.
   *
   * As far as this module's author could confirm, `page.tsx` in
   * `platform/billing/catalog` is this function's only consumer, which is
   * what made widening the type here — rather than adding a third query —
   * the cheap fix.
   */
  readonly ran: boolean;
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
            ) AS clean,
            -- Any row at all for the day, regardless of outcome -- the fact
            -- clean alone cannot carry. Same correlated-EXISTS shape as
            -- clean above, deliberately: the day series and the join are
            -- already built for it, so this is one more boolean column, not
            -- a second query.
            EXISTS (
              SELECT 1 FROM plan_catalog_parity_runs r
               WHERE r.mode = m.mode
                 AND date_trunc('day', r.ran_at AT TIME ZONE 'UTC') = d.day
            ) AS ran
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
      .map((row) => ({ day: row.day, clean: row.clean, ran: row.ran }));
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

interface LatestRunRow {
  mode: StripeMode;
  outcome: ParityOutcome;
  /** `pg`/pglite hand a `timestamptz` back as a `Date`, not a string — see
   *  {@link readLatestRuns}. */
  ran_at: string | Date;
  difference_count: number;
  differences: unknown;
}

/** One mode's most recent run, or `null` when the mode has never run. */
export interface LatestParityRun {
  readonly outcome: ParityOutcome;
  /** ISO 8601, UTC. */
  readonly ranAt: string;
  readonly differenceCount: number;
  readonly differences: readonly Difference[];
}

/** One mode's answer — always present, per {@link readLatestRuns}. */
export interface ModeLatestRun {
  readonly mode: StripeMode;
  readonly run: LatestParityRun | null;
}

function toLatestParityRun(row: LatestRunRow): LatestParityRun {
  return {
    outcome: row.outcome,
    // `new Date(x).toISOString()` accepts both a driver-parsed `Date` and a
    // plain string, so this does not care which one the connection in use
    // hands back.
    ranAt: new Date(row.ran_at).toISOString(),
    differenceCount: row.difference_count,
    // `differences` is jsonb; both `pg` and pglite parse it into real
    // objects already, never a string that would need a second `JSON.parse`.
    differences: row.differences as Difference[],
  };
}

/**
 * The most recent `plan_catalog_parity_runs` row for each mode.
 *
 * `readWindowStatus` answers "was the week clean?" as a single boolean per
 * mode; it does not carry a single difference. Without this function, a red
 * day is a dot on the strip nobody can interrogate — an operator deciding
 * whether #327's revocation is safe has to open `psql` to see what actually
 * differed. This is that read, and it exists purely for a human, unlike
 * `readCatalogAmounts`/`readCatalogRows` which exist for a comparator and a
 * table respectively.
 *
 * `DISTINCT ON (mode)` ordered by `ran_at DESC` per mode is Postgres's
 * (and pglite's) native "top 1 per group" — cheaper and more direct here than
 * a window function, since the whole result set is at most two rows.
 *
 * Same "both modes, always" discipline as {@link readWindowStatus}: a mode
 * with zero rows is reported with `run: null` rather than omitted, so a
 * caller iterating the result cannot mistake "never ran" for "not asked
 * about". This is also the function that answers #326's "no runs recorded
 * yet" state — `run === null` for a mode IS that state, not an error.
 */
export async function readLatestRuns(): Promise<ModeLatestRun[]> {
  const rows = await tesserixQuery<LatestRunRow>(
    `SELECT DISTINCT ON (mode) mode, outcome, ran_at, difference_count, differences
       FROM plan_catalog_parity_runs
      ORDER BY mode, ran_at DESC`,
  );

  return STRIPE_MODES.map((mode) => {
    const row = rows.find((r) => r.mode === mode);
    return { mode, run: row ? toLatestParityRun(row) : null };
  });
}
