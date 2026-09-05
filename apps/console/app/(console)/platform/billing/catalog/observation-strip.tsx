// `useState`/`useId` below make this a client component outright; the
// directive is also what keeps `ObservationWindow`'s `@tesserix/web` `Badge`
// from resolving to `undefined` when this subtree is rendered — the same
// barrel-is-"use client" hazard `surface-tabs.tsx` and `page-header.tsx`
// carry this comment for, and the one PR #539 shipped without.
"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@tesserix/web";
import {
  dayVerdict,
  ObservationWindow,
  TONE_DOT_CLASS,
  type DayVerdict,
  type SurfaceTone,
} from "./catalog-views";
import type { SurfaceState } from "@/components/kit/surface-state";
// Type-only, deliberately: `plan-catalog-repo.ts` is `server-only` and one
// import from `pg`, and a VALUE import of either shape from here would drag
// that graph into the browser bundle — which `tsc` and `vitest` both pass and
// only `next build` catches (`publish-view.tsx` carries the identical note).
// The re-run ACTION below is the exception that is safe, and the reason
// server actions are the right bridge: `"use server"` makes `./actions` a
// reference the client calls, never a module it bundles.
import type { PairLatestRun, ParityWindowStatus } from "@/lib/db/plan-catalog-repo";
import { rerunParityCheckAction } from "./actions";

/**
 * The observation window, collapsed to one line.
 *
 * `ObservationWindow` renders a card per (mode, source) pair — a day strip and
 * a latest-run summary each — and it was the first thing on
 * `/platform/billing/catalog`, above the published catalog and the authoring
 * panel. An operator arriving to publish a price scrolled past all of it every
 * time. This wraps that component unchanged as the expanded body of a
 * disclosure, and puts the one sentence they actually need on the line above.
 *
 * The body stays MOUNTED and is hidden with the `hidden` attribute rather than
 * unmounted. `ObservationWindow` is pure presentation over props the page has
 * already resolved (see `page.tsx`'s four independent reads), so there is
 * nothing to re-fetch on expand and nothing to lose by keeping it in the tree;
 * unmounting would only cost a re-render and leave `aria-controls` pointing at
 * an element that is not there while collapsed.
 */

/* ------------------------------------------------------------------------ *
 * The one-line summary
 * ------------------------------------------------------------------------ */

/**
 * A day's verdict ACROSS every pair, which is not the same question
 * `dayVerdict` answers for one pair's day.
 *
 * #327's gate is a conjunction over pairs (see `readWindowStatus`), so the
 * strip counts a day as clean only when every pair was clean that day, and
 * reports the worst thing that happened otherwise. `dirty` outranks `gap`
 * because a recorded difference is a fact and a missing run is only an
 * absence — saying "1 day with no run recorded" about a day that also carried
 * a real difference would understate what the window found.
 */
const VERDICT_SEVERITY: Record<DayVerdict, number> = { clean: 0, gap: 1, dirty: 2 };

function worstOf(a: DayVerdict, b: DayVerdict): DayVerdict {
  return VERDICT_SEVERITY[b] > VERDICT_SEVERITY[a] ? b : a;
}

export interface WindowSummary {
  /** Restated from `ParityWindowStatus.satisfied` rather than re-derived: the
   *  gate's answer belongs to the query that computes it, and a second
   *  implementation here could disagree with the badge inside the card. */
  readonly satisfied: boolean;
  /** Drawn from the same four-value vocabulary `outcomeTone` and the day chips
   *  use, so the dot on this line and the chips below it cannot drift. */
  readonly tone: SurfaceTone;
  /** "Satisfied" / "Not satisfied" — the verdict word. */
  readonly verdict: string;
  /** "7/7 days clean, both pairs" — everything after the verdict word. */
  readonly phrase: string;
}

/** "both pairs" reads better than "all 2 pairs" and is what the approved
 *  prototype's line says; anything else is stated as a count so a third
 *  (mode, source) pair needs no change here. */
function pairPhrase(pairCount: number): string {
  if (pairCount === 1) return "1 pair";
  if (pairCount === 2) return "both pairs";
  return `all ${pairCount} pairs`;
}

export function summarizeWindow(status: ParityWindowStatus, windowDays: number): WindowSummary {
  const worstByDay = new Map<string, DayVerdict>();
  for (const pair of status.pairs) {
    for (const day of pair.days) {
      const verdict = dayVerdict(day);
      const seen = worstByDay.get(day.day);
      worstByDay.set(day.day, seen === undefined ? verdict : worstOf(seen, verdict));
    }
  }

  const verdicts = [...worstByDay.values()];
  const total = verdicts.length;
  const clean = verdicts.filter((v) => v === "clean").length;
  const dirty = verdicts.filter((v) => v === "dirty").length;
  const gap = verdicts.filter((v) => v === "gap").length;

  const verdict = status.satisfied ? "Satisfied" : "Not satisfied";
  // A gap-only window is NOT an error, and must not be dressed as one: no run
  // recorded is the absence of evidence, which is why the day chips render a
  // gap hollow rather than red. The dot follows the same rule.
  const tone: SurfaceTone = status.satisfied ? "success" : dirty > 0 ? "error" : "neutral";

  if (total === 0) {
    return {
      satisfied: status.satisfied,
      tone,
      verdict,
      phrase: `no days recorded in the last ${windowDays} days`,
    };
  }

  const parts = [`${clean}/${total} days clean`];
  if (dirty > 0) parts.push(`${dirty} with differences`);
  // Deliberately not "not clean": the whole reason `ParityWindowDay.ran`
  // exists is that a day nothing ran on is neither clean nor dirty, and the
  // strip is the one line most operators will read.
  if (gap > 0) parts.push(`${gap} with no run recorded`);
  parts.push(pairPhrase(status.pairs.length));

  return { satisfied: status.satisfied, tone, verdict, phrase: parts.join(", ") };
}

