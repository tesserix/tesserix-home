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
 * number into the draft and to tell the operator, AT THE POINT OF EDIT, the
 * one thing a plan-level guard would only tell them much later: an amount
 * that moved implausibly far from what is currently published (the early,
 * cheap half of `publish-guards.ts`'s magnitude guard — see
 * {@link MAGNITUDE_THRESHOLD}, imported rather than hardcoded so the two
 * checks can never drift apart).
 *
 * # No "reprices existing subscribers" warning — REMOVED ON PURPOSE
 *
 * An earlier version of this file classified each cell as an in-place
 * `add_currency_option` write (claimed to reprice existing subscribers at
 * their next renewal) or a `replace_price` write (claimed not to), following
 * a stale reading of a superseded draft of the design spec. The spec's THIRD
 * draft — `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md`,
 * §6, "Existing subscribers — the hazard does not exist" — settles this by
 * SANDBOX EXPERIMENT, not inference: `[V]` there is no in-place amount edit
 * at all (§1.6a) — every amount change, baseline or non-baseline currency,
 * new or existing, is a `replace_price`, because `unit_amount` is immutable
 * once a Price exists. §6's own words: "No catalog edit this design can
 * perform will reprice an existing subscriber." §7 explicitly removes the
 * "this reprices existing subscribers" confirmation for exactly this reason
 * — "a guard against an impossible action is noise that costs an operator's
 * attention on every publish, and attention spent on a false warning is
 * attention not spent on a real one." Restoring any version of that warning
 * here would be reintroducing the false claim the spec's own experiments
 * disproved — see {@link SUBSCRIBER_SAFETY_NOTE} for what replaced it.
 *
 * # No Subscription read, anywhere in this file
 *
 * `stripe-read.ts` declares one Price-listing method and nothing else, and
 * spec §6 says explicitly: "Do not widen it." There is nothing to warn about
 * per-cell (see above), so this component never claims to know which or how
 * many subscribers exist at all.
 */

/** One currency's draft-vs-published value for a single lookup key. */
export interface DraftEditorCell {
  readonly currency: string;
  /** The value currently in the draft — what the input edits. */
  readonly draftUnitAmountMinor: number;
  /**
   * The value in the revision the draft was based on — `null` when this
   * currency does not exist there at all (a brand-new currency, or a
   * brand-new price). Shown beside the draft value so an operator can see
   * what they are changing FROM; carries no repricing implication — see
   * this file's header on why that distinction was removed.
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
 *
 * # "Nx" only once it means something; a percentage below that
 *
 * Review 2026-08-28: `Math.round` on the ratio degenerated to "1x higher"
 * (or "1x lower") for EVERY move between 25% and 49% — precisely the
 * near-threshold band this warning exists to make legible, since that is
 * the band a fat-fingered digit most often lands in. Below a 2x move, a
 * rounded percentage stays precise and honest; at or above 2x, "Nx" is both
 * true and easier to read at a glance than a four-digit percentage.
 */
function magnitudeWarning(published: number | null, draft: number): string | null {
  if (published === null || published === 0) return null;
  const change = Math.abs(draft - published) / published;
  if (change <= MAGNITUDE_THRESHOLD) return null;

  const lower = draft < published;
  const direction = lower ? "lower" : "higher";
  const ratio = lower ? published / draft : draft / published;
  const magnitude = ratio >= 2 ? `${Math.round(ratio)}x` : `${Math.round(change * 100)}%`;
  return `That is ${magnitude} ${direction} than the published amount (${published}).`;
}

/**
 * The one thing an operator needs told about who a publish affects — spec
 * §6's own closing statement, quoted rather than paraphrased so this stays
 * traceable to the experiment-settled source: "a price change applies to
 * new subscriptions only. Existing subscribers stay on the Price object
 * they were created against until something migrates them deliberately,
 * which is not in scope." A constant, not a per-cell function: §6 (`[V]`,
 * settled by sandbox experiment, not inference) establishes this holds for
 * EVERY amount change — there is no in-place path at all, so there is
 * nothing left to branch on per cell. See this file's header for why a
 * per-cell classification used to exist here, and why it was wrong.
 *
 * Rendered ONCE, at the {@link DraftEditor} surface level — not once per
 * cell. Review 2026-08-28: spec §6 asks the SURFACE to say this, not every
 * cell; a full catalog is 78 amount cells, and 78 repetitions of a safety
 * statement is how a safety statement stops being read. Undercutting the
 * very ruling this note exists to implement.
 */
const SUBSCRIBER_SAFETY_NOTE =
  "This applies to new subscriptions only. Existing subscribers stay on the Price they were created against until something migrates them deliberately (out of scope here).";

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
  // A distinct DOM id (no spaces) from the accessible NAME above — `id`/
  // `htmlFor` is plumbing, `inputLabel` is what a screen reader announces.
  // Review 2026-08-28: these used to be the same string, rendered visibly
  // inside the `<label>` — an operator editing PRICES saw a raw
  // `lookup_key currency "amount"` string on screen. `sr-only` below keeps
  // the full, uniquely-identifying label available to assistive tech
  // without putting it in front of anyone's eyes.
  const inputId = `${row.lookupKey}-${cell.currency}-amount`;

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
      <label htmlFor={inputId} className="sr-only">
        {inputLabel}
      </label>
      <input
        id={inputId}
        inputMode="numeric"
        value={value}
        disabled={isPending}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
      />
      {error && <span role="alert">{error}</span>}
      {!error && warning && <span role="status">{warning}</span>}
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
      {/* Once for the whole surface — see {@link SUBSCRIBER_SAFETY_NOTE}'s
       *  doc comment on why this moved out of `AmountCell`. */}
      <p>{SUBSCRIBER_SAFETY_NOTE}</p>
      {rows.map((row) => (
        <DraftEditorRowView key={row.lookupKey} revisionId={revisionId} row={row} />
      ))}
    </div>
  );
}
