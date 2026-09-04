// `server-only` for the same reason `lib/db/tesserix.ts` carries it: this
// module reaches `pg`, and a client component that reaches it must fail the
// build with the import chain named rather than `Can't resolve 'net'` from
// somewhere inside the driver.
import "server-only";

import type { Difference, CatalogAmount, TaxBehavior } from "@/lib/billing/parity";
// A VALUE import, not type-only: `CATALOG_SOURCES` is what makes
// `readWindowStatus` and `readLatestRuns` report every (mode, source) pair
// rather than only the pairs they happened to find rows for — the same job
// `STRIPE_MODES` does one axis over. `source-policy.ts` is a plain constants
// module with no `server-only` and no `pg` ancestry, so importing it as a
// value costs this module nothing.
import { CATALOG_SOURCES, type CatalogSource } from "@/lib/billing/source-policy";
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
  source: CatalogSource;
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
 * # `source` is required, not defaulted
 *
 * Filtered by `AND p.source = $2`, and `source` has no default — the same
 * reasoning `stripe-read.ts` gives for `StripePriceReader.listPrices`'s
 * `mode` parameter, one axis over: a default would make `readCatalogAmounts(
 * mode)` compile at a call site that had simply forgotten which source it
 * meant, and the resulting row would name a mode it did not check against
 * the right catalog. Before this filter existed, every row in
 * `plan_catalog_prices` happened to have `source = 'mark8ly'`, so an
 * unfiltered read was accidentally correct — but `UNIQUE (revision_id,
 * source, lookup_key)` means `lookup_key` is NOT unique within a revision
 * once a second source exists, and two products sharing a naming convention
 * would merge into one report exactly the way a draft and a published
 * revision merged before this function filtered by publication. Same bug,
 * different axis.
 */