/* ------------------------------------------------------------------------ *
 * The re-run control
 * ------------------------------------------------------------------------ */

/**
 * Run the parity check now.
 *
 * # Why it lives in the header row
 *
 * A red window is the state this control exists for, and the strip's header
 * is the line an operator reads first — often the only line, since a
 * satisfied window is collapsed. Putting the control inside the disclosure
 * body would mean an operator whose window has gone red has to open a
 * disclosure to find out they can do anything about it, which is the same
 * class of defect as the reason being stored and never shown.
 *
 * # The outcome is announced, not implied
 *
 * A failed re-run that looks identical to a successful one leaves the
 * operator with a red window and no idea whether they just learned anything.
 * So the action's four outcomes each get their own sentence, and the two that
 * mean "the check did not answer" are `role="alert"` rather than
 * `role="status"` — the distinction `draft-editor.tsx` already draws between
 * a warning and a save failure.
 *
 * The region is pointed at by the button's own `aria-describedby`, the same
 * association `publish-view.tsx`'s typed-mode status carries: a screen-reader
 * operator hears the result attached to the control they pressed rather than
 * as a disconnected announcement somewhere on the page.
 */
function RerunControl() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const statusId = useId();

  const message = pending ? "Re-running the parity check…" : status?.message;
  // Pending reads as a status, never an alert: a run in flight is progress,
  // not a problem.
  const tone = pending ? "ok" : status?.tone;

  const run = () => {
    // Cleared on press rather than left behind: the previous run's answer is
    // not this run's, and a stale sentence beside a spinner is worse than no
    // sentence.
    setStatus(null);
    startTransition(async () => {
      const result = await rerunParityCheckAction();
      setStatus(
        result.ok
          ? {
              tone: "ok",
              message: `Parity check re-run: ${result.pairs} ${
                result.pairs === 1 ? "pair" : "pairs"
              } checked.`,
            }
          : { tone: "error", message: result.message },
      );
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-describedby={statusId}
        onClick={run}
      >
        Re-run parity check
      </Button>
      {/* Always mounted, and empty until there is something to say: a live
          region added to the DOM at the same moment its text arrives is not
          reliably announced. `role` switches with the outcome, which is what
          decides whether a screen reader interrupts. */}
      <span
        id={statusId}
        role={tone === "error" ? "alert" : "status"}
        aria-live="polite"
        className={`text-xs ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {message}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------------ */

export interface ObservationStripProps {
  windowStatus: ParityWindowStatus | null;
  windowState: SurfaceState;
  runs: readonly PairLatestRun[];
  runsState: SurfaceState;
  windowDays: number;
}

export function ObservationStrip({
  windowStatus,
  windowState,
  runs,
  runsState,
  windowDays,
}: ObservationStripProps) {
  const summary =
    windowState.kind === "ready" && windowStatus !== null
      ? summarizeWindow(windowStatus, windowDays)
      : null;

  // Collapsed by default, expanded when the gate is NOT satisfied — the one
  // state an operator must not have to click to see. Also expanded when there
  // is no summary at all, because the body is then a loading/error/empty state
  // view, which says nothing useful from behind a disclosure.
  const defaultExpanded = summary === null || !summary.satisfied;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();

  // Same re-sync as `SurfaceTabs`, for the same class of failure: local state
  // seeded once from props that then move out from under it.
  //
  // `ModeToggle` is a `next/link` to `?mode=` — a SOFT navigation to the same
  // route — so the page re-renders with a different mode's window and React
  // reconciles this component at the same position, keeping the `useState`
  // above. Without this, an operator on a satisfied `test` window who switches
  // to a `live` window that is NOT satisfied gets the strip still collapsed:
  // precisely the state the default exists to reveal, hidden by the default's
  // own staleness.
  //
  // Keyed on the VERDICT, not on every render and not on the window object,
  // so it re-asserts only when the answer actually flips. An operator who
  // collapses a not-satisfied window keeps it collapsed while they read it,
  // and one who opens a satisfied window is not shut again by an unrelated
  // re-render.
  const [syncedVerdict, setSyncedVerdict] = useState(summary?.satisfied ?? null);
  const currentVerdict = summary?.satisfied ?? null;
  useEffect(() => {
    if (syncedVerdict === currentVerdict) return;
    setSyncedVerdict(currentVerdict);
    setExpanded(currentVerdict !== true);
  }, [currentVerdict, syncedVerdict]);

  const body = (
    <ObservationWindow
      windowStatus={windowStatus}
      windowState={windowState}
      runs={runs}
      runsState={runsState}
      windowDays={windowDays}
    />
  );

  // No summary to state, so no disclosure to hide it behind.
  if (summary === null) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium">Observation window</h2>
          <RerunControl />
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium">Observation window</h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
          className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-secondary/50"
        >
          {/* The dot carries no information the words do not; naming it for a
              screen reader would read the verdict twice. */}
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT_CLASS[summary.tone]}`}
          />
          <span className="font-medium">{summary.verdict}</span>
          {/* A bare text node, not a third styled span. The accessible name is
              built by concatenating each ELEMENT child's own trimmed text with
              no separator between them, so a leading space inside a span is
              dropped and the line announces as "Satisfied— 7/7 days clean";
              whitespace in a text node survives. Verified in this component's
              own `toHaveAccessibleName` assertions. */}
          {" — "}
          <span className="text-muted-foreground">{summary.phrase}</span>
          <span aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        <RerunControl />
      </div>
      <div id={bodyId} hidden={!expanded}>
        {body}
      </div>
    </div>
  );
}
