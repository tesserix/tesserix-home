// Load-bearing, same reason `draft-editor.tsx` carries one: the typed-mode
// gate, the confirmation dialog's open state and the publish transition are
// all local state a server component cannot hold.
"use client";

import { useState, useTransition } from "react";
import { Button, Callout, CalloutDescription, Input, Label } from "@tesserix/web";
import { DestructiveConfirmDialog } from "@/components/kit/destructive-confirm-dialog";
import { BREADTH_THRESHOLD, MAGNITUDE_THRESHOLD } from "@/lib/billing/publish-guards";
// Type-only across the server/client boundary, deliberately — and NOT
// optional politeness: `publish-plan.ts` imports `node:crypto` and
// `publish-guards.ts` is one `import type` away from `stripe-read.ts`. A
// VALUE import of either shape from here would drag that graph into the
// browser bundle, which `tsc` and `vitest` both pass and only `next build`
// catches (see `tools-manager.tsx`'s identical note). The two threshold
// constants above are the one exception, and they are safe for the same
// reason `draft-editor.tsx` already imports `MAGNITUDE_THRESHOLD`:
// `publish-guards.ts` is pure, and every import IT makes of a server module
// is itself `import type`.
import type { GuardBreach, GuardVerdict } from "@/lib/billing/publish-guards";
import type { PublishPlanCounts, UnactionableDifference } from "@/lib/billing/publish-plan";
import type { StripeMode } from "@/lib/billing/stripe-read";
import { publishAction } from "./actions";

/**
 * The publish screen: the surface that turns a draft revision into Stripe
 * writes. Everything before this task was inert — `publish-plan.ts`,
 * `publish-guards.ts` and `publish-executor.ts` had no caller — and this
 * component, with `publishAction` in `actions.ts`, is the first thing in the
 * console that can change what mark8ly charges.
 *
 * # It shows OPERATIONS, not a row count
 *
 * "6 prices changed" is the summary this view refuses to render. The
 * distinction that matters to an operator is what Stripe will actually DO:
 * a `replace_price` RETIRES a Price object and mints a new one (spec §1.3 —
 * `unit_amount` is immutable, so every amount change is a replacement),
 * while an `add_currency_option` / `update_tax_behavior` edits the Price
 * that already exists. Those are different actions with different
 * consequences, and collapsing them into one number hides the one an
 * operator would want to stop.
 *
 * # Intended vs. drift, side by side
 *
 * `publish-plan.ts` labels every operation `intended` (the draft asked for
 * it) or `drift-correction` (Stripe has diverged from what was last
 * published). "1 intended, 39 correcting drift" is a completely different
 * thing to approve than "40 changes", and it is the shape the breadth guard
 * reads too (`BREADTH_THRESHOLD`, `BREADTH_TOTAL_THRESHOLD`).
 *
 * # Refusal vs. confirmation — routed differently, never collapsed
 *
 * `publish-guards.ts`'s two verdict shapes mean two different things and get
 * two different treatments here:
 *
 *   - REFUSED (`mode`, `currency-coverage`): the confirm button stays
 *     disabled and no amount of typing enables it. The control is NOT
 *     hidden and the reason is stated — a control that vanishes teaches an
 *     operator nothing, and `checkMode`'s live refusal in particular is a
 *     policy an operator needs to be able to read.
 *   - REQUIRES CONFIRMATION (`magnitude`, `breadth`): the breaches are shown
 *     and the typed-mode gate is what clears them. Disabling the button here
 *     too would make spec §7's two legitimate-but-large shapes
 *     unpublishable, which is precisely the collapse `publish-guards.ts`'s
 *     header rejects.
 *
 * # The typed-mode gate is built for live from day one
 *
 * Spec §7: the estate lost an hour to a live/test key mix-up on 2026-08-27,
 * and live's first publish is a 42-price bootstrap — the largest single
 * action this tool will ever take. v1 refuses live in code, so this gate
 * only ever sees `test` today; it is built for both anyway, because the day
 * live is turned on is not the day to be writing the confirmation for it.
 */

