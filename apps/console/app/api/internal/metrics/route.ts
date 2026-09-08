import { NextResponse } from "next/server";

import { OBSERVATION_WINDOW_DAYS } from "@/lib/billing/observation-window";
import { CATALOG_SOURCES, type CatalogSource } from "@/lib/billing/source-policy";
import type { StripeMode } from "@/lib/billing/stripe-read";
import {
  readLastCleanEntitlementRun,
  readLastCleanRuns,
  readLatestEntitlementRun,
  readLatestRuns,
  readWindowStatus,
  type LatestEntitlementRun,
  type LatestParityRun,
} from "@/lib/db/plan-catalog-repo";
import { isDatabaseConfigured } from "@/lib/db/tesserix";

/**
 * The catalog↔Stripe parity check, as Prometheus reads it — the console's
 * FIRST metrics endpoint (tesserix-home#579).
 *
 * # Why it exists
 *
 * The nightly check writes a `plan_catalog_parity_runs` row and the console
 * renders a badge on `/platform/billing/catalog`. Nothing alerted on either,
 * so a difference was seen only by a human who happened to open that page —
 * and this is the check gating #327's observation window and the revocation
 * of mark8ly's Stripe write key. The CronJob that produces the rows cannot be
 * scraped (it exits), so the DATABASE is the shared source of truth and this
 * route is the reader.
 *
 * Beware the name collision it is deliberately worded around: a DIFFERENT
 * check, also called "catalog parity", is already alerted on
 * (`mark8ly_catalog_parity_*`, rules in tesserix-k8s's
 * `k8s/cluster/prometheus/rules/catalog_parity.yaml`). That one compares
 * mark8ly's compiled fallback against what the console serves and never
 * touches Stripe. `tesserix_console_stripe_parity_*` says which two things
 * these series compare, so an operator seeing those alerts working cannot
 * conclude Stripe parity is covered.
 *
 * # No session, and no capability check
 *
 * Unlike `../parity-check/route.ts` next door, which is OPERATOR-triggered
 * and asserts `billing` for itself. Prometheus holds no console session and
 * cannot mint one. What protects this route instead:
 *
 * - the console's NetworkPolicy (`charts/apps/console/templates/
 *   network-policy.yaml` in tesserix-k8s) admits ingress from the
 *   `monitoring` and `istio-system` namespaces only;
 * - the output is counts, timestamps and a 0/1 — see the rule below.
 * - `middleware.ts` has to allowlist the path for any of this to run at all;
 *   `SCRAPE_PATHS` there is the other half of this design.
 *
 * # THE RULE: numbers only, never free text
 *
 * `plan_catalog_parity_runs.error` is redacted and truncated by
 * `lib/billing/parity-run.ts` for ONE operator reading ONE row on ONE page.
 * This output is a different kind of surface: retained for months, indexed,
 * and readable by anyone who can see the monitoring stack. So no error, no
 * lookup key, no upstream message reaches it — not as a label, not as a
 * value, not as a comment. The reason a run failed stays on the surface
 * #591 put it on. Label values come only from the closed vocabularies
 * `STRIPE_MODES` and `CATALOG_SOURCES`, and `route.test.ts` proves a stored
 * error containing a key-shaped string cannot appear in the body.
 */

// A metrics endpoint answers "what is true right now". A cached one reports
// the past — and would do it while `up` stayed 1, which is the one failure
// mode alerting cannot see.
export const dynamic = "force-dynamic";

/** The exposition format's own content type. `version=0.0.4` is the text
 *  format version Prometheus negotiates; without it a scrape falls back to
 *  guessing. */
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const DIFFERENCES = "tesserix_console_stripe_parity_differences";
const LAST_CLEAN = "tesserix_console_stripe_parity_last_clean_timestamp_seconds";
const WINDOW = "tesserix_console_stripe_parity_window_satisfied";

