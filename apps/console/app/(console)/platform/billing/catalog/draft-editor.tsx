// This directive is load-bearing, same reason `catalog-views.tsx` carries
// one: an editable input needs local state and change handlers, neither of
// which a server component can hold.
"use client";

import { useState, useTransition } from "react";
import { MAGNITUDE_THRESHOLD } from "@/lib/billing/publish-guards";
import { setAmountAction } from "./actions";
// Type-only, deliberately: `parity.ts` carries no `server-only` import today,
// but this file takes no chances with a future one — see `catalog-views.tsx`'s
// identical comment on why every cross-boundary import here is `import type`.
import type { TaxBehavior } from "@/lib/billing/parity";

/**
 * Task 3's editor: the first surface where an operator changes catalog data.
 * It edits a DRAFT (`plan_catalog_revisions` row with no publication yet) —
 * nothing here talks to Stripe, and nothing here publishes. Publishing is a
 * separate task with its own guards and its own confirmation flow
 * (`publish-guards.ts`); this component's only job is to get a correct
 * number into the draft and to tell the operator, AT THE POINT OF EDIT, two
 * things a plan-level guard would only tell them much later:
 *
 *   1. an amount that moved implausibly far from what is currently
 *      published (the early, cheap half of `publish-guards.ts`'s magnitude
 *      guard — see {@link MAGNITUDE_THRESHOLD}, imported rather than
 *      hardcoded so the two checks can never drift apart), and
 *   2. whether THIS edit, if published as-is, would be an in-place
 *      `currency_options` write that reprices existing subscribers at their
 *      next renewal, or a Price replacement that cannot touch them at all —
 *      see {@link repricingNote} for how that is derived from
 *      `publish-plan.ts`'s actual operation taxonomy, not from intuition.
 *
 * # No Subscription read, anywhere in this file
 *
 * `stripe-read.ts` declares one Price-listing method and nothing else — this
 * component states the repricing RULE (`publish-plan.ts`'s own taxonomy), it
 * never claims to know which or how many subscribers a change would affect.
 * Widening the read client to answer that question is explicitly out of
 * scope for this task.
 */

/** One currency's draft-vs-published value for a single lookup key. */
export interface DraftEditorCell {
  readonly currency: string;
  /** The value currently in the draft — what the input edits. */
  readonly draftUnitAmountMinor: number;
  /**
   * The value in the revision the draft was based on — `null` when this
   * currency does not exist there at all, which is the ONE case
   * `publish-plan.ts` can execute in place (`add_currency_option`, a
   * `currency_options` MERGE). See {@link repricingNote}.
   */
  readonly publishedUnitAmountMinor: number | null;
  readonly taxBehavior: TaxBehavior;
}

export interface DraftEditorRow {
  readonly lookupKey: string;
  readonly plan: string;
  readonly period: string;
  readonly tier: string;
  /**
   * The Price's own currency — `publish-plan.ts`'s `resolveBaselineCurrency`
   * calls this the "baseline". Carried here rather than re-derived, because
   * an existing Price's baseline is a Stripe fact (`existing.currency`), not
   * a convention this component is in a position to recompute.
   */
  readonly baselineCurrency: string;
  readonly amounts: readonly DraftEditorCell[];
}

export interface DraftEditorProps {
  readonly revisionId: string;
  readonly rows: readonly DraftEditorRow[];
}

/**
 * Whole positive integer, matching `plan_catalog_amounts.unit_amount_minor`'s
 * own CHECK (`> 0`) — see 0032's comment on that column: a zero can only mean
 * "not set", and a fractional minor unit is not a value Stripe (or this
 * table) can ever store. Refused HERE, before the value ever reaches
 * `setAmountAction`, which enforces the identical rule server-side per this
 * codebase's "never trust external data" boundary rule.
 */
const WHOLE_NUMBER_MESSAGE = "Enter a whole number of minor units.";

