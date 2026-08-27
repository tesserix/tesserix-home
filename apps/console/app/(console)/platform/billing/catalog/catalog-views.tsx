// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. This directive is load-bearing.
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import type { SurfaceState } from "@/components/kit/surface-state";
import { policyFor, toStripeUnitAmount } from "@/lib/billing/source-policy";
import { formatMoney } from "@/lib/money";
// Type-only imports throughout this file, deliberately: `lib/db/plan-catalog-repo.ts`
// and `lib/billing/stripe-read.ts` both carry `import "server-only"`, so a
// VALUE import from either would drag `pg` (and, for the latter, the `stripe`
// SDK) into this client bundle and fail `next build` the way `billing-views.tsx`'s
// own comment warns about for `formatMoney`. Types are erased at compile time,
// so this module never actually reaches either module at runtime — the data
// arrives as plain props instead.
import type {
  CatalogRow,
  ModeLatestRun,
  ParityOutcome,
  ParityWindowDay,
  ParityWindowStatus,
} from "@/lib/db/plan-catalog-repo";
import type { StripeMode } from "@/lib/billing/stripe-read";
import type { CatalogSource } from "@/lib/billing/source-policy";
import type { Difference, DifferenceKind, TaxBehavior } from "@/lib/billing/parity";

/**
 * The client half of the plan catalog surface: the observation window (#327's
 * evidence) and the published catalog table, per mode.
 *
 * Two independently-resolved SECTIONS, not two tabs — unlike `billing-views.tsx`'s
 * trials/subscriptions split. The window and the catalog answer different
 * questions ("is the check passing?" vs. "what does the catalog say?") that an
 * operator deciding on #327's revocation wants to see at the same time, not
 * behind a click.
 */

/* ------------------------------------------------------------------------ *
 * Catalog grouping — a `developed` descriptor is ONE Price, not seven rows
 * ------------------------------------------------------------------------ */

export interface CatalogPriceAmount {
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly taxBehavior: TaxBehavior;
}

export interface GroupedCatalogPrice {
  readonly lookupKey: string;
  readonly plan: string;
  readonly period: string;
  readonly tier: string;
  readonly source: CatalogSource;
  readonly amounts: readonly CatalogPriceAmount[];
}

/**
 * Folds `readCatalogRows`'s flat (price x currency) rows back into one row
 * per PRICE — the shape 0032's migration comment describes: a `developed`
 * descriptor is one Stripe Price carrying seven currencies in
 * `currency_options`, and a `ppp` descriptor is one Price with one currency.
 * Rendering the flat rows directly would show 78 rows for 42 prices and imply
 * 78 separate Prices exist, which is exactly the false read #326's migration
 * exists to prevent a comparator from making.
 *
 * Order is preserved from the input (`readCatalogRows`'s own `ORDER BY
 * lookup_key, currency`), so the table reads the same way twice.
 */
export function groupCatalogRows(rows: readonly CatalogRow[]): GroupedCatalogPrice[] {
  const byKey = new Map<
    string,
    { lookupKey: string; plan: string; period: string; tier: string; source: CatalogSource; amounts: CatalogPriceAmount[] }
  >();

  for (const row of rows) {
    const amount: CatalogPriceAmount = {
      currency: row.currency,
      unitAmountMinor: row.unitAmountMinor,
      taxBehavior: row.taxBehavior,
    };
    const existing = byKey.get(row.lookupKey);
    if (existing) {
      existing.amounts.push(amount);
    } else {
      byKey.set(row.lookupKey, {
        lookupKey: row.lookupKey,
        plan: row.plan,
        period: row.period,
        tier: row.tier,
        source: row.source,
        amounts: [amount],
      });
    }
  }

  return [...byKey.values()];
}

/** Title-cases a source id: the only source today is `mark8ly`, and a plain
 *  capitalisation is honest for whatever a second source (#381) turns out to
 *  be named, without inventing a lookup table for a union of one. */