/**
 * The entitlement pair — tesserix-home#618.
 *
 * # `entitlement`, and emphatically not `stripe`
 *
 * The prefix on these names says WHICH TWO THINGS a series compares; that is
 * the whole reason the header above is worded around the pre-existing
 * `mark8ly_catalog_parity_*` collision. This check compares the console's
 * published plan-feature matrix against what the product's `plangate`
 * actually enforces, and never opens a Stripe client. Borrowing `stripe`
 * would put a third meaning on a name that already carries two.
 *
 * # Why they exist only now
 *
 * #618 recorded the gauge as deliberately absent, not forgotten: entitlement
 * parity could only run when an operator pressed a button, and "adding one
 * would be dishonest while nothing runs on a schedule" — a staleness gauge
 * measures silence, and silence means nothing without an expectation of noise.
 * #626 gave the check the nightly CronJob, using the machine credential #622
 * built. These are the series that expectation now earns.
 */
const ENTITLEMENT_DIFFERENCES = "tesserix_console_entitlement_parity_differences";
const ENTITLEMENT_LAST_CLEAN = "tesserix_console_entitlement_parity_last_clean_timestamp_seconds";

/**
 * HELP text is read at 3am, in an alert annotation, by someone who has never
 * seen this file. Each line therefore says what the number IS, what a bad
 * value means, and what the reader should do about it — not what the code
 * does.
 */
const HELP: Record<string, string> = {
  [DIFFERENCES]:
    "Price rows that differ between the console plan catalog and live Stripe Prices, " +
    "as of the last parity run for this (mode, source) pair. Expected 0. " +
    "NaN means the last run produced no comparison at all (it failed, the mode has " +
    "never been bootstrapped, or the pair has never run) - not that it agreed. " +
    "The offending rows are on the console at /platform/billing/catalog; they are " +
    "deliberately not exported here.",
  [LAST_CLEAN]:
    "Unix time of the last parity run that found NO differences for this (mode, source) " +
    "pair. 0 means no clean run has EVER been recorded for it. Alert on time() minus this " +
    "value: the differences gauge describes the last run, so it reads fine forever once " +
    "the nightly CronJob stops, and this is the half that makes its silence believable.",
  [ENTITLEMENT_DIFFERENCES]:
    "Plan/feature entitlements that differ between the console's published catalog and what " +
    "the product's plangate enforces, as of the last entitlement parity run for this source. " +
    "Expected 0. NaN means the last run produced no comparison at all (it failed, the mode it " +
    "reads has never been published, or the source has never run) - not that it agreed. " +
    "The offending plan/feature pairs are on the console at /platform/billing/catalog; they " +
    "are deliberately not exported here. This compares the console against the PRODUCT, and " +
    "never against Stripe - see tesserix_console_stripe_parity_differences for that.",
  [ENTITLEMENT_LAST_CLEAN]:
    "Unix time of the last entitlement parity run that found NO differences for this source. " +
    "0 means no clean run has EVER been recorded for it. Alert on time() minus this value: " +
    "the differences gauge describes the last run, so it reads fine forever once the nightly " +
    "CronJob stops or the console's machine credential expires, and this is the half that " +
    "makes its silence believable. There is deliberately no mode label - the mode a run is " +
    "filed under is the one the PRODUCT reported reading, and it moves at mark8ly's live-key " +
    "swap.",
  [WINDOW]:
    "1 when every (mode, source) pair has been clean on every day of the " +
    `${OBSERVATION_WINDOW_DAYS}-day observation window, 0 otherwise. This is tesserix-home #327's ` +
    "go-live gate, the same conjunction the console's own badge shows. A day with no run " +
    "at all counts as not clean, so this cannot be satisfied by a check that stopped running.",
};

/**
 * Escape a label value per the exposition format: backslash, double quote and
 * newline.
 *
 * Provably unnecessary against today's inputs — every label value comes from
 * `STRIPE_MODES` or `CATALOG_SOURCES`, both closed literal unions of bare
 * identifiers. It is here so that stays true STRUCTURALLY rather than by
 * inspection: a source added to the vocabulary with a quote in it would
 * otherwise emit a line no parser can read, and the failure would present as
 * a scrape error somewhere else entirely.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface Sample {
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
}

/** One metric: its HELP, its TYPE, and every sample, in that order. Written
 *  even when a series has zero samples would be a bug, so callers always pass
 *  the full cross product — see the "every pair, always" note below. */
function metric(name: string, samples: readonly Sample[]): string {
  const lines = [`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} gauge`];
  for (const sample of samples) {
    const labels = Object.entries(sample.labels ?? {})
      .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
      .join(",");
    lines.push(`${name}${labels ? `{${labels}}` : ""} ${formatValue(sample.value)}`);
  }
  return lines.join("\n");
}

