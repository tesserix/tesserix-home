// `TONE_DOT_CLASS` and `SurfaceStateView` both come from `"use client"`
// modules, and this component is handed down from `page.tsx` — a server
// component — as an ELEMENT. The directive is what keeps those imports from
// resolving to client references this file would then call on the server;
// same load-bearing reason `observation-strip.tsx` beside it carries one, and
// the failure PR #539 shipped. `lib/server-component-web-import.guard.test.ts`
// holds the line.
"use client";

import { SurfaceStateView } from "@/components/kit/states";
import { TONE_DOT_CLASS, type SurfaceTone } from "./catalog-views";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { ModeDivergence } from "@/lib/db/plan-catalog-repo";

/**
 * Do `test` and `live` still serve the same catalog, stated as one line beside
 * the observation window.
 *
 * # It reports an ASSUMPTION, not a fault
 *
 * tesserix-home#328 skipped a week-long live-mode observation window on the
 * argument that the console serves the same catalog for both modes, so
 * mark8ly's test-mode parity evidence stands in for live. Nothing checked
 * that; `readModeDivergence` is the check, and this is where a reader learns
 * the assumption exists at all. Divergent content is a perfectly legitimate
 * state once live publishing is in use — what must not happen is reaching it
 * while other reasoning still assumes otherwise. So `diverged` is a WARNING
 * tone, never an error: nothing is broken, an argument has expired.
 *
 * # Every state names the consequence, not just the fact
 *
 * "4 differences" tells an operator nothing about what it costs them. What it
 * costs them is that mark8ly's comparison has stopped evidencing live, and
 * there are exactly two ways out — see `DIVERGED_NOTE`.
 */

export interface DivergenceSummary {
  /** Drawn from the same four-value vocabulary the day chips and the
   *  observation strip's dot use, so the two lines cannot drift apart. */
  readonly tone: SurfaceTone;
  /** The verdict phrase — the bold half of the line. */
  readonly verdict: string;
  /** The measured fact, after the em dash. */
  readonly phrase: string;
  /** What the fact means for #328's argument. Always present: an operator who
   *  reads only this line should still learn what the state costs them. */
  readonly note: string;
}

const IDENTICAL_NOTE =
  "mark8ly's test-mode parity comparison stands in for live while this holds — the assumption tesserix-home#328 skipped the live-mode observation window on.";

const DIVERGED_NOTE =
  "mark8ly's test-mode parity comparison no longer evidences live. Either point CONSOLE_CATALOG_MODE at the mode that must be evidenced, or start the live-mode observation window #328 skipped.";

/**
 * A mode with no current publication is NOT agreement.
 *
 * The wording is deliberate and the distinction is the whole reason this
 * surface has three states rather than two: there is no second catalog to
 * compare, so there is nothing to agree about. Reporting it as zero
 * differences would make an unbootstrapped mode indistinguishable from a
 * matching one — the failure mark8ly's `Result.Compared`/`Result.Differences`
 * split exists to prevent, one system over.
 */
const NOT_PUBLISHED_NOTE =
  "Nothing was compared, so this is not agreement: mark8ly's test-mode parity comparison cannot evidence a mode that serves no catalog.";

/** "test and live" reads better than a bracketed list, and a single mode is
 *  named on its own. */
function modeList(modes: readonly string[]): string {
  if (modes.length === 1) return modes[0];
  return `${modes.slice(0, -1).join(", ")} and ${modes[modes.length - 1]}`;
}

function rowWord(count: number): string {
  return count === 1 ? "row" : "rows";
}

/** "1 row differs" / "2 rows differ" — the verb agrees with the count, which
 *  a bare `rowWord` cannot do on its own. */
function rowsDiffer(count: number): string {
  return count === 1 ? "1 row differs" : `${count} rows differ`;
}

export function summarizeDivergence(divergence: ModeDivergence): DivergenceSummary {
  if (divergence.outcome === "not_published") {
    const modes = modeList(divergence.unpublishedModes);
    return {
      // Neutral, not red and not green — the same hollow-dot convention the
      // day chips use for a day nothing ran on, and for the same reason.
      tone: "neutral",
      verdict: "Not compared",
      phrase: `${modes} ${divergence.unpublishedModes.length === 1 ? "has" : "have"} no current publication`,
      note: NOT_PUBLISHED_NOTE,
    };
  }

  if (divergence.outcome === "identical") {
    return {
      tone: "success",
      verdict: "Test and live serve the same catalog",
      // The count is stated even when it is zero. Two published modes that
      // both serve nothing for this source do agree, technically — and an
      // operator reading "0 rows" learns what that agreement was made of,
      // where a bare "identical" would imply a catalog was compared.
      phrase: `${divergence.rows.test} ${rowWord(divergence.rows.test)}, identical content`,
      note: IDENTICAL_NOTE,
    };
  }

  return {
    // Warning, never error: see this module's doc comment.
    tone: "warning",
    verdict: "Test and live have diverged",
    phrase: `${rowsDiffer(divergence.differences.length)} — test serves ${divergence.rows.test}, live serves ${divergence.rows.live}`,
    note: DIVERGED_NOTE,
  };
}

export const DIVERGENCE_EMPTY_MESSAGE =
  "The catalog's two modes will be compared here once both have been published.";

export interface ModeDivergenceLineProps {
  readonly divergence: ModeDivergence | null;
  readonly divergenceState: SurfaceState;
}

export function ModeDivergenceLine({ divergence, divergenceState }: ModeDivergenceLineProps) {
  const summary =
    divergenceState.kind === "ready" && divergence !== null
      ? summarizeDivergence(divergence)
      : null;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Test and live catalog</h2>
      {summary === null ? (
        <SurfaceStateView state={divergenceState} emptyMessage={DIVERGENCE_EMPTY_MESSAGE} />
      ) : (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm">
            {/* The dot carries nothing the words do not; naming it for a
                screen reader would read the verdict twice. Same rule as the
                observation strip's. */}
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT_CLASS[summary.tone]}`}
            />
            <span className="font-medium">{summary.verdict}</span>
            {" — "}
            <span className="text-muted-foreground">{summary.phrase}</span>
          </p>
          <p className="text-sm text-muted-foreground">{summary.note}</p>
        </div>
      )}
    </div>
  );
}
