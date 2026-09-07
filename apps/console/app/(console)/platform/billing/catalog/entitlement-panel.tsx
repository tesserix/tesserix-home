// `Badge` and `Button` come from `@tesserix/web`, whose barrel is "use
// client" — its exports resolve to `undefined` in a server component, which
// is what PR #539 shipped — and `useState`/`useTransition` below make this a
// client module outright anyway. The directive is load-bearing for the same
// reason `observation-strip.tsx` and `mode-divergence-line.tsx` beside it
// carry one, and `lib/server-component-web-import.guard.test.ts` holds the
// line.
"use client";

import { useId, useState, useTransition } from "react";
import { Badge, Button } from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import {
  catalogSourceLabel,
  formatRanAt,
  outcomeLabel,
  outcomeTone,
  TONE_DOT_CLASS,
  type SurfaceTone,
} from "./catalog-views";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { CatalogSource } from "@/lib/billing/source-policy";
import type { StripeMode } from "@/lib/billing/stripe-read";
// Type-only, the same discipline every client module on this surface keeps:
// `plan-catalog-repo.ts` carries `import "server-only"` and is one import from
// `pg`, so a VALUE import would drag that graph into the browser bundle —
// which `tsc` and `vitest` both pass and only `next build` catches. The two
// ACTIONS below are the exception that is safe, and the reason server actions
// are the right bridge: `"use server"` makes `./entitlement-actions` a
// reference the client calls, never a module it bundles.
import type { LatestEntitlementRun } from "@/lib/db/plan-catalog-repo";
import type { EntitlementParityResult } from "./entitlement-actions";
import { runEntitlementParityAction, seedEntitlementsAction } from "./entitlement-actions";

/**
 * The entitlement matrix's state, and the two controls that change it —
 * tesserix-home#146, T2.
 *
 * #146 shipped a table, a seed and a comparator with no caller: production
 * held zero entitlement rows and had never recorded an entitlement parity
 * run. A second copy of the plan-feature matrix that nothing ever checks is
 * worse than none, because it displays with authority. This is the surface
 * that ends that.
 *
 * # ITS OWN SECTION, NEVER A ROW INSIDE THE OBSERVATION STRIP
 *
 * Migration 0053 gave `plan_catalog_parity_runs` a `check_kind` column so the
 * two kinds of evidence in one table cannot be mistaken for each other, and
 * that separation has to hold at the surface too. The observation strip's
 * verdict — "Satisfied — 7/7 days clean, both pairs" — is #327's gate
 * evidence: the clean days it counts are what justifies revoking mark8ly's
 * Stripe write key, and every day it counts came from the nightly PRICE
 * check. Folding an entitlement outcome into that line would widen a claim
 * whose exact width is the reason it is trusted. So this is a sibling section
 * with its own heading and its own `aria-label`, and it reads the entitlement
 * half of the table through `readLatestEntitlementRun`, which filters on
 * `check_kind = 'entitlement'` for the mirror-image reason.
 *
 * # It says out loud that nothing here is automatic
 *
 * There is no nightly entitlement run and there cannot be one yet:
 * `performEntitlementParityCheck` reaches `fetchProductEntitlements` ->
 * `platformRequest` -> `resolvePlatformApiToken`, which resolves the
 * OPERATOR's Zitadel token from their session, and the CronJob has no session
 * and no machine credential in the console -> platform-api direction to mint
 * one with. Price parity runs unattended because Stripe and Postgres both
 * have machine credentials; the asymmetry is structural, not an oversight.
 * A surface that let an operator infer continuous monitoring here would be
 * lying, so {@link MANUAL_NOTE} states it on every render — including, and
 * especially, when the last recorded run was clean.
 */

/* ------------------------------------------------------------------------ *
 * Is the console seeded?
 * ------------------------------------------------------------------------ */

/**
 * Three answers, and collapsing any two of them loses something an operator
 * acts on differently:
 *
 *  - nothing published for this mode, so there is no revision that COULD hold
 *    entitlements — the seed has nowhere to write and the button is disabled;
 *  - a live revision carrying zero rows — the seed is exactly what is needed;
 *  - a live revision carrying n rows — the seed would be refused (0052's
 *    primary key, and `writeEntitlements` carries no `ON CONFLICT`).
 *
 * A bare "not seeded" for the first two would send an operator to press a
 * button that cannot help them.
 */
export interface SeedSummary {
  /** Drawn from the same four-value vocabulary the day chips, the observation
   *  strip's dot and the divergence line use, so this section's dot cannot
   *  drift from theirs. */
  readonly tone: SurfaceTone;
  /** The verdict phrase — the bold half of the line. */
  readonly verdict: string;
  /** The measured fact, after the em dash. */
  readonly phrase: string;
}