export async function readCatalogAmounts(
  mode: StripeMode,
  source: CatalogSource,
): Promise<CatalogAmount[]> {
  const rows = await tesserixQuery<AmountRow>(
    `SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_publications pub
       JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL AND p.source = $2
      ORDER BY p.lookup_key, a.currency`,
    [mode, source],
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
 * mode with no publication returns `[]` rather than throwing, and that
 * `source` is a required parameter with no default, for the identical reason
 * (see that function's doc comment).
 */
export async function readCatalogRows(
  mode: StripeMode,
  source: CatalogSource,
): Promise<CatalogRow[]> {
  const rows = await tesserixQuery<CatalogRowRaw>(
    `SELECT p.lookup_key, p.plan, p.period, p.tier, p.source,
            a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_publications pub
       JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL AND p.source = $2
      ORDER BY p.lookup_key, a.currency`,
    [mode, source],
  );
  return rows.map(toCatalogRow);
}

interface PublicationRow {
  id: string;
  revision_id: string;
  published_by: string;
  /** `pg`/pglite hand a `timestamptz` back as a `Date`, not a string — see
   *  {@link readLatestRuns}'s identical comment on `ran_at`. */
  published_at: string | Date;
}

/** What {@link readLivePublication} resolves to for a published mode. Named
 *  for the console surface that consumes it, not for the table —
 *  `catalog-views.tsx` imports this as a type only (see that file's own
 *  comment on why every import from this module there is `import type`). */
export interface LivePublication {
  readonly id: string;
  readonly revisionId: string;
  readonly publishedBy: string;
  /** ISO 8601, UTC. */
  readonly publishedAt: string;
}

/**
 * The publication currently live for `mode`, and who published it and when —
 * `null` if the mode has never been published. 0035's
 * `plan_catalog_publications` has carried `published_by`/`published_at`
 * since the baseline row `0035` itself inserted (`migration:0035` for
 * `test`, `migration:0037` for `live`); the console's catalog surface
 * (task 2R) is the first reader of either column.
 *
 * ONE query, ONE row, not a second read alongside this one for the extra
 * columns: `id`/`revisionId` and `publishedBy`/`publishedAt` describe the
 * SAME row, so a second function sharing this one's `WHERE` could disagree
 * with it only by drifting out of sync with a comment — an invariant a
 * second query cannot actually enforce. Widening this function's return is
 * what keeps that impossible instead of merely documented.
 *
 * Same `WHERE` as {@link readCatalogAmounts}, because the two answer related
 * but DIFFERENT questions ("what does this mode read as?" and "which
 * publication is that?") and must never be able to disagree about which row
 * is current.
 */
export async function readLivePublication(mode: StripeMode): Promise<LivePublication | null> {
  const rows = await tesserixQuery<PublicationRow>(
    `SELECT pub.id, pub.revision_id, pub.published_by, pub.published_at
       FROM plan_catalog_publications pub
      WHERE pub.mode = $1 AND pub.superseded_at IS NULL`,
    [mode],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    revisionId: rows[0].revision_id,
    publishedBy: rows[0].published_by,
    // Same normalisation as `toLatestParityRun`'s `ranAt`: accepts either a
    // driver-parsed `Date` or a plain string.
    publishedAt: new Date(rows[0].published_at).toISOString(),
  };
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
  /** Which catalog this run compared. Required, never defaulted, for the
   *  reason 0044/0045 give: with a default in place a writer that forgot
   *  would file a second product's run as a mark8ly run, and "every (mode,
   *  source) pair clean" would be satisfiable by one source answering twice —
   *  the exact failure the column exists to prevent. 0045 drops the database
   *  default once the source-aware image is live; this field is what makes
   *  that drop safe. See tesserix-home#392. */
  readonly source: CatalogSource;
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
    `INSERT INTO plan_catalog_parity_runs (mode, source, outcome, difference_count, differences, error, publication_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      run.mode,
      // Stated, never left to the column default — 0045 removes that default
      // once this image is live, and a writer that relied on it would file
      // every source's run as mark8ly's. See {@link ParityRun.source}.
      run.source,
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

/** One day of one (mode, source) pair's window. `day` is `YYYY-MM-DD` in UTC. */
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
   * draw that line for every day, not just the ones after the (mode, source)
   * pair's most recent run.
   *
   * As far as this module's author could confirm, `page.tsx` in
   * `platform/billing/catalog` is this function's only consumer, which is
   * what made widening the type here — rather than adding a third query —
   * the cheap fix.
   */
  readonly ran: boolean;
}

/**
 * One (mode, source) pair's answer. `satisfied` means every day in the window
 * is clean for THAT pair.
 *
 * Named for a pair rather than a mode since tesserix-home#392, and the shape
 * is FLAT — one entry per pair — rather than sources nested inside modes. The
 * check is run once per pair and #327's gate is stated once per pair, so a
 * mode-level container would imply a mode-level verdict that no longer exists:
 * "test is satisfied" is not a fact this table can produce once two catalogs
 * are checked under the same account.
 */
export interface ParityWindowPair {
  readonly mode: StripeMode;
  readonly source: CatalogSource;
  readonly days: readonly ParityWindowDay[];
  readonly satisfied: boolean;
}

/** Every (mode, source) pair's answer, and the conjunction that is #327's
 *  gate: every pair clean for every day of the window. */
export interface ParityWindowStatus {
  readonly days: number;
  readonly pairs: readonly ParityWindowPair[];
  readonly satisfied: boolean;
}

/** The longest window this will answer for. A guard on the generated series,
 *  not a policy: #327 asks for 7 and nobody has a use for a year. */
const MAX_WINDOW_DAYS = 366;

/**
 * Is the observation window satisfied, per (mode, source) pair?
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
 * # Per PAIR, not per mode
 *
 * The check is asked once per (mode, source) pair, because a run recorded
 * against one catalog says nothing about another — see 0044 and
 * tesserix-home#392. Asking per mode was accidentally sufficient while
 * `mark8ly` was the only source, and became a SILENT omission the moment a
 * second source's rows landed: that source's drift would never be compared
 * against anything, while the mark8ly rows still came back `clean` and the
 * window still read as satisfied.
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
       ),
       -- The second axis, and a CROSS JOIN rather than a third correlated
       -- EXISTS: the question is asked once per (mode, source, day) cell, so
       -- the sources belong in the same cross product the modes and days are
       -- already in. Passed in from CATALOG_SOURCES rather than read off a
       -- SELECT DISTINCT source over this table, for the same reason the modes
       -- are: a source with no rows at all must still produce cells, and
       -- deriving the list from the table would make a source that has never
       -- been checked invisible instead of unsatisfied -- which is exactly the
       -- tesserix-home#392 omission, reintroduced inside the fix for it.
       sources AS (
         SELECT unnest($3::text[]) AS source
       )
     SELECT m.mode,
            s.source,
            to_char(d.day, 'YYYY-MM-DD') AS day,
            (
              EXISTS (
                SELECT 1 FROM plan_catalog_parity_runs r
                 WHERE r.mode = m.mode
                   AND r.source = s.source
                   AND date_trunc('day', r.ran_at AT TIME ZONE 'UTC') = d.day
                   AND r.outcome = 'clean'
              )
              AND NOT EXISTS (
                SELECT 1 FROM plan_catalog_parity_runs r
                 WHERE r.mode = m.mode
                   AND r.source = s.source
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
                 AND r.source = s.source
                 AND date_trunc('day', r.ran_at AT TIME ZONE 'UTC') = d.day
            ) AS ran
       FROM modes m
       CROSS JOIN sources s
       CROSS JOIN window_days d
      ORDER BY d.day`,
    [days, [...STRIPE_MODES], [...CATALOG_SOURCES]],
  );

  // Grouped by iterating `STRIPE_MODES` x `CATALOG_SOURCES` rather than the
  // order the rows arrive, so a caller rendering this gets the same pairs in
  // the same order every time — and so a pair with NO rows at all is still
  // present. A query returning only the pairs found in the table would omit
  // live entirely today, and a caller reducing over "every pair returned"
  // would find the gate satisfied because the failing side was invisible.
  // That property is now load-bearing on BOTH axes: tesserix-home#392 is
  // precisely the case where an unchecked source is invisible rather than
  // unsatisfied.
  const pairs = STRIPE_MODES.flatMap((mode) =>
    CATALOG_SOURCES.map((source) => {
      const pairDays = rows
        .filter((row) => row.mode === mode && row.source === source)
        .map((row) => ({ day: row.day, clean: row.clean, ran: row.ran }));
      return {
        mode,
        source,
        days: pairDays,
        // `every` on an empty list is `true`, which would be exactly the wrong
        // answer for a pair the query somehow returned no days for. The length
        // check is what keeps "no days" from reading as "all days clean".
        satisfied: pairDays.length === days && pairDays.every((d) => d.clean),
      };
    }),
  );

  return { days, pairs, satisfied: pairs.every((p) => p.satisfied) };
}

interface LatestRunRow {
  mode: StripeMode;
  source: CatalogSource;
  outcome: ParityOutcome;
  /** `pg`/pglite hand a `timestamptz` back as a `Date`, not a string — see
   *  {@link readLatestRuns}. */
  ran_at: string | Date;
  difference_count: number;
  differences: unknown;
}

/** One (mode, source) pair's most recent run, or `null` when the pair has
 *  never run. */
export interface LatestParityRun {
  readonly outcome: ParityOutcome;
  /** ISO 8601, UTC. */
  readonly ranAt: string;
  readonly differenceCount: number;
  readonly differences: readonly Difference[];
}

/** One (mode, source) pair's answer — always present, per
 *  {@link readLatestRuns}. Named for a pair rather than a mode since
 *  tesserix-home#392, alongside {@link ParityWindowPair}: both reads are now
 *  keyed the way the check is actually run. */
export interface PairLatestRun {
  readonly mode: StripeMode;
  readonly source: CatalogSource;
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
 * The most recent `plan_catalog_parity_runs` row for each (mode, source) pair.
 *
 * `readWindowStatus` answers "was the week clean?" as a single boolean per
 * pair; it does not carry a single difference. Without this function, a red
 * day is a dot on the strip nobody can interrogate — an operator deciding
 * whether #327's revocation is safe has to open `psql` to see what actually
 * differed. This is that read, and it exists purely for a human, unlike
 * `readCatalogAmounts`/`readCatalogRows` which exist for a comparator and a
 * table respectively.
 *
 * `DISTINCT ON (mode, source)` ordered by `ran_at DESC` within the group is
 * Postgres's (and pglite's) native "top 1 per group" — cheaper and more direct
 * here than a window function, since the whole result set is at most one row
 * per (mode, source) pair.
 *
 * PER PAIR, not per mode, since tesserix-home#392. "What did the last run of
 * each mode say" stopped being an answerable question once one mode's account
 * can hold two catalogs: the latest row for `test` would be whichever source
 * happened to run last, and an operator reading it would take one catalog's
 * verdict for both. This is the read that backs each pair's card on the
 * console's observation-window surface, so it has to be keyed the way the
 * cards are.
 *
 * Same "every pair, always" discipline as {@link readWindowStatus}: a pair
 * with zero rows is reported with `run: null` rather than omitted, so a
 * caller iterating the result cannot mistake "never ran" for "not asked
 * about". This is also the function that answers #326's "no runs recorded
 * yet" state — `run === null` for a pair IS that state, not an error.
 */
export async function readLatestRuns(): Promise<PairLatestRun[]> {
  const rows = await tesserixQuery<LatestRunRow>(
    `SELECT DISTINCT ON (mode, source) mode, source, outcome, ran_at, difference_count, differences
       FROM plan_catalog_parity_runs
      ORDER BY mode, source, ran_at DESC`,
  );

  return STRIPE_MODES.flatMap((mode) =>
    CATALOG_SOURCES.map((source) => {
      const row = rows.find((r) => r.mode === mode && r.source === source);
      return { mode, source, run: row ? toLatestParityRun(row) : null };
    }),
  );
}

// ---------------------------------------------------------------------------
// Revision amounts, read directly (Task 6 — `publish-executor.ts`)
// ---------------------------------------------------------------------------

/**
 * Every catalog amount belonging to ONE revision — including a draft that has
 * never been published — read by `revision_id` directly rather than through
 * `plan_catalog_publications`.
 *
 * # Why this is not `readCatalogAmounts` with an extra parameter
 *
 * `readCatalogAmounts` answers "what does `mode` read as RIGHT NOW", joined
 * through the publication so a draft's rows (same `lookup_key`s, a different
 * `revision_id`, per 0035) can never leak into that answer — see that
 * function's doc comment. The publish executor needs the opposite join: the
 * DRAFT'S OWN rows, by the specific `revision_id` a `plan_catalog_publish_attempts`
 * row names, whether or not that revision has ever been (or will ever be)
 * published. Threading an "also allow a draft" flag through the existing
 * function would let its one `WHERE` answer two different questions depending
 * on a caller's flag — exactly the ambiguity 0035 introduced this table's
 * `revision_id` column to remove. A second, narrower function keeps each
 * `WHERE` honest about which question it answers.
 *
 * Same `source` discipline as `readCatalogAmounts`: required, no default, for
 * the identical reason (`UNIQUE (revision_id, source, lookup_key)` stops
 * being enough to keep `lookup_key` unique within a revision the moment a
 * second source exists).
 *
 * A revision with no rows (a draft nobody has edited into yet) returns `[]`,
 * not an error — the caller (`buildPublishPlan`) already treats an empty
 * `draft` as a legitimate input (see that module's `PublishPlanInput`).
 */
export async function readRevisionAmounts(
  revisionId: string,
  source: CatalogSource,
): Promise<CatalogAmount[]> {
  const rows = await tesserixQuery<AmountRow>(
    `SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_prices  p
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE p.revision_id = $1 AND p.source = $2
      ORDER BY p.lookup_key, a.currency`,
    [revisionId, source],
  );
  return rows.map(toCatalogAmount);
}

/**
 * `readRevisionRows` is to `readRevisionAmounts` what `readCatalogRows`
 * (above) is to `readCatalogAmounts`: the same `revision_id`-scoped `WHERE`
 * as {@link readRevisionAmounts}, widened with `plan`/`period`/`tier`/
 * `source` — the descriptor columns a human editing the draft needs and the
 * publish plan builder (the narrow function's one caller) has no use for.
 * Added for task 9 (`tesserix-home#396`): `draft-editor.tsx`'s
 * `DraftEditorRow` needs plan/period/tier grouping for a DRAFT revision the
 * same way `catalog-views.tsx`'s `organizeCatalogByPlan` needs it for a
 * PUBLISHED one, and the published-only `readCatalogRows` cannot answer that
 * — a draft's `revision_id` is never the one `plan_catalog_publications`
 * currently names, by definition, until it is published.
 *
 * Same "empty is not an error" and "source is required, no default"
 * discipline as {@link readRevisionAmounts} — see that function's doc
 * comment for why both hold here unchanged.
 */
export async function readRevisionRows(
  revisionId: string,
  source: CatalogSource,
): Promise<CatalogRow[]> {
  const rows = await tesserixQuery<CatalogRowRaw>(
    `SELECT p.lookup_key, p.plan, p.period, p.tier, p.source,
            a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_prices  p
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE p.revision_id = $1 AND p.source = $2
      ORDER BY p.lookup_key, a.currency`,
    [revisionId, source],
  );
  return rows.map(toCatalogRow);
}

// ---------------------------------------------------------------------------
// Test-vs-live content divergence (tesserix-home#527)
// ---------------------------------------------------------------------------

/**
 * One served catalog row, tagged with the mode that serves it. The tuple is
 * exactly what {@link readModeDivergence} compares — see that function for why
 * `plan`, `period` and `tier` are in it.
 */
export interface ModeCatalogRow {
  readonly mode: StripeMode;
  readonly lookupKey: string;
  readonly plan: string;
  readonly period: string;
  readonly tier: string;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly taxBehavior: TaxBehavior;
}

/** How many rows each mode currently serves for the compared source. */
export interface ModeRowCounts {
  readonly test: number;
  readonly live: number;
}

/**
 * THREE outcomes, not two, and the third is the whole point.
 *
 * `not_published` is a mode with no current row in
 * `plan_catalog_publications` — a state `live` was in for long stretches of
 * this project's life, and one that is emphatically NOT "the modes agree".
 * Collapsing it into `identical` (zero differences, because there was nothing
 * to differ) is the same defect mark8ly's `Result.Compared`/`Result.Differences`
 * split exists to prevent: "reporting zero differences when the console could
 * not be reached would make an outage indistinguishable from a clean run."
 * Here the unread side is a mode rather than a service, and the consequence is
 * identical — a surface claiming agreement on evidence it never had.
 */
export type ModeDivergence =
  | {
      readonly outcome: "not_published";
      /** The modes with no current publication. Never empty in this variant. */
      readonly unpublishedModes: readonly StripeMode[];
    }
  | { readonly outcome: "identical"; readonly rows: ModeRowCounts }
  | {
      readonly outcome: "diverged";
      readonly rows: ModeRowCounts;
      /** The symmetric difference: every served tuple present in one mode and
       *  not the other, tagged with the mode that has it. */
      readonly differences: readonly ModeCatalogRow[];
    };

interface ModeDivergenceRowRaw {
  mode: StripeMode;
  lookup_key: string;
  plan: string;
  period: string;
  tier: string;
  currency: string;
  /** `::text` in the query, so a `bigint` never becomes a JSON number that
   *  `JSON.parse` could round. Same reason {@link AmountRow} takes a string. */
  unit_amount_minor: string;
  tax_behavior: TaxBehavior;
}

interface DivergenceSummaryRow {
  /** `count(*)` is `bigint`, so both drivers hand it back as a string. */
  test_rows: string;
  live_rows: string;
  /** `jsonb`, already parsed by `pg` and pglite — never a string needing a
   *  second `JSON.parse`. Same note as {@link LatestRunRow.differences}. */
  differences: unknown;
}

function toModeCatalogRow(row: ModeDivergenceRowRaw): ModeCatalogRow {
  return {
    mode: row.mode,
    lookupKey: row.lookup_key,
    plan: row.plan,
    period: row.period,
    tier: row.tier,
    currency: row.currency,
    unitAmountMinor: toMinorUnits(row.unit_amount_minor, row.lookup_key, row.currency),
    taxBehavior: row.tax_behavior,
  };
}

/**
 * Do `test` and `live` currently SERVE the same catalog?
 *
 * # Why this read exists
 *
 * tesserix-home#328 skipped a week-long live-mode observation window on one
 * argument: mark8ly's parity comparison is console-catalog against compiled
 * Go catalog, neither side is mode-dependent, and the console serves the same
 * catalog either way — so test-mode evidence stands in for live. That argument
 * is CONDITIONAL on the two modes agreeing, and nothing checked it. mark8ly
 * cannot: it reads one mode (`CONSOLE_CATALOG_MODE`) and is structurally
 * incapable of comparing them. The console holds both publications in one
 * table, so this is where the check belongs.
 *
 * # CONTENT, never `revision_id`
 *
 * The tempting one-line version — "do both modes name the same revision?" —
 * was already wrong when this was written. Measured against production on
 * 2026-09-04: `live` named `fb9c1667-…`, `test` named the `00000000-…-0001`
 * baseline, and the two served IDENTICAL content (78 rows each, symmetric
 * difference 0). #327 P2b's first live publish moved live's publication
 * history without changing a served byte. A revision-keyed check would have
 * fired a false positive on day one, and a check that cries wolf on day one
 * is one people learn to ignore — which costs the report the only thing it
 * has, per 0034's `not_bootstrapped` reasoning.
 *
 * # What is in the compared tuple
 *
 * `(lookup_key, plan, period, tier, currency, unit_amount_minor,
 * tax_behavior)`. The four beyond `readCatalogAmounts`'s narrow projection are
 * there deliberately: tesserix/mark8ly#631 added `plan`, `period` and `tier`
 * to the Go-side `Diff` because they are the fields the serving lookup keys
 * on, and comparing amounts alone would leave them unwatched. The join is the
 * one `readCatalogAmounts` and `readCatalogRows` already use, so "what does
 * this mode read as" cannot mean one thing here and another there.
 *
 * # A mode with no publication short-circuits, and never reaches the diff
 *
 * The publication read runs FIRST and returns before the difference query is
 * issued. Not an optimisation — it is what makes the distinction structural
 * rather than a matter of reading the result carefully: there is no path on
 * which an unpublished mode produces a difference count at all, so nothing
 * downstream can mistake its zero for agreement. `readCatalogAmounts` is right
 * to return `[]` for such a mode (it answers "what does this mode read as?",
 * and the answer is genuinely nothing); this function answers "do the two
 * agree?", which has no answer at all when one side was never published.
 *
 * Both modes published but neither serving a row for `source` reports
 * `identical` with `rows` of `{ test: 0, live: 0 }`. That is honest — the
 * publications exist and hold nothing for this source — and the counts are
 * carried so a caller can say so rather than imply a catalog was compared.
 *
 * # `source` is required, no default
 *
 * Same discipline, and the same reason, as every other read in this module:
 * `UNIQUE (revision_id, source, lookup_key)` stops keeping `lookup_key`
 * unique within a revision the moment a second source exists, so an
 * unfiltered diff would compare two products' rows as if they were one.
 */
export async function readModeDivergence(source: CatalogSource): Promise<ModeDivergence> {
  const publishedRows = await tesserixQuery<{ mode: StripeMode }>(
    `SELECT mode FROM plan_catalog_publications WHERE superseded_at IS NULL`,
  );
  const published = new Set(publishedRows.map((row) => row.mode));
  const unpublishedModes = STRIPE_MODES.filter((mode) => !published.has(mode));
  if (unpublishedModes.length > 0) {
    return { outcome: "not_published", unpublishedModes };
  }

  const [summary] = await tesserixQuery<DivergenceSummaryRow>(
    // One statement, and one row out of it whatever the data says: the counts
    // are scalar subqueries and the differences are aggregated, so an empty
    // symmetric difference still returns a row carrying both totals. A query
    // returning only the differing rows would make "agreed" and "the query
    // returned nothing" the same result set.
    `WITH served AS (
         SELECT pub.mode, p.lookup_key, p.plan, p.period, p.tier,
                a.currency,
                -- ::text so the value survives jsonb as a string. to_jsonb of
                -- a bigint yields a JSON number, and JSON.parse rounds one
                -- past 2^53; toMinorUnits' guard only sees a string.
                a.unit_amount_minor::text AS unit_amount_minor,
                a.tax_behavior
           FROM plan_catalog_publications pub
           JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
           JOIN plan_catalog_amounts a ON a.price_id = p.id
          WHERE pub.superseded_at IS NULL AND p.source = $1
       ),
       test_served AS (
         SELECT lookup_key, plan, period, tier, currency, unit_amount_minor, tax_behavior
           FROM served WHERE mode = $2
       ),
       live_served AS (
         SELECT lookup_key, plan, period, tier, currency, unit_amount_minor, tax_behavior
           FROM served WHERE mode = $3
       ),
       -- EXCEPT ALL in both directions, not one: a row test serves and live
       -- does not, and a row live serves and test does not, are both
       -- divergence, and a one-directional EXCEPT would report a mode that is
       -- a strict subset of the other as agreeing.
       diff AS (
         SELECT $2::text AS mode, t.*
           FROM (SELECT * FROM test_served EXCEPT ALL SELECT * FROM live_served) t
         UNION ALL
         SELECT $3::text AS mode, l.*
           FROM (SELECT * FROM live_served EXCEPT ALL SELECT * FROM test_served) l
       )
     SELECT (SELECT count(*) FROM test_served) AS test_rows,
            (SELECT count(*) FROM live_served) AS live_rows,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(diff) ORDER BY diff.lookup_key, diff.currency, diff.mode)
                 FROM diff),
              '[]'::jsonb
            ) AS differences`,
    [source, "test" satisfies StripeMode, "live" satisfies StripeMode],
  );

  const rows: ModeRowCounts = {
    test: Number(summary.test_rows),
    live: Number(summary.live_rows),
  };
  const differences = (summary.differences as ModeDivergenceRowRaw[]).map(toModeCatalogRow);
  return differences.length === 0
    ? { outcome: "identical", rows }
    : { outcome: "diverged", rows, differences };
}
