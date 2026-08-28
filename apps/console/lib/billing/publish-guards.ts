/**
 * The publish guards: a built {@link PublishPlan} and the ancestor it was
 * diffed against go in, a verdict on whether it may be executed comes out.
 *
 * # What this module is for
 *
 * `publish-plan.ts` decides WHAT would make Stripe match the draft, correctly.
 * That correctness is mechanical — it says nothing about whether the draft
 * itself is right. A dropped zero, a fat-fingered decimal, an accidental
 * bulk-edit across the wrong rows: every one of those produces a plan that
 * `buildPublishPlan` classifies perfectly and executes without complaint,
 * because the MECHANISM is correct. Spec §7 opens with exactly this: "a
 * correct mechanism publishing a wrong number". These guards are the last
 * thing standing between that plan and a live write.
 *
 * # PURE, same discipline as parity.ts and publish-plan.ts
 *
 * A `PublishPlan` and an ancestor row set in, a verdict out. No I/O, no
 * `stripe` import — not even a type one from `stripe-read.ts` beyond
 * `StripeMode`, and that import is `import type` only, erased at compile
 * time, so it does not drag the `stripe` SDK (or `server-only`) onto this
 * module's runtime import graph. See `parity.ts`'s header for why that
 * restriction earns its keep: this is a function whose correctness must be
 * provable from fixtures, because a check nobody can test is a check nobody
 * can trust.
 *
 * # Refusal vs. confirmation
 *
 * Spec §7 names four rules and splits them two ways:
 *
 *   - **Mode** and **currency coverage** are REFUSALS. Neither is ever
 *     legitimate in v1 — there is no scenario where an operator should be
 *     allowed to type a confirmation past them. Mode because live is
 *     disabled by policy, not by judgement call; currency coverage because a
 *     dropped currency is checkout failing for real customers, and no
 *     operation in `publish-plan.ts` can even repair it (see that module's
 *     header) — confirming past it would not fix anything, it would just
 *     silence the warning.
 *   - **Magnitude** and **breadth** are CONFIRMATIONS. Both describe shapes a
 *     plan can legitimately take — a real repricing, a real bootstrap — so a
 *     human is asked to look and proceed, not blocked outright.
 *
 * A plan that trips both a refusal and a confirmation rule is reported as
 * refused: a confirmation an operator cannot legally act on (because the
 * refusal blocks execution regardless) would be a UI asking for input that
 * changes nothing.
 */

import type { CatalogAmount } from "./parity";
import { policyFor, toStripeUnitAmount, SINGLE_SOURCE } from "./source-policy";
import type { PublishOperation, PublishPlan } from "./publish-plan";
import type { StripeMode } from "./stripe-read";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A cell moving more than this fraction from the ANCESTOR — not observed
 * Stripe, see `checkMagnitude` — requires a typed confirmation (spec §7).
 *
 * 25%, not a smaller number: routine repricing (a $10 plan moving to $11 or
 * $12) must not trip a warning on every ordinary publish, or the warning
 * becomes something operators learn to click through without reading — the
 * exact failure mode this guard exists to prevent. A DROPPED ZERO or a
 * flipped digit produces a 90%+ move almost always; 25% sits well clear of
 * normal pricing changes and well inside catastrophic ones.
 */
export const MAGNITUDE_THRESHOLD = 0.25;

/**
 * More than this many INTENDED plan entries requires a typed confirmation
 * (spec §7).
 *
 * 10, not "any number of entries": a single-cell edit and a five-plan
 * seasonal repricing are both routine operator actions and must not force a
 * confirmation dialog every time. Ten is comfortably inside "I can eyeball
 * this list before I publish it" and comfortably below "this looks like
 * every price in the catalog changed at once", which is the actual signal
 * this guard is watching for — see the bootstrap case below, which is 42
 * entries and legitimate, and gets a confirmation rather than a refusal for
 * exactly that reason.
 */
export const BREADTH_THRESHOLD = 10;

/**
 * More than this many TOTAL plan entries — intended AND drift-correction
 * together — requires a typed confirmation, independent of the
 * intended-only rule above.
 *
 * F2 (whole-branch fix wave, 2026-08-28). `checkBreadth` used to read ONLY
 * `plan.counts.intended`, which is fail-safe when a plan has SOME intent
 * (see `checkBreadth`'s doc comment on `combineOrigins`) but says nothing
 * about the plan this system can produce with NO intent at all:
 * `ancestor === draft` with an empty or wrong observation (a truncated
 * `listPrices` page, the wrong account, a mode mix-up upstream) turns every
 * row into a `price_missing_in_stripe` diff and every operation
 * `drift-correction` — `counts.intended` stays 0 no matter how large the
 * plan gets, and the ONLY guard that could have caught "42 creates against a
 * live billing account" never fires.
 *
 * 39, not 10: a CONFIRMATION, not a refusal — spec §7's own named bootstrap
 * case is 42 legitimate creates into an empty mode and must remain possible
 * without code changing. This threshold sits comfortably below that 42 (so
 * the bootstrap still trips it and asks a human to look) and comfortably
 * above `BREADTH_THRESHOLD` (so it does not duplicate the intended-only
 * rule's job on an ordinary publish).
 */
