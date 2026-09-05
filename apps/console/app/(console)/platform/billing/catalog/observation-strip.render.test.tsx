import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `actions.ts` reaches `parity-run.ts` and `publish-repo.ts` — both
// `server-only`, both one import from `pg` and `stripe` — through the re-run
// action this strip now calls. Mocked for the same reason
// `draft-editor.render.test.tsx` mocks it: this suite is the CLIENT half, and
// a jsdom test has no business resolving a database driver. Unlike that
// suite's mock, this one IS invoked — the re-run tests below press the
// button.
const rerunParityCheckAction = vi.fn();
vi.mock("./actions", () => ({
  rerunParityCheckAction: () => rerunParityCheckAction(),
}));

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

/** Extracted from `renderStrip` so the mode-switch test can `rerender` the
 *  same component with a different window — which is exactly what a `?mode=`
 *  navigation does to this subtree. */
function stripElement(windowStatus: ParityWindowStatus | null, windowDays = 7) {
  return (
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
      windowDays={windowDays}
    />
  );
}

function renderStrip(windowStatus: ParityWindowStatus | null, over: { windowDays?: number } = {}) {
  return render(stripElement(windowStatus, over.windowDays ?? 7));
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

  /**
   * `ModeToggle` is a `next/link` to `?mode=` — a SOFT navigation to the same
   * route, so `page.tsx` re-renders with new search params and React
   * reconciles this component at the same position, keeping its `useState`.
   * A `useState` initialiser seeds once and never again, so without a re-sync
   * the strip an operator collapsed over a satisfied test window stays
   * collapsed over a live window that is not satisfied — hiding the one state
   * this component exists to put in front of them.
   */
  describe("when the window changes under it — a `?mode=` switch", () => {
    it("re-expands when a satisfied window is replaced by a not-satisfied one", () => {
      const { rerender } = renderStrip(SATISFIED);
      expect(strip()).toHaveAttribute("aria-expanded", "false");

      rerender(stripElement(WITH_A_DIRTY_DAY));

      expect(screen.getByRole("button", { name: /Not satisfied/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("re-collapses when a not-satisfied window is replaced by a satisfied one", () => {
      const { rerender } = renderStrip(WITH_A_DIRTY_DAY);
      expect(screen.getByRole("button", { name: /Not satisfied/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      rerender(stripElement(SATISFIED));

      expect(strip()).toHaveAttribute("aria-expanded", "false");
    });

    it("does not fight a click: a collapsed not-satisfied window stays collapsed across a re-render", () => {
      // The re-sync must key on the VERDICT changing, not run on every
      // render — otherwise it reverses the operator mid-read.
      const { rerender } = renderStrip(WITH_A_DIRTY_DAY);
      fireEvent.click(screen.getByRole("button", { name: /Not satisfied/ }));
      expect(screen.getByRole("button", { name: /Not satisfied/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      // A different not-satisfied window (the other mode's, say) — same
      // verdict, so the operator's own choice stands.
      rerender(stripElement(WITH_A_GAP_DAY));

      expect(screen.getByRole("button", { name: /Not satisfied/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("does not re-collapse a satisfied window an operator opened", () => {
      const { rerender } = renderStrip(SATISFIED);
      fireEvent.click(strip());
      expect(strip()).toHaveAttribute("aria-expanded", "true");

      rerender(stripElement(SATISFIED));

      expect(strip()).toHaveAttribute("aria-expanded", "true");
    });
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

/**
 * The re-run control (#580 T3).
 *
 * The failure this exists to answer: a red window whose only recourse was to
 * wait for the nightly CronJob. It sits in the HEADER row, beside the
 * disclosure, deliberately — an operator whose window is red must be able to
 * act on it without first hunting inside a collapsed body.
 */
describe("the re-run control", () => {
  const rerun = () => screen.getByRole("button", { name: "Re-run parity check" });

  beforeEach(() => {
    rerunParityCheckAction.mockReset();
    rerunParityCheckAction.mockResolvedValue({ ok: true, outcome: "answered", pairs: 2 });
  });

  it("renders beside the heading, not inside the disclosure body", () => {
    renderStrip(SATISFIED);

    // Visible while the window is COLLAPSED — the state most operators
    // arrive in, and the one the body is hidden in.
    expect(strip()).toHaveAttribute("aria-expanded", "false");
    expect(rerun()).toBeVisible();
    expect(rerun()).toBeEnabled();
  });

  it("renders even when there is no summary to disclose", () => {
    // A window read that failed is a window an operator most wants to retry.
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

    expect(rerun()).toBeVisible();
  });

  it("disables itself while the run is in flight, and says so", async () => {
    // A parity run reads two Stripe accounts; without this an operator with
    // no feedback presses it again and starts a second one.
    let release: (value: unknown) => void = () => {};
    rerunParityCheckAction.mockReturnValue(new Promise((resolve) => (release = resolve)));

    renderStrip(SATISFIED);
    fireEvent.click(rerun());

    await waitFor(() => expect(rerun()).toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent(/Re-running/);

    release({ ok: true, outcome: "answered", pairs: 2 });
    await waitFor(() => expect(rerun()).toBeEnabled());
  });

  it("announces a run that answered", async () => {
    renderStrip(SATISFIED);

    fireEvent.click(rerun());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("2 pairs checked"),
    );
  });

  it("announces a run that did not answer, in its own words", async () => {
    // The defect this whole issue is about, one layer up: a failed re-run
    // that looks identical to a successful one.
    rerunParityCheckAction.mockResolvedValue({
      ok: false,
      outcome: "check-failed",
      pairs: 2,
      failed: 1,
      message: "The check could not complete for 1 of 2 pairs.",
    });

    renderStrip(WITH_A_DIRTY_DAY);

    fireEvent.click(rerun());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The check could not complete for 1 of 2 pairs.",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces a refusal the operator can read", async () => {
    rerunParityCheckAction.mockResolvedValue({
      ok: false,
      outcome: "not-run",
      message: "You don't have permission to edit the plan catalog.",
    });

    renderStrip(SATISFIED);

    fireEvent.click(rerun());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/don't have permission/),
    );
  });

  it("names its status region from the button, so a screen reader hears the outcome", async () => {
    renderStrip(SATISFIED);
    const describedBy = rerun().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    fireEvent.click(rerun());

    await waitFor(() => {
      const region = document.getElementById(describedBy as string);
      expect(region).toHaveTextContent("2 pairs checked");
      expect(region).toHaveAttribute("aria-live", "polite");
    });
  });
});