/** `String(NaN)` is already `NaN`, which is what the format calls for; this
 *  exists so that fact is stated once rather than assumed at three call
 *  sites. */
function formatValue(value: number): string {
  return String(value);
}

/**
 * How many differences the last run found — or NaN when it found out nothing.
 *
 * A `failed` run stores `difference_count = 0` because it never compared
 * anything, and a pair that has never run has no count at all. Emitting 0 for
 * either would assert an agreement the check did not observe, on the series a
 * key revocation is argued from; that is the one lie this endpoint must not
 * tell. `not_bootstrapped` is treated the same way: the comparator does
 * produce a report there and `parity-run.ts` deliberately discards it, so
 * "0 differences" would describe a comparison nobody kept.
 *
 * NaN is a real sample — the series is PRESENT, so this stays distinguishable
 * from a failed scrape — and it satisfies no `> 0` comparison, so it raises
 * no false difference alert. The pair is still covered: its
 * `last_clean_timestamp` is not advancing, which is what the staleness alert
 * fires on.
 */
function differenceValue(
  // The two run types are separate on purpose — their `differences` carry
  // different shapes, and `plan-catalog-repo.ts` argues at length against
  // widening one into the other. This reads NEITHER report: only the outcome
  // and the count, which both carry identically. Taking the structural
  // minimum keeps that separation intact where a union of the two named types
  // would quietly invite a caller to pass the wrong one somewhere else.
  run: Pick<LatestParityRun | LatestEntitlementRun, "outcome" | "differenceCount"> | null,
): number {
  if (!run) return Number.NaN;
  return run.outcome === "clean" || run.outcome === "differences"
    ? run.differenceCount
    : Number.NaN;
}

/**
 * When this pair last agreed with Stripe, in unix seconds — 0 when it never
 * has.
 *
 * 0 means "last clean in 1970", so `time() - <gauge>` is enormous and the
 * staleness alert fires immediately. That is the deliberate choice, and it
 * matches the reading `CatalogParityStale` already relies on in tesserix-k8s
 * for a pod that has never succeeded: a pair configured to be checked and
 * never once clean is exactly the state an operator must be told about. The
 * alternative — omitting the sample, or emitting NaN — would leave a
 * never-clean pair silently uncovered, which is the shape of the gap #579
 * exists to close.
 */
function lastCleanValue(ranAt: string | null): number {
  return ranAt === null ? 0 : Date.parse(ranAt) / 1000;
}

function pairLabels(mode: StripeMode, source: CatalogSource): Record<string, string> {
  return { mode, source };
}

/** One source's two entitlement facts, read together so the emission below
 *  cannot pair one source's count with another's timestamp. */
interface EntitlementSample {
  readonly source: CatalogSource;
  readonly latest: LatestEntitlementRun | null;
  readonly lastCleanAt: string | null;
}

/**
 * Both entitlement facts, for EVERY source in `CATALOG_SOURCES`.
 *
 * Iterated off the constant rather than off whatever the table happens to
 * hold — the same "every one, always" discipline `readLatestRuns` and
 * `readLastCleanRuns` document one axis over, and for the identical reason: a
 * source that has never been checked must SAY so with a present sample, not
 * vanish. An omitted series is indistinguishable from a failed scrape, so
 * deriving the list from the rows would make a brand-new product's silence
 * look exactly like healthy coverage.
 *
 * The two reads are separate because they answer different questions: the
 * latest run whatever its outcome, and the last run that AGREED. On a source
 * failing nightly those diverge, and that divergence is the entire point of
 * the staleness gauge — see `readLastCleanEntitlementRun`.
 */
async function readEntitlementSamples(): Promise<EntitlementSample[]> {
  return Promise.all(
    CATALOG_SOURCES.map(async (source) => {
      const [latest, lastCleanAt] = await Promise.all([
        readLatestEntitlementRun(source),
        readLastCleanEntitlementRun(source),
      ]);
      return { source, latest, lastCleanAt };
    }),
  );
}