export function catalogSourceLabel(source: CatalogSource): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Every source actually present in `rows`, first-seen order, deduplicated.
 *
 * Read off the DATA, never hardcoded — `readCatalogRows` does not filter by
 * source (see its own doc comment: it is safe today only because every row
 * carries `source = 'mark8ly'`, and stops being safe the moment #381 lands a
 * second one). This function is the console's half of "the dimension is
 * visible before it is needed": a second product's rows make a second option
 * appear here with no code change, rather than the filter control being
 * retrofitted the day #381 ships.
 */
export function availableCatalogSources(rows: readonly CatalogRow[]): CatalogSource[] {
  return [...new Set(rows.map((row) => row.source))];
}

/**
 * Narrows `rows` to one source — `null` means "no filter applied", used when
 * the catalog has not loaded a source list to filter against yet, and kept
 * distinct from filtering to a source that happens to match everything so a
 * caller can always tell the two states apart.
 */
export function filterCatalogBySource(
  rows: readonly CatalogRow[],
  source: CatalogSource | null,
): readonly CatalogRow[] {
  return source === null ? rows : rows.filter((row) => row.source === source);
}

/** Title-cases a plan or period id the same way `catalogSourceLabel` does —
 *  both `plan` and `period` are open-ish vocabularies (0032's migration
 *  comment: no CHECK on `plan` at all), so this is deliberately a
 *  capitalisation, not a lookup table keyed on today's three plan names. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A catalog amount, as an operator should read it — never the raw stored
 * value.
 *
 * # The one thing this function still does that `formatMoney` cannot
 *
 * `unitAmountMinor` is `plan_catalog_amounts.unit_amount_minor` verbatim —
 * mark8ly's own STORAGE convention, not a Stripe minor-unit amount yet.
 * `policyFor(source).amountsAreScaledBy100` records that the catalog stores
 * zero-decimal currencies (VND, JPY, ...) multiplied by 100 for internal
 * consistency, and `toStripeUnitAmount` is the one function allowed to undo
 * that before the value reaches anything that treats it as real money. That
 * conversion is specific to how THIS TABLE stores prices and has no
 * equivalent in `formatMoney`'s world, where every caller already hands in a
 * genuine Stripe minor-unit amount — so this function still exists, and still
 * owns that one step.
 *
 * Everything AFTER that step — dividing a genuine minor-unit amount by its
 * currency's real exponent and rendering it for a human — used to be
 * duplicated here (`stripeMinorUnitDivisor`, a local copy of the same
 * `ZERO_DECIMAL_CURRENCIES` lookup `lib/money.ts`'s `minorUnitExponent` now
 * also uses) because `formatMoney` got that step wrong from `Intl`. Now that
 * `formatMoney` is fixed at the source, this function delegates to it rather
 * than keeping a second, undifferentiated money formatter around — two
 * formatters answering the same question is exactly the drift this pass
 * exists to close.
 */
export function formatCatalogAmount(
  currency: string,
  unitAmountMinor: number,
  source: CatalogSource,
): string {
  const stripeUnitAmount = toStripeUnitAmount(currency, unitAmountMinor, policyFor(source));
  // Uppercased ONLY here, at the `formatMoney` boundary — `toStripeUnitAmount`
  // above consults `ZERO_DECIMAL_CURRENCIES` keyed on the catalog's own
  // lowercase convention (`plan_catalog_amounts_currency_is_lowercase_iso_4217`),
  // so lower-casing earlier would break that lookup. `formatMoney`'s own
  // `isKnownCurrency` check tests against `Intl.supportedValuesOf("currency")`,
  // whose codes are always uppercase — pass the stored lowercase code straight
  // through and every catalog currency reads as "unrecognised" and falls back
  // to the raw `amount currency` pair, which is indistinguishable from this
  // function never having run. This is the same fix the amounts defect
  // originally needed; it survives the delegation to `formatMoney` because
  // `formatMoney` never lower-cases anything itself.
  return formatMoney({ amount: stripeUnitAmount, currency: currency.toUpperCase() });
}

/* ------------------------------------------------------------------------ *
 * Observation window
 * ------------------------------------------------------------------------ */

/**
 * `GroupedCatalogPrice` folded one level further: per plan, per period, split
 * into the ONE `developed` price (if published) and the list of `ppp` prices
 * — the shape the tabbed layout renders directly, one tab per plan.
 */