function parseMinorUnits(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The early magnitude warning — the cheap catch `publish-guards.ts`'s own
 * header says this task exists to add ("the wrong number entered here is
 * cheapest to catch here"). Reuses {@link MAGNITUDE_THRESHOLD} rather than a
 * second "25%" literal, so this warning and the plan-level guard can never
 * silently disagree about where the line is. This is NOT a replacement for
 * that guard — `checkGuards` still runs, against the ancestor, at publish
 * time; this only gives the operator a chance to catch a fat-fingered digit
 * before it is even saved to the draft.
 */
function magnitudeWarning(published: number | null, draft: number): string | null {
  if (published === null || published === 0) return null;
  const change = Math.abs(draft - published) / published;
  if (change <= MAGNITUDE_THRESHOLD) return null;

  const lower = draft < published;
  const multiplier = Math.round(lower ? published / draft : draft / published);
  return `That is ${multiplier}x ${lower ? "lower" : "higher"} than the published amount (${published}).`;
}

/**
 * States the repricing RULE this specific cell would trigger if published as
 * it stands now — derived from `publish-plan.ts`'s operation taxonomy, not
 * from intuition (see that module's header, "corrected after three sandbox
 * experiments"):
 *
 *   - The row does not exist in Stripe at all yet (no cell in it has a
 *     published amount): publishing CREATES the Price. There is no existing
 *     subscriber to affect, so no repricing note applies.
 *   - This cell's currency already carries a published amount (baseline or
 *     not): Stripe refuses an in-place write to an existing `currency_options`
 *     amount ("attempting to update an immutable field") — publishing this
 *     edit is a `replace_price` (mint a new Price, archive the old one under
 *     its `lookup_key`). The safety property here is the counter-intuitive
 *     one: a replacement CANNOT touch a subscriber already on the old Price.
 *   - This cell's currency has no published amount YET, on a row that
 *     otherwise already exists: publishing is `add_currency_option`, the one
 *     in-place amount write `publish-plan.ts` found survives — Stripe MERGES
 *     `currency_options` on update. That merge reaches every subscriber
 *     already on this Price at their next renewal.
 */
function repricingNote(row: DraftEditorRow, cell: DraftEditorCell): string {
  const rowExistsInStripe = row.amounts.some((a) => a.publishedUnitAmountMinor !== null);
  if (!rowExistsInStripe) {
    return "This price does not exist in Stripe yet — publishing creates it.";
  }
  if (cell.publishedUnitAmountMinor === null) {
    return "This adds a new currency to an existing Price. Stripe merges currency_options in place, which reprices existing subscribers at their next renewal.";
  }
  return "An existing currency's amount is immutable in Stripe. Publishing this replaces the Price (mint new, archive old) — current subscribers stay on their existing Price and are not repriced by this change.";
}

interface AmountCellProps {
  readonly revisionId: string;
  readonly row: DraftEditorRow;
  readonly cell: DraftEditorCell;
}

function AmountCell({ revisionId, row, cell }: AmountCellProps) {
  const [value, setValue] = useState(String(cell.draftUnitAmountMinor));
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(
    magnitudeWarning(cell.publishedUnitAmountMinor, cell.draftUnitAmountMinor),
  );
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const inputLabel = `${row.lookupKey} ${cell.currency} amount`;

  function handleChange(raw: string) {
    setValue(raw);
    setSaveMessage(null);

    const parsed = parseMinorUnits(raw);
    if (parsed === null) {
      setError(WHOLE_NUMBER_MESSAGE);
      setWarning(null);
      return;
    }
    setError(null);
    setWarning(magnitudeWarning(cell.publishedUnitAmountMinor, parsed));
  }

  function handleBlur() {
    const parsed = parseMinorUnits(value);
    if (parsed === null) return; // Already flagged by handleChange; nothing to save.

    startTransition(async () => {
      const result = await setAmountAction(revisionId, row.lookupKey, cell.currency, parsed);
      setSaveMessage(result.ok ? null : result.message);
    });
  }

  return (
    <div>
      <span>{cell.currency}</span>
      {/* The published value beside the draft, unformatted — an operator
       *  editing needs to see what they are changing FROM in the same units
       *  the input edits, not a currency-formatted string that would only
       *  have to be mentally converted back. */}
      <span>{cell.publishedUnitAmountMinor === null ? "not yet published" : cell.publishedUnitAmountMinor}</span>
      <label htmlFor={inputLabel}>{inputLabel}</label>
      <input
        id={inputLabel}
        aria-label={inputLabel}
        inputMode="numeric"
        value={value}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
      {error && <span role="alert">{error}</span>}
      {!error && warning && <span role="status">{warning}</span>}
      {!error && <p>{repricingNote(row, cell)}</p>}
      {saveMessage && <span role="alert">{saveMessage}</span>}
    </div>
  );
}

/**
 * One row per `lookup_key` — a `developed` descriptor's several currencies
 * rendered together, same grouping `catalog-views.tsx`'s `groupCatalogRows`
 * uses for the read-only surface, so an operator sees the same shape in both
 * places.
 */
function DraftEditorRowView({ revisionId, row }: { revisionId: string; row: DraftEditorRow }) {
  return (
    <fieldset>
      <legend>
        {row.plan} · {row.period} · {row.tier} — {row.lookupKey}
      </legend>
      {row.amounts.map((cell) => (
        <AmountCell key={cell.currency} revisionId={revisionId} row={row} cell={cell} />
      ))}
    </fieldset>
  );
}

export function DraftEditor({ revisionId, rows }: DraftEditorProps) {
  return (
    <div>
      {rows.map((row) => (
        <DraftEditorRowView key={row.lookupKey} revisionId={revisionId} row={row} />
      ))}
    </div>
  );
}