/**
 * A scrape that cannot be answered FAILS, loudly, rather than returning an
 * empty or zeroed body.
 *
 * Both alternatives are worse in the same direction. Zeros would assert
 * cleanliness nothing observed. An empty 200 would leave every series absent
 * while `up` stayed 1 — and an absent series makes an alert quiet, so the
 * console losing its database would silently disarm the check that gates a
 * credential revocation. A non-2xx sets `up` to 0, which the estate's
 * ordinary `TargetDown` alert already covers, and it is the state Prometheus
 * has a name for.
 *
 * 501 vs 503 is for a HUMAN with `curl`: Prometheus makes no distinction
 * (both are a failed scrape). 501 mirrors `../parity-check/route.ts`'s
 * "data plane parked" signal for an unconfigured database; 503 is a database
 * that should have answered and did not.
 *
 * The body carries no detail about the failure — a `pg` error names the role
 * and echoes the host, and this response is as readable as the metrics
 * themselves.
 */
function unavailable(status: 501 | 503, reason: string): NextResponse {
  return new NextResponse(`# ${reason}\n`, {
    status,
    headers: { "content-type": CONTENT_TYPE },
  });
}

export async function GET(): Promise<NextResponse> {
  if (!isDatabaseConfigured()) {
    return unavailable(501, "tesserix database is not configured; no parity metrics");
  }

  let latest: Awaited<ReturnType<typeof readLatestRuns>>;
  let lastClean: Awaited<ReturnType<typeof readLastCleanRuns>>;
  let window: Awaited<ReturnType<typeof readWindowStatus>>;
  let entitlements: EntitlementSample[];
  try {
    // All of them or none. A partial body would publish some series and leave
    // others absent — i.e. quietly disarm one alert while the rest kept
    // reporting, which reads as a healthy target the whole time. The
    // entitlement reads join the same barrier rather than getting their own
    // `try`, so an entitlement outage cannot publish a price-only body that
    // looks complete.
    [latest, lastClean, window, entitlements] = await Promise.all([
      readLatestRuns(),
      readLastCleanRuns(),
      // The window belongs to the caller (see `readWindowStatus`), and this
      // caller must ask for the same one the console's badge shows or the
      // alert and the surface can disagree about #327's gate while both are
      // internally consistent.
      readWindowStatus(OBSERVATION_WINDOW_DAYS),
      readEntitlementSamples(),
    ]);
  } catch {
    // Swallowed deliberately, and NOT logged into the response. Nothing about
    // the failure is safe to publish here; the console's own error surface
    // and the pod logs are where a `pg` error belongs.
    return unavailable(503, "tesserix database read failed; no parity metrics");
  }

  // Both reads report EVERY (mode, source) pair, always — a pair with no rows
  // comes back with `run: null` / `ranAt: null` rather than being omitted (see
  // their doc comments). That discipline is what this endpoint is built on: an
  // omitted series is indistinguishable from a scrape failure, so a pair
  // nothing has ever checked has to say so rather than vanish.
  const body = [
    metric(
      DIFFERENCES,
      latest.map((pair) => ({
        labels: pairLabels(pair.mode, pair.source),
        value: differenceValue(pair.run),
      })),
    ),
    metric(
      LAST_CLEAN,
      lastClean.map((pair) => ({
        labels: pairLabels(pair.mode, pair.source),
        value: lastCleanValue(pair.ranAt),
      })),
    ),
    // Unlabelled: #327's gate is one conjunction over every pair, not a fact
    // about any one of them. Labelling it by pair would invite an alert on a
    // per-pair value this series does not carry.
    metric(WINDOW, [{ value: window.satisfied ? 1 : 0 }]),
    metric(
      ENTITLEMENT_DIFFERENCES,
      entitlements.map(({ source, latest: run }) => ({
        labels: { source },
        value: differenceValue(run),
      })),
    ),
    metric(
      ENTITLEMENT_LAST_CLEAN,
      entitlements.map(({ source, lastCleanAt }) => ({
        labels: { source },
        value: lastCleanValue(lastCleanAt),
      })),
    ),
  ].join("\n");

  // Trailing newline: the exposition format terminates every line, including
  // the last one.
  return new NextResponse(`${body}\n`, {
    status: 200,
    headers: { "content-type": CONTENT_TYPE },
  });
}