export interface PublishViewProps {
  readonly revisionId: string;
  readonly mode: StripeMode;
  readonly counts: PublishPlanCounts;
  /** Diffs no operation can fix — see `PublishPlan.unactionable`. Shown
   *  whatever the verdict says: `checkCurrencyCoverage` refuses on the
   *  `currency_missing_in_catalog` ones, but the `price_shape_mismatch` ones
   *  are deliberately NOT refused and would otherwise be invisible. */
  readonly unactionable: readonly UnactionableDifference[];
  readonly verdict: GuardVerdict;
}

const MAGNITUDE_PERCENT = `${Math.round(MAGNITUDE_THRESHOLD * 100)}%`;

/**
 * The live refusal, in the operator's words rather than the guard's.
 *
 * `checkMode`'s own message ("Publishing to Stripe mode \"live\" is refused
 * in v1") is shown too, immediately after this — but it describes the rule,
 * not why the rule exists, and "why" is the part that stops someone filing a
 * bug about a broken button.
 */
const LIVE_REFUSAL_NOTE =
  "Live publishing is not enabled. v1 publishes to Stripe test only — the refusal is in code (publish-guards.ts), not a setting, " +
  "because the estate lost an hour to a live/test key mix-up on 2026-08-27 and live's first publish is a 42-price bootstrap. " +
  "Turning it on is a deliberate change, reviewed on its own.";

function refusedBreaches(verdict: GuardVerdict): readonly GuardBreach[] {
  return !verdict.ok && "refused" in verdict ? verdict.refused : [];
}

function confirmationBreaches(verdict: GuardVerdict): readonly GuardBreach[] {
  return !verdict.ok && "requiresConfirmation" in verdict ? verdict.requiresConfirmation : [];
}

/**
 * One line per THING STRIPE DOES, in the order it does it (products, then
 * creates, then in-place updates, then replacements, then archives) — the
 * same ordering `publish-plan.ts` sorts operations into and
 * `publish-executor.ts` executes them in.
 *
 * `add_currency_option` and `update_tax_behavior` are counted TOGETHER as
 * "updated in place": both edit an existing Price object and neither retires
 * one, which is the single fact this line exists to distinguish from
 * "replaced". Zero-count lines are omitted rather than rendered as "0
 * replaced" — a list of zeroes is noise an operator has to read past to find
 * the one number that isn't.
 */
function operationLines(counts: PublishPlanCounts): readonly string[] {
  const updatedInPlace = counts.add_currency_option + counts.update_tax_behavior;
  const lines: string[] = [];
  if (counts.create_product > 0) {
    lines.push(`${counts.create_product} Stripe Product${counts.create_product === 1 ? "" : "s"} created`);
  }
  if (counts.create_price > 0) {
    lines.push(`${counts.create_price} created — a Price that does not exist in Stripe yet`);
  }
  if (updatedInPlace > 0) {
    lines.push(`${updatedInPlace} updated in place — the existing Price object is kept`);
  }
  if (counts.replace_price > 0) {
    lines.push(
      `${counts.replace_price} replaced — a new Price object is created and the old one archived, because unit_amount cannot be edited`,
    );
  }
  if (counts.archive_price > 0) {
    lines.push(`${counts.archive_price} archived — the Price stays in Stripe, deactivated`);
  }
  return lines;
}

/** Trimmed and case-insensitive, exactly like the CRM's typed-name gate
 *  (`organisation-detail-view.tsx`): requiring exact case is friction with no
 *  safety benefit, and it produces a disabled button with no stated reason a
 *  sighted operator can see. Still requires the whole word. */
function typedModeMatches(typed: string, mode: StripeMode): boolean {
  return typed.trim().toLowerCase() === mode;
}