export interface PeriodSection {
  readonly period: string;
  /** `null` only if a period is published with ppp prices but no developed
   *  one — not a state the catalog is expected to be in, but a component
   *  that assumed non-null here would crash the whole tab on a data surprise
   *  rather than rendering everything else it knows. */
  readonly developed: GroupedCatalogPrice | null;
  readonly ppp: readonly GroupedCatalogPrice[];
}

export interface PlanSection {
  readonly plan: string;
  readonly source: CatalogSource;
  readonly periods: readonly PeriodSection[];
}

/** Preferred period order within a plan's tab. Not exhaustive on purpose —
 *  `period` is CHECK-constrained today to exactly these two values, but a
 *  period this list has never heard of is appended rather than dropped, so a
 *  future third period is visible (out of the preferred order) instead of
 *  silently missing. */
const PREFERRED_PERIOD_ORDER: readonly string[] = ["annual", "monthly"];

/**
 * Groups `GroupedCatalogPrice[]` into one section per plan, each holding its
 * periods in `PREFERRED_PERIOD_ORDER` — the shape #388's tabbed layout
 * renders. `plan` is an open vocabulary (0032's migration: "a fourth plan is
 * a product decision that should not also be a schema migration"), so the
 * SET of tabs and their order comes from the data — first-seen order, which
 * is alphabetical today because `readCatalogRows`' own `ORDER BY lookup_key`
 * already sorts `mark8ly_pro_...` before `mark8ly_starter_...` before
 * `mark8ly_studio_...` — never from a hardcoded plan list that would silently
 * drop a fourth plan the day one ships.
 */
export function organizeCatalogByPlan(prices: readonly GroupedCatalogPrice[]): PlanSection[] {
  const planOrder: string[] = [];
  const byPlan = new Map<string, GroupedCatalogPrice[]>();
  for (const price of prices) {
    if (!byPlan.has(price.plan)) {
      byPlan.set(price.plan, []);
      planOrder.push(price.plan);
    }
    byPlan.get(price.plan)!.push(price);
  }

  return planOrder.map((plan) => {
    const planPrices = byPlan.get(plan)!;
    const byPeriod = new Map<string, GroupedCatalogPrice[]>();
    for (const price of planPrices) {
      const list = byPeriod.get(price.period) ?? [];
      list.push(price);
      byPeriod.set(price.period, list);
    }
    const periodsPresent = [...byPeriod.keys()];
    const orderedPeriods = [
      ...PREFERRED_PERIOD_ORDER.filter((p) => periodsPresent.includes(p)),
      ...periodsPresent.filter((p) => !PREFERRED_PERIOD_ORDER.includes(p)),
    ];
    const periods: PeriodSection[] = orderedPeriods.map((period) => {
      const periodPrices = byPeriod.get(period)!;
      return {
        period,
        developed: periodPrices.find((p) => p.tier === "developed") ?? null,
        ppp: periodPrices.filter((p) => p.tier === "ppp"),
      };
    });
    // `source` is read off the plan's first price rather than threaded
    // through separately: today every price in the catalog carries the same
    // source, and this is the field that will need to change, visibly, the
    // day #381 ships a second one — not a silent per-price average.
    return { plan, source: planPrices[0].source, periods };
  });
}

/**
 * One price's one currency, as a small pill.
 *
 * The lookup key travels as `title` (and folded into the accessible label)
 * rather than as visible text: it is what a parity finding is reported
 * against (`summarizeDifferences` above lists differences BY lookup key), so
 * an operator debugging a difference must be able to find it here — just not
 * at the cost of six-column scaffolding around every price.
 */
function CurrencyChip({
  currency,
  unitAmountMinor,
  source,
  lookupKey,
}: {
  currency: string;
  unitAmountMinor: number;
  source: CatalogSource;
  lookupKey: string;
}) {
  const formatted = formatCatalogAmount(currency, unitAmountMinor, source);
  return (
    <span
      title={lookupKey}
      aria-label={`${formatted} — lookup key ${lookupKey}`}
      className="inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium tabular-nums"
    >
      {formatted}
    </span>
  );
}

