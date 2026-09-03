import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import { resolveState } from "@/components/kit/surface-state";
import type { PairLatestRun, ParityWindowDay, ParityWindowStatus } from "@/lib/db/plan-catalog-repo";
import { ObservationStrip, summarizeWindow } from "./observation-strip";

/**
 * The strip's job is one sentence, so most of this suite is about the exact
 * words in it. The distinction it must never lose is the one
 * `ParityWindowDay.ran` was added for: a day nothing ran on is not a clean
 * day, and the strip is the line an operator reads instead of the day chips.
 */

const DAYS = ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27"];

const cleanDays = (): ParityWindowDay[] => DAYS.map((day) => ({ day, clean: true, ran: true }));

/** The same seven days, with one of them replaced — a difference found, or no
 *  run recorded at all. */
function daysWithOneBad(bad: Pick<ParityWindowDay, "clean" | "ran">): ParityWindowDay[] {
  return cleanDays().map((day, i) => (i === 3 ? { day: day.day, ...bad } : day));
}

function windowOf(livePairDays: ParityWindowDay[], satisfied: boolean): ParityWindowStatus {
  return {
    days: 7,
    satisfied,
    pairs: [
      { mode: "test", source: SINGLE_SOURCE, satisfied: true, days: cleanDays() },
      { mode: "live", source: SINGLE_SOURCE, satisfied, days: livePairDays },
    ],
  };
}

const SATISFIED = windowOf(cleanDays(), true);
const WITH_A_DIRTY_DAY = windowOf(daysWithOneBad({ clean: false, ran: true }), false);
const WITH_A_GAP_DAY = windowOf(daysWithOneBad({ clean: false, ran: false }), false);

const noRuns: PairLatestRun[] = [
  { mode: "test", source: SINGLE_SOURCE, run: null },
  { mode: "live", source: SINGLE_SOURCE, run: null },
];

function renderStrip(windowStatus: ParityWindowStatus | null, over: { windowDays?: number } = {}) {
  return render(
    <ObservationStrip
      windowStatus={windowStatus}
      windowState={resolveState({
        isLoading: false,
        error: null,
        rows: windowStatus?.pairs ?? [],
        filtered: false,
      })}
      runs={noRuns}
      runsState={resolveState({ isLoading: false, error: null, rows: noRuns, filtered: false })}
      windowDays={over.windowDays ?? 7}
    />,
  );
}

/** The disclosure's accessible name IS the collapsed summary — dot, verdict
 *  word, and phrase — so every summary assertion below goes through it. */
const strip = () => screen.getByRole("button", { name: /Satisfied/ });

describe("summarizeWindow", () => {
  it("counts a day clean only when every pair was clean that day", () => {
    // #327's gate is a conjunction over (mode, source) pairs, so one pair's
    // bad day spoils the day for the window, not just for that pair.
    expect(summarizeWindow(SATISFIED, 7).phrase).toBe("7/7 days clean, both pairs");
    expect(summarizeWindow(WITH_A_DIRTY_DAY, 7).phrase).toBe(
      "6/7 days clean, 1 with differences, both pairs",
    );
  });

  it("never calls a day that never ran clean", () => {
    const summary = summarizeWindow(WITH_A_GAP_DAY, 7);
    expect(summary.phrase).toBe("6/7 days clean, 1 with no run recorded, both pairs");
    expect(summary.phrase).not.toContain("7/7");
  });

  it("tones a gap-only window neutral, not error — absence of evidence is not a failure", () => {
    expect(summarizeWindow(SATISFIED, 7).tone).toBe("success");
    expect(summarizeWindow(WITH_A_DIRTY_DAY, 7).tone).toBe("error");
    expect(summarizeWindow(WITH_A_GAP_DAY, 7).tone).toBe("neutral");
  });

  it("counts pairs rather than naming them, so a third pair needs no change here", () => {
    const threePairs: ParityWindowStatus = {
      ...SATISFIED,
      pairs: [
        ...SATISFIED.pairs,
        // Cast past the union-of-one `CatalogSource` the same way
        // `catalog-views.test.tsx` does: a second product exists in the data
        // shape before it exists in the types.
        {
          mode: "test",
          source: "acme" as ParityWindowStatus["pairs"][number]["source"],
          satisfied: true,
          days: cleanDays(),
        },
      ],
    };
    expect(summarizeWindow(threePairs, 7).phrase).toBe("7/7 days clean, all 3 pairs");
  });

  it("says so plainly when the window carries no days at all", () => {
    const empty: ParityWindowStatus = { days: 7, satisfied: false, pairs: [] };
    expect(summarizeWindow(empty, 7).phrase).toBe("no days recorded in the last 7 days");
  });
});

describe("ObservationStrip", () => {
  it("collapses a satisfied window to one line, with the window's own body hidden", () => {
    renderStrip(SATISFIED);

    expect(strip()).toHaveAccessibleName("Satisfied — 7/7 days clean, both pairs");
    expect(strip()).toHaveAttribute("aria-expanded", "false");
    // The body is still `ObservationWindow`, unchanged — just not on screen.
    expect(screen.getByText(/#327's gate is satisfied/)).not.toBeVisible();
  });

  it("expands and collapses again on click", () => {
    renderStrip(SATISFIED);

    fireEvent.click(strip());
    expect(strip()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/#327's gate is satisfied/)).toBeVisible();

    fireEvent.click(strip());
    expect(strip()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/#327's gate is satisfied/)).not.toBeVisible();
  });

  it("defaults a not-satisfied window to expanded — the one state nobody should have to click for", () => {
    renderStrip(WITH_A_DIRTY_DAY);

    const toggle = screen.getByRole("button", { name: /Not satisfied/ });
    expect(toggle).toHaveAccessibleName("Not satisfied — 6/7 days clean, 1 with differences, both pairs");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/#327's gate is not satisfied yet/)).toBeVisible();
  });

  it("distinguishes a day with no run from a day with a difference", () => {
    // The bug this line guards against is the one `ParityWindowDay.ran` was
    // added to fix, one layer up: reporting a day nothing ran on as though
    // the check had looked and been happy.
    renderStrip(WITH_A_GAP_DAY);

    expect(screen.getByRole("button", { name: /Not satisfied/ })).toHaveAccessibleName(
      "Not satisfied — 6/7 days clean, 1 with no run recorded, both pairs",
    );
  });

  it("keeps the section's heading, and keeps it out of the disclosure's name", () => {
    renderStrip(SATISFIED);
    // `page.test.tsx` finds the section by this heading; the summary line is
    // the button beside it, not the heading itself.
    expect(screen.getByRole("heading", { name: "Observation window" })).toBeInTheDocument();
    expect(strip()).toHaveAccessibleName("Satisfied — 7/7 days clean, both pairs");
  });

  it("shows the state view with no disclosure when the window read has not resolved", () => {
    // Nothing to summarize, so there is nothing to hide: an error or an empty
    // window must not sit behind a click.
    render(
      <ObservationStrip
        windowStatus={null}
        windowState={resolveState({
          isLoading: false,
          error: { message: "could not read the observation window" },
          rows: [],
          filtered: false,
        })}
        runs={noRuns}
        runsState={resolveState({ isLoading: false, error: null, rows: noRuns, filtered: false })}
        windowDays={7}
      />,
    );

    expect(screen.getByText("could not read the observation window")).toBeVisible();
    expect(screen.queryByRole("button", { name: /satisfied/i })).toBeNull();
  });
});