function BreachList({ breaches, tone }: { breaches: readonly GuardBreach[]; tone: "refused" | "confirm" }) {
  if (breaches.length === 0) return null;
  return (
    <Callout role="alert" variant={tone === "refused" ? "destructive" : "default"}>
      {/* The list is a SIBLING of `CalloutDescription`, not a child of it:
          that component renders a `<p>`, and a `<ul>` inside a paragraph is
          invalid HTML the browser reparents out from under React. */}
      {breaches.some((breach) => breach.rule === "mode") ? (
        <CalloutDescription>{LIVE_REFUSAL_NOTE}</CalloutDescription>
      ) : null}
      <ul>
        {breaches.map((breach) => (
          <li key={`${breach.rule}-${breach.lookupKey ?? ""}-${breach.currency ?? ""}-${breach.message}`}>
            {breach.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

export function PublishView({ revisionId, mode, counts, unactionable, verdict }: PublishViewProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refused = refusedBreaches(verdict);
  const confirmations = confirmationBreaches(verdict);
  const lines = operationLines(counts);
  const statusId = "publish-confirm-status";
  const typedFieldId = "publish-confirm-mode";

  /**
   * Refusals disable the button forever; confirmations are cleared by the
   * typed-mode gate — see this module's header. Both are checked again on
   * the server (`publishAction`, and `executePublish`'s own re-run of
   * `checkGuards`): this is the defence against a slip of the mouse, never
   * the control.
   */
  const confirmDisabled = refused.length > 0 || !typedModeMatches(typed, mode);

  const reset = () => {
    setTyped("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await publishAction(revisionId, mode, {
        typedMode: typed,
        // The rules the operator was actually SHOWN. The server refuses if
        // the plan it rebuilds breaches a rule that is not in this list —
        // so a breach that appeared between planning and confirming (a
        // second operator's edit, Stripe moving underneath) blocks the
        // publish instead of riding through on a confirmation given for a
        // different plan.
        acknowledged: confirmations.map((breach) => breach.rule),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      reset();
      setDone(
        result.outcome === "succeeded"
          ? "Published. Stripe now matches this revision, and it is the mode's published catalog."
          : `Publish finished with outcome "${result.outcome}" — ${result.failedOperations.length} operation(s) did not complete. ` +
            "The catalog was NOT promoted; read the publish log before retrying.",
      );
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2>What publishing does to Stripe {mode}</h2>
        {lines.length === 0 ? (
          <p>Nothing to publish — Stripe already matches this revision.</p>
        ) : (
          <ul>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        {/* Two halves of the same total, always both rendered — a plan that
            is entirely drift correction is a different thing to approve than
            one the operator asked for, and "0 intended" is the loudest
            version of that. */}
        <p>{counts.intended} intended</p>
        <p>{counts.driftCorrection} correcting drift</p>
      </div>

      {unactionable.length > 0 ? (
        <div>
          <h3>Publishing cannot fix these</h3>
          <ul>
            {unactionable.map((difference) => (
              <li key={`${difference.kind}-${difference.lookupKey}-${difference.currency ?? difference.field ?? ""}`}>
                {difference.lookupKey}: {difference.kind}
                {difference.currency ? ` (${difference.currency})` : ""}
                {difference.field ? ` (${difference.field})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Rendered here only while the dialog is CLOSED, and inside the
          dialog while it is open — the same breach list in one of two
          places, never both. Radix marks everything outside an open modal
          `aria-hidden`, so a copy left out here would be unreachable to a
          screen reader at exactly the moment it matters, and a duplicate on
          screen for everyone else. */}
      {open ? null : (
        <>
          <BreachList breaches={refused} tone="refused" />
          <BreachList breaches={confirmations} tone="confirm" />
        </>
      )}

      {done ? <p role="status">{done}</p> : null}

      {/* NOT named "publish": the dialog's own confirm button is the only
          control that publishes, and two buttons matching the same verb is
          how an operator (and a test) ends up unable to tell which one
          commits. */}
      <Button type="button" onClick={() => setOpen(true)}>
        Review changes
      </Button>

      <DestructiveConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={`Publish revision to Stripe ${mode}?`}
        description={dialogDescription({ revisionId, mode, counts, refused, confirmations })}
        confirmLabel={`Publish to ${mode}`}
        confirmId="publish-confirm-button"
        statusId={statusId}
        loading={pending}
        confirmDisabled={confirmDisabled}
        onConfirm={submit}
      >
        <BreachList breaches={refused} tone="refused" />
        <BreachList breaches={confirmations} tone="confirm" />

        <div className="mt-2">
          <Label htmlFor={typedFieldId}>
            Type the mode name <span className="font-medium">{mode}</span> to confirm (not
            case-sensitive)
          </Label>
          <Input
            id={typedFieldId}
            className="mt-1"
            value={typed}
            autoComplete="off"
            aria-describedby={statusId}
            onChange={(event) => setTyped(event.target.value)}
          />
          {/* `aria-live`, and pointed at by the confirm button's own
              `aria-describedby` (`statusId`) — the association
              `DestructiveConfirmDialog` exists to carry: it tells a
              screen-reader operator WHY the confirm button is unreachable,
              and the moment it stops being. */}
          <p id={statusId} aria-live="polite" className="mt-1 text-xs text-muted-foreground">
            {refused.length > 0
              ? "Publishing is refused for this plan. The confirm button cannot be enabled."
              : typedModeMatches(typed, mode)
                ? "Mode matches. The confirm button is enabled."
                : `Confirm button is disabled until this matches "${mode}".`}
          </p>
          {error ? (
            <Callout role="alert" variant="destructive">
              <CalloutDescription>{error}</CalloutDescription>
            </Callout>
          ) : null}
        </div>
      </DestructiveConfirmDialog>
    </section>
  );
}

/**
 * The dialog's accessible description — what a screen reader reads out when
 * the dialog opens, and the last chance to name what is about to happen.
 *
 * Names the plan (which revision, which mode, how many operations) and then
 * the reason a confirmation is being asked for, quoting the guard's own
 * thresholds rather than a second copy of "25%" — `MAGNITUDE_THRESHOLD` and
 * `BREADTH_THRESHOLD` are imported so this sentence and the rule it explains
 * can never drift apart.
 *
 * Deliberately does NOT restate the per-operation lines: they are already on
 * screen above, and `DialogDescription` is a single paragraph — repeating
 * them here would make the announcement longer than anyone listens to.
 */
function dialogDescription(params: {
  revisionId: string;
  mode: StripeMode;
  counts: PublishPlanCounts;
  refused: readonly GuardBreach[];
  confirmations: readonly GuardBreach[];
}): string {
  const { revisionId, mode, counts, refused, confirmations } = params;
  // Worded so it does not RESTATE the two origin lines on screen verbatim —
  // a screen reader that reads the page and then the dialog should hear the
  // same facts said once each, not the same sentence twice.
  const head =
    `Revision ${revisionId} to Stripe ${mode}: ${counts.total} operation(s) — ` +
    `${counts.intended} asked for by the draft, ${counts.driftCorrection} correcting Stripe drift.`;

  if (refused.length > 0) {
    return `${head} This plan is refused and cannot be published — see the reasons below.`;
  }

  const reasons: string[] = [];
  if (confirmations.some((breach) => breach.rule === "magnitude")) {
    reasons.push(`an amount moves more than ${MAGNITUDE_PERCENT} from the last published revision`);
  }
  if (confirmations.some((breach) => breach.rule === "breadth")) {
    reasons.push(`more than ${BREADTH_THRESHOLD} entries change at once`);
  }
  if (reasons.length === 0) return `${head} Existing subscribers are not repriced.`;

  return `${head} Confirmation is required because ${reasons.join(", and ")}. Existing subscribers are not repriced.`;
}
