// See page-header.tsx: @tesserix/web's barrel is "use client", so its exports
// are `undefined` inside a server component. This directive is load-bearing.
"use client";

import Link from "next/link";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
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

const CATALOG_COLUMNS: Array<{ key: string; header: string }> = [
  { key: "plan", header: "Plan" },
  { key: "period", header: "Period" },
  { key: "tier", header: "Tier" },
  { key: "source", header: "Source" },
  { key: "lookupKey", header: "Lookup key" },
  { key: "amounts", header: "Amounts" },
];

/** Title-cases a source id: the only source today is `mark8ly`, and a plain
 *  capitalisation is honest for whatever a second source (#381) turns out to
 *  be named, without inventing a lookup table for a union of one. */
export function catalogSourceLabel(source: CatalogSource): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function CatalogTable({ rows }: { rows: readonly CatalogRow[] }) {
  const grouped = groupCatalogRows(rows);
  return (
    <div className="rounded-lg border">
      <Table aria-label="Plan catalog">
        <TableHeader>
          <TableRow>
            {CATALOG_COLUMNS.map((c) => (
              <TableHead key={c.key}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.map((price) => (
            <TableRow key={price.lookupKey}>
              <TableCell className="font-medium capitalize">{price.plan}</TableCell>
              <TableCell className="capitalize">{price.period}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {price.tier}
                </Badge>
                {/* One Price, `amounts.length` currencies — stated here so the
                    row cannot be misread as `amounts.length` separate prices. */}
                <span className="ml-1 text-xs text-muted-foreground">
                  {price.amounts.length === 1
                    ? "1 currency"
                    : `${price.amounts.length} currencies, one price`}
                </span>
              </TableCell>
              <TableCell>{catalogSourceLabel(price.source)}</TableCell>
              <TableCell className="font-mono text-xs">{price.lookupKey}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs tabular-nums">
                  {price.amounts.map((amount) => (
                    <span key={amount.currency} className="whitespace-nowrap">
                      {formatMoney({ amount: amount.unitAmountMinor, currency: amount.currency })}
                    </span>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Observation window
 * ------------------------------------------------------------------------ */

/**
 * What one day's chip in the strip should say.
 *
 * `readWindowStatus`'s `clean: boolean` conflates two very different days: one
 * where the check ran and found a problem, and one where the check never ran
 * at all — see that function's own "a missing day is NOT clean" doc comment,
 * which is correct for the SATISFIED gate (both must count as not-satisfied)
 * and wrong for a human reading the strip, who needs to know which one it was.
 *
 * This is derived, not queried: `readWindowStatus` does not carry per-day
 * outcomes, and adding a third repo function to get them was out of this
 * task's scope. What CAN be said honestly from data already on this page:
 *
 *  - A day strictly AFTER the mode's most recent recorded run is
 *    MATHEMATICALLY a gap — no run can exist for a mode after its own latest
 *    one, so if that day is not clean, nothing ran on it at all. This is the
 *    common case in practice: the check hasn't run yet today, or hasn't run
 *    in several days.
 *  - A not-clean day AT OR BEFORE the latest run could be a genuine failure
 *    OR an earlier gap the check later recovered from, and nothing on this
 *    page can tell those apart. Rather than guess, it renders as the neutral
 *    "not clean" — narrower than the task's ideal three-way split, but never
 *    overstating in either direction.
 */
export type DayVerdict = "clean" | "gap" | "not-clean";

export function dayVerdict(day: ParityWindowDay, latestRunDay: string | null): DayVerdict {
  if (day.clean) return "clean";
  if (latestRunDay === null || day.day > latestRunDay) return "gap";
  return "not-clean";
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
  "not-clean": "error",
  gap: "neutral",
};

const DAY_VERDICT_CLASS: Record<DayVerdict, string> = {
  clean: TONE_DOT_CLASS[DAY_VERDICT_TONE.clean],
  "not-clean": TONE_DOT_CLASS[DAY_VERDICT_TONE["not-clean"]],
  gap: TONE_DOT_CLASS[DAY_VERDICT_TONE.gap],
};

const DAY_VERDICT_LABEL: Record<DayVerdict, string> = {
  clean: "clean",
  "not-clean": "not clean",
  gap: "no run recorded",
};

/** `ranAt`'s UTC date, `YYYY-MM-DD` — comparable directly against
 *  `ParityWindowDay.day`, which `readWindowStatus` already formats the same
 *  way with `to_char(..., 'YYYY-MM-DD')`. */
function utcDateOf(ranAt: string): string {
  return ranAt.slice(0, 10);
}

function DayStrip({ days, latestRunDay }: { days: readonly ParityWindowDay[]; latestRunDay: string | null }) {
  return (
    <div className="flex gap-1" role="list" aria-label="Observation window, oldest to newest">
      {days.map((day) => {
        const verdict = dayVerdict(day, latestRunDay);
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
        const latestRunDay = modeRun ? utcDateOf(modeRun.ranAt) : null;
        return (
          <div key={mode.mode} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize">{mode.mode}</span>
              <Badge variant={mode.satisfied ? "success" : "neutral"}>
                {mode.satisfied ? "satisfied" : "not satisfied"}
              </Badge>
            </div>
            <DayStrip days={mode.days} latestRunDay={latestRunDay} />
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
          <ModeToggle mode={mode} />
        </div>
        {catalogState.kind === "ready" ? (
          <CatalogTable rows={catalog} />
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