function rowWord(count: number): string {
  return count === 1 ? "row" : "rows";
}

/**
 * @param revisionId the revision currently live for `mode`, or `null` when the
 *   mode has never been published. This — not the draft — is the revision the
 *   count describes and the seed writes to, because it is the one
 *   `performEntitlementParityCheck` reads: it takes the mode off the product's
 *   response, asks `readLivePublication(mode)` for the revision, and compares
 *   `readEntitlements(publication.revisionId, source)`. Seeding a draft would
 *   leave parity reporting `not_bootstrapped` until that draft was published,
 *   with the surface cheerfully showing a row count the check cannot see.
 * @param seeded how many rows that revision holds for this source, or `null`
 *   when there is no revision to hold any.
 */
export function summarizeSeed(
  mode: StripeMode,
  source: CatalogSource,
  revisionId: string | null,
  seeded: number | null,
): SeedSummary {
  const product = catalogSourceLabel(source);

  if (revisionId === null || seeded === null) {
    return {
      // Neutral, not red: an unpublished mode is not a fault, it is the
      // ordinary state of `live` most days. Same hollow-dot convention the
      // day chips use for a day nothing ran on.
      tone: "neutral",
      verdict: "Not seeded",
      phrase: `nothing is published in ${mode}, so there is no live revision to hold ${product}'s entitlements`,
    };
  }

  if (seeded === 0) {
    return {
      tone: "neutral",
      verdict: "Not seeded",
      phrase: `the revision live in ${mode} carries no ${product} entitlement rows`,
    };
  }

  return {
    tone: "success",
    verdict: "Seeded",
    phrase: `${seeded} ${product} entitlement ${rowWord(seeded)} on the revision live in ${mode}`,
  };
}

/**
 * The boundary the verdict word does not carry.
 *
 * "Seeded" is read as "correct". What it says is that rows exist — they were
 * copied off the product's own matrix at some point in the past, and nothing
 * since has compared them to what the gate enforces today. That comparison is
 * the other control on this section, and a green dot beside an unchecked
 * matrix is exactly the authority-without-evidence #146 exists to remove.
 */
const SEED_NOTE =
  "Seeded means rows exist, not that they still match what the plan gate enforces — only a parity run says that.";

/**
 * Stated on every render, including when the last run was clean.
 *
 * A clean run is the state in which an operator is most likely to assume
 * something is watching this, and nothing is. See this module's header for
 * why nothing can be, yet.
 */
const MANUAL_NOTE =
  "Entitlement parity runs only when someone presses the button — there is no nightly job for it. The nightly run checks prices only, so this line does not change on its own.";

/** Never having run is not a clean run, and this sentence is the only thing
 *  standing between those two readings on a page where every other status
 *  line is green. */
const NEVER_RUN_MESSAGE =
  "Never run — no entitlement parity run has ever been recorded. That is the absence of evidence, not agreement.";

/* ------------------------------------------------------------------------ *
 * What a press produced
 * ------------------------------------------------------------------------ */

/**
 * One sentence per outcome, and the five members of
 * {@link EntitlementParityResult} are five sentences rather than "it worked" /
 * "it didn't".
 *
 * `urgent` decides `role="alert"` over `role="status"`, and `destructive`
 * decides the colour. They are separate because the two questions are:
 * `differences` and `not_bootstrapped` are RECORDED facts that an operator
 * must act on (so they interrupt) but are not failures of the check (so they
 * are not painted as errors) — the same distinction `draft-editor.tsx` draws
 * between a warning and a save failure. Only `clean` is neither.
 */
export interface ParityAnnouncement {
  readonly message: string;
  readonly urgent: boolean;
  readonly destructive: boolean;
}

export function announceParity(result: EntitlementParityResult): ParityAnnouncement {
  if (result.ok) {
    switch (result.runOutcome) {
      case "clean":
        return {
          message: "Recorded: clean. Every cell the console stores matches what the plan gate enforces.",
          urgent: false,
          destructive: false,
        };
      case "differences":
        return {
          message: `Recorded: ${result.differences} ${
            result.differences === 1 ? "cell disagrees" : "cells disagree"
          } with what the plan gate enforces. The run is summarised above.`,
          urgent: true,
          destructive: false,
        };
      case "not_bootstrapped":
        // Deliberately not "clean" and deliberately not an error: a row was
        // written, and what it records is that there was nothing to compare.
        // The remedy is the OTHER button, so the sentence names it.
        return {
          message:
            "Recorded: nothing to compare. The revision live for the mode the product reads carries no entitlements — seed it first.",
          urgent: true,
          destructive: false,
        };
    }
  }

  // The four ways a press produced no usable answer. Each already carries its
  // own sentence from `entitlement-actions.ts` — written there because the
  // difference between "the check failed", "the row did not land", "no
  // comparison happened" and "nothing was attempted" is the action's to know,
  // and each sends the operator somewhere different. Restating them here
  // would give one fact two authors.
  return { message: result.message, urgent: true, destructive: true };
}