/**
 * The `developed` descriptor: ONE Stripe Price, its currencies as chips.
 *
 * The "one price, N currencies" caption is load-bearing, not decoration — it
 * is exactly the fact a flat per-currency table loses, which is the whole
 * reason `groupCatalogRows` exists in the first place (see its own doc
 * comment: "the exact bug the task warns against").
 */
function DevelopedCard({ price }: { price: GroupedCatalogPrice }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        {price.amounts.length === 1
          ? "One price, 1 currency"
          : `One price, ${price.amounts.length} currencies`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {price.amounts.map((amount) => (
          <CurrencyChip
            key={amount.currency}
            currency={amount.currency}
            unitAmountMinor={amount.unitAmountMinor}
            source={price.source}
            lookupKey={price.lookupKey}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The `ppp` descriptors for one period: each one its OWN Price with its own
 * lookup key and a single currency — captioned "one price each" so this
 * visibly reads as a different shape from `DevelopedCard`'s currency options
 * on a single price, not as more currencies on the same one.
 */
function PppChips({ prices }: { prices: readonly GroupedCatalogPrice[] }) {
  if (prices.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">One price each</p>
      <div className="flex flex-wrap gap-1.5">
        {prices.map((price) => (
          <CurrencyChip
            key={price.lookupKey}
            currency={price.amounts[0].currency}
            unitAmountMinor={price.amounts[0].unitAmountMinor}
            source={price.source}
            lookupKey={price.lookupKey}
          />
        ))}
      </div>
    </div>
  );
}

function PeriodSectionView({ section }: { section: PeriodSection }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{titleCase(section.period)}</h3>
      {section.developed ? (
        <DevelopedCard price={section.developed} />
      ) : (
        <p className="text-xs text-muted-foreground">No developed-market price published.</p>
      )}
      <PppChips prices={section.ppp} />
    </div>
  );
}

/**
 * One plan's tab content: a section per period.
 *
 * No static "Source: X" line any more — the source filter next to the mode
 * toggle (see `SourceFilter` / `CatalogViews`) says the same thing and lets
 * an operator ACT on it, so restating it here would be the same fact printed
 * twice for no reason. `rows` passed into `PlanCatalogTabs` are already
 * filtered to the selected source by the time they reach this component.
 */
function PlanTabContent({ section }: { section: PlanSection }) {
  return (
    <div className="flex flex-col gap-4">
      {section.periods.map((period) => (
        <PeriodSectionView key={period.period} section={period} />
      ))}
    </div>
  );
}

/**
 * The catalog, tabbed by plan — Pro | Starter | Studio today, though nothing
 * here hardcodes those three names (see `organizeCatalogByPlan`). Built on
 * `SurfaceTabs`, the same component the Billing page's Trials/Subscriptions
 * split uses, rather than a second tab implementation.
 */
function PlanCatalogTabs({ rows }: { rows: readonly CatalogRow[] }) {
  const sections = organizeCatalogByPlan(groupCatalogRows(rows));
  return (
    <SurfaceTabs
      label="Plan catalog, by plan"
      tabs={sections.map((section) => ({
        id: section.plan,
        label: titleCase(section.plan),
        content: <PlanTabContent section={section} />,
      }))}
    />
  );
}

/**
 * What one day's chip in the strip should say.
 *
 * `readWindowStatus`'s `clean: boolean` alone conflates two very different
 * days: one where the check ran and found a problem, and one where the check
 * never ran at all — see that function's own "a missing day is NOT clean" doc
 * comment, which is correct for the SATISFIED gate (both must count as
 * not-satisfied) and was, until `ParityWindowDay.ran` was added, wrong for a
 * human reading the strip.
 *
 * PREVIOUSLY this was derived from whether a day fell before or after the
 * mode's latest recorded run — a real but narrow inference (see git history),
 * because `readWindowStatus` did not carry per-day outcomes. In production
 * that inference covered only the trailing day or two; every earlier not-clean
 * day fell through to a neutral "not clean" that was then styled the same red
 * as a genuine failure — six of seven chips on a brand-new check's strip,
 * which is the opposite of what "absence of evidence, never evidence of
 * agreement" promises. `ran` closes that gap directly: every day now says
 * definitively whether anything ran at all.
 */
export type DayVerdict = "clean" | "dirty" | "gap";

export function dayVerdict(day: ParityWindowDay): DayVerdict {
  if (!day.ran) return "gap";
  return day.clean ? "clean" : "dirty";
}

/**
 * The one tone vocabulary this file uses for anything that signals status —
 * `outcomeTone` below returns the same four values. `DAY_VERDICT_CLASS`
 * routes through it too, rather than reaching for a raw Tailwind colour
 * (`bg-emerald-500` was here before review caught it): a day chip and an
 * outcome badge are the same kind of signal and must draw from the same
 * semantic tokens, or the two drift the first time the theme changes.
 */
export type SurfaceTone = "success" | "warning" | "error" | "neutral";

/** Solid-fill class per tone, for a small dot/chip — as opposed to `Badge`'s
 *  own variant prop, which `LatestRunSummary` uses directly for the outcome
 *  badge. `neutral` renders as an outline rather than a filled `bg-muted`:
 *  a gap is the ABSENCE of a run, and a hollow mark reads as "nothing here"
 *  more honestly than a solid one would. */
const TONE_DOT_CLASS: Record<SurfaceTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  neutral: "border border-dashed border-muted-foreground/50 bg-transparent",
};

const DAY_VERDICT_TONE: Record<DayVerdict, SurfaceTone> = {
  clean: "success",
  dirty: "error",
  gap: "neutral",
};

const DAY_VERDICT_CLASS: Record<DayVerdict, string> = {
  clean: TONE_DOT_CLASS[DAY_VERDICT_TONE.clean],
  dirty: TONE_DOT_CLASS[DAY_VERDICT_TONE.dirty],
  gap: TONE_DOT_CLASS[DAY_VERDICT_TONE.gap],
};

const DAY_VERDICT_LABEL: Record<DayVerdict, string> = {
  clean: "clean",
  dirty: "ran, not clean",
  gap: "no run recorded",
};

function DayStrip({ days }: { days: readonly ParityWindowDay[] }) {
  return (
    <div className="flex gap-1" role="list" aria-label="Observation window, oldest to newest">
      {days.map((day) => {
        const verdict = dayVerdict(day);
        return (
          <span
            key={day.day}
            role="listitem"
            title={`${day.day}: ${DAY_VERDICT_LABEL[verdict]}`}
            aria-label={`${day.day}: ${DAY_VERDICT_LABEL[verdict]}`}
            className={`h-4 w-4 rounded-sm ${DAY_VERDICT_CLASS[verdict]}`}
          />
        );
      })}
    </div>
  );
}

export function outcomeTone(outcome: ParityOutcome): SurfaceTone {
  switch (outcome) {
    case "clean":
      return "success";
    case "differences":
      return "warning";
    case "failed":
      return "error";
    case "not_bootstrapped":
      return "neutral";
  }
}

const OUTCOME_LABEL: Record<ParityOutcome, string> = {
  clean: "Clean",
  differences: "Differences found",
  failed: "Failed",
  not_bootstrapped: "Not bootstrapped",
};

export function outcomeLabel(outcome: ParityOutcome): string {
  return OUTCOME_LABEL[outcome];
}

/** `YYYY-MM-DD HH:MM UTC` — deterministic and locale-free, unlike
 *  `Intl.DateTimeFormat`, so the same run reads identically for every
 *  operator regardless of browser locale. */
export function formatRanAt(ranAt: string): string {
  return `${new Date(ranAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const DIFFERENCE_KIND_LABEL: Record<DifferenceKind, string> = {
  price_missing_in_stripe: "Missing in Stripe",
  price_missing_in_catalog: "Missing in catalog",
  currency_missing_in_stripe: "Currency missing in Stripe",
  currency_missing_in_catalog: "Currency missing in catalog",
  amount_mismatch: "Amount mismatch",
  tax_behavior_mismatch: "Tax behaviour mismatch",
  price_shape_mismatch: "Shape mismatch",
};

/** Fixed order so the summary reads the same way every time, independent of
 *  the report's own sort (which groups by lookup key first, not by kind). */
const KIND_ORDER: readonly DifferenceKind[] = [
  "price_missing_in_stripe",
  "price_missing_in_catalog",
  "currency_missing_in_stripe",
  "currency_missing_in_catalog",
  "amount_mismatch",
  "tax_behavior_mismatch",
  "price_shape_mismatch",
];

export interface DifferenceSummaryRow {
  readonly kind: DifferenceKind;
  readonly label: string;
  readonly count: number;
  readonly lookupKeys: readonly string[];
}

/**
 * Compacts a stored `differences` report into one row per kind, so a red
 * day's evidence — the thing #327's revocation actually rests on — reads at a
 * glance rather than as a 42-row dump. Every `Difference` variant carries
 * `lookupKey` (see `lib/billing/parity.ts`), so this reads it uniformly across
 * all seven kinds without a switch.
 */
export function summarizeDifferences(differences: readonly Difference[]): DifferenceSummaryRow[] {
  const byKind = new Map<DifferenceKind, string[]>();
  for (const difference of differences) {
    const keys = byKind.get(difference.kind) ?? [];
    keys.push(difference.lookupKey);
    byKind.set(difference.kind, keys);
  }
  return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => {
    const lookupKeys = byKind.get(kind)!;
    return { kind, label: DIFFERENCE_KIND_LABEL[kind], count: lookupKeys.length, lookupKeys };
  });
}

const NO_RUNS_MESSAGE =
  "No parity check has run yet for this mode. Nothing is broken — the nightly check has not recorded its first run.";

function LatestRunSummary({ run, mode }: { run: ModeLatestRun["run"]; mode: StripeMode }) {
  if (run === null) {
    return <p className="text-sm text-muted-foreground">{NO_RUNS_MESSAGE}</p>;
  }
  const summary = summarizeDifferences(run.differences);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={outcomeTone(run.outcome)}>{outcomeLabel(run.outcome)}</Badge>
        <span className="text-muted-foreground">{formatRanAt(run.ranAt)}</span>
        {run.outcome === "differences" ? (
          <span className="text-muted-foreground">
            {run.differenceCount} difference{run.differenceCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {summary.length > 0 ? (
        <ul className="ml-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {summary.map((row) => (
            <li key={`${mode}-${row.kind}`}>
              <span className="font-medium text-foreground">{row.label}</span>
              {` (${row.count}): `}
              <span className="font-mono">{row.lookupKeys.join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ObservationWindow({
  windowStatus,
  windowState,
  runs,
  runsState,
  windowDays,
}: {
  windowStatus: ParityWindowStatus | null;
  windowState: SurfaceState;
  runs: readonly ModeLatestRun[];
  runsState: SurfaceState;
  windowDays: number;
}) {
  if (windowState.kind !== "ready") {
    return (
      <SurfaceStateView
        state={windowState}
        emptyMessage="No observation data. The nightly parity check has not written any rows yet."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {windowStatus!.satisfied
          ? `Both modes have been clean for all ${windowDays} days. #327's gate is satisfied.`
          : `Not every mode is clean across the last ${windowDays} days — #327's gate is not satisfied yet.`}
      </p>
      {windowStatus!.modes.map((mode) => {
        const modeRun = runs.find((r) => r.mode === mode.mode)?.run ?? null;
        return (
          <div key={mode.mode} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize">{mode.mode}</span>
              <Badge variant={mode.satisfied ? "success" : "neutral"}>
                {mode.satisfied ? "satisfied" : "not satisfied"}
              </Badge>
            </div>
            <DayStrip days={mode.days} />
            {runsState.kind === "ready" ? (
              <LatestRunSummary run={modeRun} mode={mode.mode} />
            ) : (
              <SurfaceStateView state={runsState} emptyMessage={NO_RUNS_MESSAGE} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The whole surface
 * ------------------------------------------------------------------------ */

const STRIPE_MODES_FOR_TOGGLE: readonly StripeMode[] = ["test", "live"];

function ModeToggle({ mode }: { mode: StripeMode }) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Stripe mode">
      {STRIPE_MODES_FOR_TOGGLE.map((m) => (
        <Link
          key={m}
          href={`?mode=${m}`}
          role="tab"
          aria-selected={m === mode}
          className={
            m === mode
              ? "rounded-md bg-secondary px-3 py-1 text-sm font-medium capitalize"
              : "rounded-md px-3 py-1 text-sm capitalize text-muted-foreground hover:bg-secondary/50"
          }
        >
          {m}
        </Link>
      ))}
    </div>
  );
}

/**
 * The product (source) filter, sitting beside `ModeToggle` and built in the
 * SAME idiom on purpose — an exclusive row of pills, `role="tab"` /
 * `aria-selected`, no separate "All" state — rather than a new control shape
 * for what is, structurally, the same kind of choice `ModeToggle` already
 * makes (which slice of the catalog am I looking at).
 *
 * Unlike `ModeToggle`, this does NOT drive the URL: `readCatalogRows` already
 * returns every source for the selected mode in one read (see its own doc
 * comment — it does not filter by source), so narrowing to one is a client-side
 * slice of data already on the page, not a reason to round-trip the server.
 *
 * Renders even with exactly one source. One option, permanently selected, is
 * a trivially-satisfied filter — not a reason to hide the control. The
 * dimension is visible in the UI before a second product needs it (#381),
 * rather than retrofitted the day one ships.
 */
function SourceFilter({
  sources,
  selected,
  onChange,
}: {
  sources: readonly CatalogSource[];
  selected: CatalogSource | null;
  onChange: (source: CatalogSource) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="flex gap-1" role="tablist" aria-label="Product">
      {sources.map((source) => (
        <button
          key={source}
          type="button"
          role="tab"
          aria-selected={source === selected}
          onClick={() => onChange(source)}
          className={
            source === selected
              ? "rounded-md bg-secondary px-3 py-1 text-sm font-medium capitalize"
              : "rounded-md px-3 py-1 text-sm capitalize text-muted-foreground hover:bg-secondary/50"
          }
        >
          {catalogSourceLabel(source)}
        </button>
      ))}
    </div>
  );
}

export interface CatalogViewsProps {
  mode: StripeMode;
  windowDays: number;
  windowStatus: ParityWindowStatus | null;
  windowState: SurfaceState;
  catalog: readonly CatalogRow[];
  catalogState: SurfaceState;
  runs: readonly ModeLatestRun[];
  runsState: SurfaceState;
}

export function CatalogViews({
  mode,
  windowDays,
  windowStatus,
  windowState,
  catalog,
  catalogState,
  runs,
  runsState,
}: CatalogViewsProps) {
  // `null` until an operator picks one; the EFFECTIVE selection below always
  // resolves to a real source (or null only when the catalog itself has
  // none), so the rest of the section never has to reason about an unset
  // filter. Re-derived on every render rather than synced with an effect —
  // simpler than `SurfaceTabs`'s own re-sync effect, and correct for the same
  // reason: if `catalog` changes (a mode toggle) and the previously chosen
  // source is no longer present, this falls back to the first available one
  // on its own, with no stale selection ever rendered.
  const [requestedSource, setRequestedSource] = useState<CatalogSource | null>(null);
  const sources = useMemo(() => availableCatalogSources(catalog), [catalog]);
  const effectiveSource =
    requestedSource !== null && sources.includes(requestedSource) ? requestedSource : (sources[0] ?? null);
  const filteredCatalog = useMemo(
    () => filterCatalogBySource(catalog, effectiveSource),
    [catalog, effectiveSource],
  );

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="Observation window">
        <h2 className="text-sm font-medium">Observation window</h2>
        <ObservationWindow
          windowStatus={windowStatus}
          windowState={windowState}
          runs={runs}
          runsState={runsState}
          windowDays={windowDays}
        />
      </section>

      <section className="flex flex-col gap-3" aria-label="Plan catalog">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Plan catalog</h2>
          <div className="flex items-center gap-2">
            <SourceFilter sources={sources} selected={effectiveSource} onChange={setRequestedSource} />
            <ModeToggle mode={mode} />
          </div>
        </div>
        {catalogState.kind === "ready" ? (
          <PlanCatalogTabs rows={filteredCatalog} />
        ) : (
          <SurfaceStateView
            state={catalogState}
            emptyMessage={`No catalog is published to ${mode} yet. This mode has not been bootstrapped.`}
          />
        )}
      </section>
    </div>
  );
}
