import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { resolveState } from "@/components/kit/surface-state";
import type { ModeDivergence } from "@/lib/db/plan-catalog-repo";
import {
  ModeDivergenceLine,
  summarizeDivergence,
  DIVERGENCE_EMPTY_MESSAGE,
} from "./mode-divergence-line";

/**
 * This surface is one line, so most of this suite is about the exact words in
 * it — and about the one distinction it must never lose: a mode with no
 * current publication is NOT the two modes agreeing.
 *
 * `readModeDivergence` makes that structural (`not_published` carries no
 * difference count at all), and these assertions are the second half of the
 * same guarantee: even if the shapes were flattened, the copy an operator
 * reads must still say "nothing was compared" rather than "they match".
 */

const IDENTICAL: ModeDivergence = { outcome: "identical", rows: { test: 78, live: 78 } };

const DIVERGED: ModeDivergence = {
  outcome: "diverged",
  rows: { test: 78, live: 77 },
  differences: [
    {
      mode: "test",
      lookupKey: "mark8ly_pro_monthly_v1",
      plan: "pro",
      period: "monthly",
      tier: "developed",
      currency: "usd",
      unitAmountMinor: 2900,
      taxBehavior: "exclusive",
    },
  ],
};

const LIVE_UNPUBLISHED: ModeDivergence = {
  outcome: "not_published",
  unpublishedModes: ["live"],
};

const NEITHER_PUBLISHED: ModeDivergence = {
  outcome: "not_published",
  unpublishedModes: ["test", "live"],
};

function renderLine(divergence: ModeDivergence | null) {
  return render(
    <ModeDivergenceLine
      divergence={divergence}
      divergenceState={resolveState({
        isLoading: false,
        error: null,
        rows: divergence ? [divergence] : [],
        filtered: false,
      })}
    />,
  );
}

describe("summarizeDivergence", () => {
  it("states the assumption, not a green tick, when the modes agree", () => {
    const summary = summarizeDivergence(IDENTICAL);
    expect(summary.tone).toBe("success");
    expect(summary.verdict).toBe("Test and live serve the same catalog");
    expect(summary.phrase).toBe("78 rows, identical content");
    // The value of the agreeing case is that a reader learns the assumption
    // exists and is currently holding — not that something is green.
    expect(summary.note).toContain("stands in for live while this holds");
    expect(summary.note).toContain("#328");
  });

  it("names the consequence, not just the count, when they diverge", () => {
    const summary = summarizeDivergence(DIVERGED);
    // A warning, never an error: divergent content is a legitimate state once
    // live publishing is in use. What has expired is an argument.
    expect(summary.tone).toBe("warning");
    expect(summary.phrase).toBe("1 row differs — test serves 78, live serves 77");
    expect(summary.note).toContain("no longer evidences live");
    expect(summary.note).toContain("CONSOLE_CATALOG_MODE");
    expect(summary.note).toContain("live-mode observation window");
  });

  it("reads a mode with no publication as NOT compared, never as agreement", () => {
    const summary = summarizeDivergence(LIVE_UNPUBLISHED);
    expect(summary.verdict).toBe("Not compared");
    expect(summary.phrase).toBe("live has no current publication");
    expect(summary.note).toContain("this is not agreement");
    // Neither green nor red — the same hollow-dot convention a day nothing ran
    // on gets on the observation strip.
    expect(summary.tone).toBe("neutral");
    // The words that would be wrong here, stated as an assertion rather than
    // left to a reviewer's eye.
    expect(summary.verdict).not.toMatch(/same catalog|agree/i);
    expect(summary.phrase).not.toMatch(/identical|0 rows/i);
  });

  it("names every unpublished mode, and agrees with itself about the verb", () => {
    expect(summarizeDivergence(NEITHER_PUBLISHED).phrase).toBe(
      "test and live have no current publication",
    );
  });
});

describe("ModeDivergenceLine", () => {
  it("renders the verdict and the consequence together", () => {
    renderLine(DIVERGED);
    expect(screen.getByText("Test and live have diverged")).toBeInTheDocument();
    expect(screen.getByText(/no longer evidences live/)).toBeInTheDocument();
  });

  it("renders the not-compared line without any claim of agreement", () => {
    renderLine(LIVE_UNPUBLISHED);
    expect(screen.getByText("Not compared")).toBeInTheDocument();
    expect(screen.getByText(/this is not agreement/)).toBeInTheDocument();
    expect(screen.queryByText(/serve the same catalog/)).toBeNull();
  });

  it("falls back to the surface state when the read failed", () => {
    render(
      <ModeDivergenceLine
        divergence={null}
        divergenceState={resolveState({
          isLoading: false,
          error: { message: "the comparison could not be read" },
          rows: [],
          filtered: false,
        })}
      />,
    );
    // No verdict at all rather than a default one: a failed read must not
    // resolve to either "they agree" or "they diverged".
    expect(screen.queryByText(/serve the same catalog/)).toBeNull();
    expect(screen.queryByText("Test and live have diverged")).toBeNull();
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });

  it("has an empty message that promises a comparison rather than agreement", () => {
    expect(DIVERGENCE_EMPTY_MESSAGE).toContain("compared");
    expect(DIVERGENCE_EMPTY_MESSAGE).not.toMatch(/identical|agree/i);
  });
});