export const BREADTH_TOTAL_THRESHOLD = 39;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type GuardRule = "magnitude" | "breadth" | "currency-coverage" | "mode";

export interface GuardBreach {
  readonly rule: GuardRule;
  /** Human-readable, safe to show verbatim in a confirmation dialog or a refusal message. */
  readonly message: string;
  readonly lookupKey?: string;
  readonly currency?: string;
}

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly requiresConfirmation: readonly GuardBreach[] }
  | { readonly ok: false; readonly refused: readonly GuardBreach[] };

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * v1 is test-only, enforced in code (spec §7) — not a judgement call an
 * operator can override with a confirmation. The estate lost an hour to a
 * live/test key mix-up on 2026-08-27 (spec §7); live's first publish will
 * also be the largest single action this tool ever takes, so it stays behind
 * a code change, not a checkbox, until live is deliberately turned on.
 */
function checkMode(mode: StripeMode): GuardBreach[] {
  if (mode === "test") return [];
  return [
    {
      rule: "mode",
      message: `Publishing to Stripe mode "${mode}" is refused in v1 — only "test" is enabled.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Currency coverage
// ---------------------------------------------------------------------------

/**
 * A `currency_missing_in_catalog` entry in `plan.unactionable` means: Stripe
 * carries a currency the draft no longer wants, and no operation in
 * `publish-plan.ts` can remove a `currency_options` entry — Stripe offers no
 * such call. For a `developed` price this is spec §7's named case: the price
 * loses one of its seven currencies, checkout breaks for that country, and a
 * clean parity check afterwards would say nothing about it because there is
 * nothing left to compare — the row the draft dropped is simply gone from
 * the catalog side.
 *
 * REFUSAL, not confirmation, because there is no in-scope way for an
 * operator to "confirm past" this and have it be true: publishing this plan
 * cannot make Stripe converge to what the draft wants. The draft itself has
 * to change first (re-add the currency, or accept the drop deliberately by
 * some path this guard is not the one to authorize).
 *
 * `price_shape_mismatch` unactionable entries (wrong interval/active/product)
 * are DELIBERATELY NOT refused here — see this module's header on the
 * question the brief asked. They remain visible on `plan.unactionable` for
 * any caller building a confirmation UI to render regardless of this
 * guard's verdict; that is `publish-plan.ts`'s job, already done. Refusing
 * an otherwise-safe publish over pre-existing, unrelated shape drift would
 * make every future publish to a key with a stale interval permanently
 * unrefusable-past, which is the "warning nobody can act on" failure mode
 * spec §7 explicitly rejects for the removed "reprices existing subscribers"
 * warning.
 */
function checkCurrencyCoverage(plan: PublishPlan): GuardBreach[] {
  return plan.unactionable
    .filter((d) => d.kind === "currency_missing_in_catalog")
    .map((d) => ({
      rule: "currency-coverage" as const,
      message: `${d.lookupKey} would lose currency "${d.currency}" — Stripe cannot remove a currency_options entry, so checkout would fail for that currency.`,
      lookupKey: d.lookupKey,
      currency: d.currency,
    }));
}

// ---------------------------------------------------------------------------
// Breadth
// ---------------------------------------------------------------------------

/**
 * `plan.counts.intended` is the count the brief asks this guard to read, and
 * it is SAFE to read directly despite `origin` collapsing to one value per
 * operation (see this module's header on the origin-granularity question):
 * `publish-plan.ts`'s `combineOrigins` resolves a mix of causes to
 * `"intended"` whenever ANY contributing cause is intended, and to
 * `"drift-correction"` only when EVERY contributing cause is drift. So
 * `counts.intended` can only OVER-count true operator intent (a
 * drift-correction riding inside an intended replace gets folded in), never
 * UNDER-count it. A breadth guard that over-counts intended entries can only
 * ask for confirmation MORE readily than a perfectly precise count would —
 * it cannot wave through a broad change that a precise count would have
 * caught. That is the fail-safe direction the brief asks for, and it falls
 * out of the existing two-value label without needing a third one. See the
 * header for what WOULD need a finer label.
 */
function checkBreadth(plan: PublishPlan): GuardBreach[] {
  if (plan.counts.intended > BREADTH_THRESHOLD) {
    return [
      {
        rule: "breadth",
        message: `${plan.counts.intended} intended entries exceed the breadth threshold of ${BREADTH_THRESHOLD}; confirm before publishing.`,
      },
    ];
  }

  // F2: catches the all-drift (or mostly-drift) plan the rule above is
  // structurally blind to — see `BREADTH_TOTAL_THRESHOLD`'s doc comment.
  if (plan.counts.total > BREADTH_TOTAL_THRESHOLD) {
    return [
      {
        rule: "breadth",
        message: `${plan.counts.total} total entries exceed the breadth threshold of ${BREADTH_TOTAL_THRESHOLD}; confirm before publishing.`,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Magnitude
// ---------------------------------------------------------------------------

/** `(lookupKey, currency) -> Stripe-scaled ancestor unit amount`. */
function ancestorStripeAmounts(ancestor: readonly CatalogAmount[]): Map<string, number> {
  const policy = policyFor(SINGLE_SOURCE);
  const byCell = new Map<string, number>();
  for (const row of ancestor) {
    byCell.set(
      `${row.lookupKey} ${row.currency}`,
      toStripeUnitAmount(row.currency, row.unitAmountMinor, policy),
    );
  }
  return byCell;
}

interface ProposedCell {
  readonly lookupKey: string;
  readonly currency: string;
  readonly unitAmount: number;
}

/**
 * Every (lookup key, currency, proposed Stripe-scaled amount) cell a
 * create/replace/add-currency operation carries. `update_tax_behavior`,
 * `archive_price` and `create_product` carry no amount and contribute
 * nothing here — `create_product` in particular has no `lookupKey` at all,
 * which is why this returns the key alongside each cell rather than leaving
 * the caller to read `op.lookupKey` off a still-unnarrowed union.
 */
function proposedCells(op: PublishOperation): readonly ProposedCell[] {
  if (op.kind === "create_price" || op.kind === "replace_price") {
    return [
      { lookupKey: op.lookupKey, currency: op.currency, unitAmount: op.unitAmount },
      ...Object.entries(op.currencyOptions).map(([currency, value]) => ({
        lookupKey: op.lookupKey,
        currency,
        unitAmount: value.unitAmount,
      })),
    ];
  }
  if (op.kind === "add_currency_option") {
    return Object.entries(op.currencyOptions).map(([currency, value]) => ({
      lookupKey: op.lookupKey,
      currency,
      unitAmount: value.unitAmount,
    }));
  }
  return [];
}

/**
 * Measured against the ANCESTOR, not observed Stripe (spec §7). Two
 * different questions produce two different, both-wrong-if-swapped answers:
 *
 *   - Against the ancestor: "does this move diverge from what we last told
 *     Stripe to publish?" A dropped zero IS that divergence — the operator's
 *     own prior intent is the baseline a mistake departs from.
 *   - Against observed Stripe: correcting real Dashboard drift (the whole
 *     POINT of `drift-correction` operations) would trip this guard every
 *     time, and a genuine typo that happens to land near whatever the
 *     Dashboard currently holds would sail through it. Neither is the
 *     question this guard is meant to answer.
 *
 * Cells with no ancestor value are SKIPPED, not treated as an infinite or
 * undefined move — a brand-new lookup key (bootstrap, or a genuinely new
 * plan) has no prior amount to diverge from; it has a first one. That is
 * exactly why 42 bootstrap creates trip the breadth guard and not this one.
 *
 * Compared in Stripe's representation via {@link toStripeUnitAmount}
 * (`source-policy.ts`), the same conversion `publish-plan.ts` already applies
 * to every operation's own `unitAmount` — comparing the ancestor's raw
 * catalog-scale number against an already-converted operation amount would
 * be wrong by exactly 100x for every zero-decimal currency (VND, JPY, ...),
 * the same defect `source-policy.ts`'s header says has already had to be
 * guarded against twice elsewhere.
 */
function checkMagnitude(plan: PublishPlan, ancestor: readonly CatalogAmount[]): GuardBreach[] {
  const ancestorAmounts = ancestorStripeAmounts(ancestor);
  const breaches: GuardBreach[] = [];

  for (const op of plan.operations) {
    for (const cell of proposedCells(op)) {
      const before = ancestorAmounts.get(`${cell.lookupKey} ${cell.currency}`);
      if (before === undefined || before === 0) continue;

      const change = Math.abs(cell.unitAmount - before) / before;
      if (change <= MAGNITUDE_THRESHOLD) continue;

      breaches.push({
        rule: "magnitude",
        message: `${cell.lookupKey} (${cell.currency}) moves ${(change * 100).toFixed(1)}% from the ancestor (${before} -> ${cell.unitAmount}); confirm before publishing.`,
        lookupKey: cell.lookupKey,
        currency: cell.currency,
      });
    }
  }
  return breaches;
}

// ---------------------------------------------------------------------------
// checkGuards
// ---------------------------------------------------------------------------

/**
 * Judge a built plan before it is allowed to execute. See this module's
 * header for the refusal/confirmation split and why a refusal wins over any
 * simultaneous confirmation.
 */
export function checkGuards(
  plan: PublishPlan,
  ancestor: readonly CatalogAmount[],
  mode: StripeMode,
): GuardVerdict {
  const refused = [...checkMode(mode), ...checkCurrencyCoverage(plan)];
  if (refused.length > 0) return { ok: false, refused };

  const requiresConfirmation = [...checkMagnitude(plan, ancestor), ...checkBreadth(plan)];
  if (requiresConfirmation.length > 0) return { ok: false, requiresConfirmation };

  return { ok: true };
}