/* ------------------------------------------------------------------------ *
 * The last recorded run
 * ------------------------------------------------------------------------ */

function LastRun({
  run,
  mode,
  source,
}: {
  run: LatestEntitlementRun | null;
  mode: StripeMode;
  source: CatalogSource;
}) {
  if (run === null) {
    return <p className="text-sm text-muted-foreground">{NEVER_RUN_MESSAGE}</p>;
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={outcomeTone(run.outcome)}>{outcomeLabel(run.outcome)}</Badge>
        <span className="text-muted-foreground">{formatRanAt(run.ranAt)}</span>
        {run.outcome === "differences" ? (
          <span className="text-muted-foreground">
            {run.differenceCount} cell{run.differenceCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {/*
        The mode a run was FILED under is the mode the product reported
        reading, never the one the mode toggle is showing — the console cannot
        see mark8ly's `CONSOLE_CATALOG_MODE` and it moves at the Stripe
        live-key swap. When the two differ, the seeded count above and this
        run describe two different revisions, and an operator reading them as
        one line would conclude the check had looked at rows it never saw.
        Silent when they agree, because then there is nothing to warn about.
      */}
      {run.mode !== mode ? (
        <p className="text-xs text-muted-foreground">
          {`Recorded against ${run.mode} — the mode ${catalogSourceLabel(source)} reported reading. The row count above is for ${mode}.`}
        </p>
      ) : null}
      {/*
        The stored reason, which for a `failed` run is the ENTIRE evidence it
        produced: no comparison happened, so there are no differences to list.
        Rendered verbatim because `parity-run.ts` has already redacted keys
        and truncated it; `break-words` because nothing there breaks up a long
        unspaced token. Both halves of the condition are checked rather than
        just the outcome, for the reason `LatestRunSummary` gives: a "Reason:"
        label with nothing after it reads as detail lost in transit.
      */}
      {run.outcome === "failed" && run.error !== null ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Reason: </span>
          <span className="break-words font-mono">{run.error}</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The two controls
 * ------------------------------------------------------------------------ */

/** Shown in place of an outcome when the session cannot act. Mirrors what
 *  both actions check server-side (`billing`, through
 *  `checkOperatorCapabilityLive`) rather than being a second rule. */
const NO_PERMISSION_NOTE = "You don't have permission to change the plan catalog.";

/** Why the seed is disabled when the mode has nothing published — the button
 *  alone would leave an operator clicking at a control that cannot work. */
const NOTHING_TO_SEED_NOTE =
  "There is nothing to seed until this mode has a published revision.";

/**
 * A control, its pending sentence and its outcome sentence.
 *
 * Both controls need the identical three-part behaviour the observation
 * strip's re-run control established — a live region that is always mounted
 * (one added to the DOM at the same moment its text arrives is not reliably
 * announced), a `role` that switches with the outcome, and the button's own
 * `aria-describedby` pointing at it so a screen-reader operator hears the
 * result attached to the control they pressed. Two copies of that would drift;
 * the DIFFERENCE between the two controls is which action runs and what its
 * result is called, which is what the props carry.
 */
function ActionControl({
  label,
  pendingMessage,
  disabled,
  disabledNote,
  run,
}: {
  label: string;
  pendingMessage: string;
  disabled: boolean;
  disabledNote: string | null;
  run: () => Promise<ParityAnnouncement>;
}) {
  const [pending, startTransition] = useTransition();
  const [announcement, setAnnouncement] = useState<ParityAnnouncement | null>(null);
  const statusId = useId();

  const shown = pending
    ? // Pending reads as a status, never an alert: a run in flight is
      // progress, not a problem.
      { message: pendingMessage, urgent: false, destructive: false }
    : (announcement ?? (disabledNote ? { message: disabledNote, urgent: false, destructive: false } : null));

  const press = () => {
    // Cleared on press rather than left behind: the previous press's answer is
    // not this one's, and a stale sentence beside a spinner is worse than no
    // sentence.
    setAnnouncement(null);
    startTransition(async () => {
      setAnnouncement(await run());
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled || pending}
        aria-describedby={statusId}
        onClick={press}
      >
        {label}
      </Button>
      <span
        id={statusId}
        role={shown?.urgent ? "alert" : "status"}
        aria-live="polite"
        className={`text-xs ${shown?.destructive ? "text-destructive" : "text-muted-foreground"}`}
      >
        {shown?.message}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------------ */

export const ENTITLEMENTS_EMPTY_MESSAGE =
  "The console's stored entitlements will be summarised here once this mode has a published revision.";

export interface EntitlementPanelProps {
  /** The mode the toggle is showing, and the mode {@link revisionId} and
   *  {@link seeded} were read for. NOT necessarily the mode a run is filed
   *  under — see `LastRun`. */
  readonly mode: StripeMode;
  readonly source: CatalogSource;
  /** The revision live for `mode`, or `null` when the mode has never been
   *  published. The seed writes here; see {@link summarizeSeed} for why this
   *  and not the draft. */
  readonly revisionId: string | null;
  /** Rows on that revision for this source — `null` when there is no revision
   *  to count, which is a different fact from `0` and is stated as one. */
  readonly seeded: number | null;
  readonly seededState: SurfaceState;
  readonly lastRun: LatestEntitlementRun | null;
  readonly lastRunState: SurfaceState;
  /** Whether this session holds `billing`. Read-only mirroring of what both
   *  actions re-check for themselves — the same discipline `AuthoringPanel`'s
   *  `canDraft` keeps, and for the same reason: the UI must not be stricter or
   *  laxer than the server it describes. */
  readonly canManage: boolean;
}

export function EntitlementPanel({
  mode,
  source,
  revisionId,
  seeded,
  seededState,
  lastRun,
  lastRunState,
  canManage,
}: EntitlementPanelProps) {
  const summary =
    seededState.kind === "ready" ? summarizeSeed(mode, source, revisionId, seeded) : null;

  const product = catalogSourceLabel(source);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Entitlements</h2>

      {summary === null ? (
        <SurfaceStateView state={seededState} emptyMessage={ENTITLEMENTS_EMPTY_MESSAGE} />
      ) : (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm">
            {/* The dot carries nothing the words do not; naming it for a
                screen reader would read the verdict twice. Same rule as the
                observation strip's and the divergence line's. */}
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT_CLASS[summary.tone]}`}
            />
            <span className="font-medium">{summary.verdict}</span>
            {/* A bare text node, not a third styled span — a leading space
                inside a span is dropped when the accessible name is built, and
                the line would announce as "Seeded— 104 rows". */}
            {" — "}
            <span className="text-muted-foreground">{summary.phrase}</span>
          </p>
          <p className="text-sm text-muted-foreground">{SEED_NOTE}</p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Last entitlement parity run</h3>
        {lastRunState.kind === "ready" ? (
          <LastRun run={lastRun} mode={mode} source={source} />
        ) : (
          <SurfaceStateView state={lastRunState} emptyMessage={NEVER_RUN_MESSAGE} />
        )}
        <p className="text-sm text-muted-foreground">{MANUAL_NOTE}</p>
      </div>

      <div className="flex flex-wrap gap-6">
        <ActionControl
          label="Seed entitlements"
          pendingMessage={`Reading ${product}'s matrix…`}
          disabled={!canManage || revisionId === null}
          disabledNote={
            !canManage ? NO_PERMISSION_NOTE : revisionId === null ? NOTHING_TO_SEED_NOTE : null
          }
          run={async () => {
            // `revisionId` cannot be null here — the button is disabled — but
            // the action takes a string and a non-null assertion would be a
            // claim this component cannot make if the disabled condition ever
            // moves.
            if (revisionId === null) {
              return { message: NOTHING_TO_SEED_NOTE, urgent: false, destructive: false };
            }
            const result = await seedEntitlementsAction(revisionId, source);
            return result.ok
              ? {
                  // Says what it WROTE and where, not "success": the operator
                  // chose neither the revision nor the values, so a bare
                  // confirmation would leave them unable to say what changed.
                  message: `Seeded. The revision live in ${mode} now carries ${product}'s entitlements as the plan gate reports them.`,
                  urgent: false,
                  destructive: false,
                }
              : { message: result.message, urgent: true, destructive: true };
          }}
        />
        <ActionControl
          label="Run entitlement parity"
          pendingMessage="Comparing against the plan gate…"
          disabled={!canManage}
          disabledNote={canManage ? null : NO_PERMISSION_NOTE}
          // Never gated on whether the revision is seeded. An unseeded one
          // records `not_bootstrapped`, which is evidence that the check ran
          // and found nothing to compare — and refusing to let it run would
          // leave that fact unrecorded, which is the absence a missing row
          // already reads as.
          run={async () => announceParity(await runEntitlementParityAction(source))}
        />
      </div>
    </div>
  );
}
