import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

// `entitlement-actions.ts` reaches `parity-run.ts`, `plan-catalog-repo.ts` and
// `platform-api` — `server-only` modules one import from `pg` — through both
// controls this panel renders. Mocked for the same reason
// `observation-strip.render.test.tsx` mocks `./actions`: this suite is the
// CLIENT half, and a jsdom test has no business resolving a database driver.
// Both mocks ARE invoked — the tests below press the buttons.
const seedEntitlementsAction = vi.fn();
const runEntitlementParityAction = vi.fn();
vi.mock("./entitlement-actions", () => ({
  seedEntitlementsAction: (revisionId: string, source: string) =>
    seedEntitlementsAction(revisionId, source),
  runEntitlementParityAction: (source: string) => runEntitlementParityAction(source),
}));

import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import { resolveState } from "@/components/kit/surface-state";
import type { LatestEntitlementRun } from "@/lib/db/plan-catalog-repo";
import {
  announceParity,
  EntitlementPanel,
  summarizeSeed,
  type EntitlementPanelProps,
} from "./entitlement-panel";

/**
 * The distinctions this panel exists to keep, and every one of them is a pair
 * of states that a lazier surface would render identically:
 *
 *  - never run vs. ran clean,
 *  - no revision to seed vs. a revision holding zero rows,
 *  - a recorded `not_bootstrapped` vs. an attempt that recorded nothing,
 *  - and, across files, an entitlement outcome vs. the price observation
 *    window's verdict (`catalog-surface.render.test.tsx` holds that one).
 */

const REVISION = "3f2b0c1a-0000-4000-8000-000000000001";

const ready = (rows: readonly unknown[]) =>
  resolveState({ isLoading: false, error: null, rows: [...rows], filtered: false });

const CLEAN_RUN: LatestEntitlementRun = {
  mode: "test",
  outcome: "clean",
  ranAt: "2026-09-07T09:30:00.000Z",
  differenceCount: 0,
  differences: [],
  error: null,
};

function props(over: Partial<EntitlementPanelProps> = {}): EntitlementPanelProps {
  return {
    mode: "test",
    source: SINGLE_SOURCE,
    revisionId: REVISION,
    seeded: 104,
    seededState: ready([104]),
    lastRun: CLEAN_RUN,
    lastRunState: ready([CLEAN_RUN]),
    canManage: true,
    ...over,
  };
}

beforeEach(() => {
  seedEntitlementsAction.mockReset();
  runEntitlementParityAction.mockReset();
});

/* ------------------------------------------------------------------------ *
 * Seeded, not seeded, and nowhere to seed
 * ------------------------------------------------------------------------ */

describe("summarizeSeed", () => {
  it("states a row count when the live revision holds rows", () => {
    const summary = summarizeSeed("test", SINGLE_SOURCE, REVISION, 104);
    expect(summary.verdict).toBe("Seeded");
    expect(summary.phrase).toBe("104 Mark8ly entitlement rows on the revision live in test");
    expect(summary.tone).toBe("success");
  });

  it("says a revision holding zero rows is not seeded, in those words", () => {
    const summary = summarizeSeed("test", SINGLE_SOURCE, REVISION, 0);
    expect(summary.verdict).toBe("Not seeded");
    expect(summary.phrase).toBe("the revision live in test carries no Mark8ly entitlement rows");
    // Neutral, never red — an unseeded revision is the state this feature
    // ships in, not a fault.
    expect(summary.tone).toBe("neutral");
  });

  it("distinguishes 'no revision at all' from 'a revision with no rows'", () => {
    const noRevision = summarizeSeed("live", SINGLE_SOURCE, null, null);
    const emptyRevision = summarizeSeed("live", SINGLE_SOURCE, REVISION, 0);
    expect(noRevision.verdict).toBe("Not seeded");
    expect(noRevision.phrase).toContain("nothing is published in live");
    // The two share a verdict word and MUST NOT share a sentence: one is fixed
    // by pressing Seed, the other by publishing first.
    expect(noRevision.phrase).not.toBe(emptyRevision.phrase);
  });

  it("says 'row' for one and 'rows' for any other count", () => {
    expect(summarizeSeed("test", SINGLE_SOURCE, REVISION, 1).phrase).toContain("1 Mark8ly entitlement row on");
    expect(summarizeSeed("test", SINGLE_SOURCE, REVISION, 2).phrase).toContain("2 Mark8ly entitlement rows on");
  });
});

describe("the seeded line", () => {
  it("never lets 'Seeded' stand alone as a claim of agreement", () => {
    render(<EntitlementPanel {...props()} />);
    expect(screen.getByText(/Seeded means rows exist, not that they still match/i)).toBeInTheDocument();
  });

  it("renders the read's own failure rather than 'nothing is published'", () => {
    render(
      <EntitlementPanel
        {...props({
          seeded: null,
          seededState: resolveState({
            isLoading: false,
            error: { message: "Could not read the stored plan entitlements." },
            rows: [],
            filtered: false,
          }),
        })}
      />,
    );
    expect(screen.getByText(/Could not read the stored plan entitlements/i)).toBeInTheDocument();
    expect(screen.queryByText(/Not seeded/)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * The last run — and never having had one
 * ------------------------------------------------------------------------ */

describe("the last entitlement parity run", () => {
  it("says never run, and says it is not agreement", () => {
    render(<EntitlementPanel {...props({ lastRun: null, lastRunState: ready([null]) })} />);
    const line = screen.getByText(/Never run/);
    expect(line).toHaveTextContent("no entitlement parity run has ever been recorded");
    expect(line).toHaveTextContent("absence of evidence, not agreement");
    // The word that would flatten it into the clean case.
    expect(line).not.toHaveTextContent("Clean");
  });

  it("renders the outcome badge and the run's UTC timestamp", () => {
    render(<EntitlementPanel {...props()} />);
    expect(screen.getByText("Clean")).toBeInTheDocument();
    expect(screen.getByText("2026-09-07 09:30 UTC")).toBeInTheDocument();
  });

  it("shows a failed run's stored reason, which is all the evidence it produced", () => {
    render(
      <EntitlementPanel
        {...props({
          lastRun: {
            ...CLEAN_RUN,
            outcome: "failed",
            error: "platform-api responded 503",
          },
        })}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("platform-api responded 503")).toBeInTheDocument();
  });

  it("warns when the run was filed under a different mode than the count describes", () => {
    render(
      <EntitlementPanel {...props({ mode: "live", lastRun: { ...CLEAN_RUN, mode: "test" } })} />,
    );
    // The count above and the run below describe two different revisions;
    // without this line they read as one statement.
    expect(screen.getByText(/Recorded against test/)).toHaveTextContent(
      "The row count above is for live",
    );
  });

  it("stays silent about the mode when the two agree", () => {
    render(<EntitlementPanel {...props({ mode: "test" })} />);
    expect(screen.queryByText(/Recorded against/)).not.toBeInTheDocument();
  });

  it("says on every render that nothing here runs on its own", () => {
    // Rendered beside a CLEAN run on purpose: that is the state in which an
    // operator is most likely to assume something is watching this.
    render(<EntitlementPanel {...props()} />);
    const note = screen.getByText(/Entitlement parity runs only when someone presses the button/);
    expect(note).toHaveTextContent("there is no nightly job for it");
    expect(note).toHaveTextContent("The nightly run checks prices only");
  });
});

/* ------------------------------------------------------------------------ *
 * Five outcomes, five sentences
 * ------------------------------------------------------------------------ */

describe("announceParity", () => {
  it("gives each of the five result members its own sentence", () => {
    const messages = [
      announceParity({ ok: true, outcome: "answered", runOutcome: "clean", differences: 0 }),
      announceParity({ ok: true, outcome: "answered", runOutcome: "differences", differences: 3 }),
      announceParity({ ok: true, outcome: "answered", runOutcome: "not_bootstrapped", differences: 0 }),
      announceParity({ ok: false, outcome: "check-failed", message: "check failed message" }),
      announceParity({ ok: false, outcome: "unrecordable", message: "unrecordable message" }),
      announceParity({ ok: false, outcome: "unattributable", message: "unattributable message" }),
      announceParity({ ok: false, outcome: "not-run", message: "not-run message" }),
    ].map((announcement) => announcement.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("passes each failure's own sentence through rather than restating it", () => {
    // The four differ in where they send the operator, and the action is what
    // knows the difference — see `entitlement-actions.ts`.
    expect(announceParity({ ok: false, outcome: "unattributable", message: "go look at the product" }).message).toBe(
      "go look at the product",
    );
    expect(announceParity({ ok: false, outcome: "unrecordable", message: "try again shortly" }).message).toBe(
      "try again shortly",
    );
  });

  it("treats a recorded not_bootstrapped as neither clean nor a failure", () => {
    const announcement = announceParity({
      ok: true,
      outcome: "answered",
      runOutcome: "not_bootstrapped",
      differences: 0,
    });
    expect(announcement.message).toContain("nothing to compare");
    expect(announcement.message).toContain("seed it first");
    // Recorded, so not painted as an error...
    expect(announcement.destructive).toBe(false);
    // ...but actionable, so it interrupts.
    expect(announcement.urgent).toBe(true);
  });

  it("does not interrupt on a clean run", () => {
    const announcement = announceParity({
      ok: true,
      outcome: "answered",
      runOutcome: "clean",
      differences: 0,
    });
    expect(announcement.urgent).toBe(false);
    expect(announcement.destructive).toBe(false);
  });

  it("agrees with the count on singular and plural cells", () => {
    expect(
      announceParity({ ok: true, outcome: "answered", runOutcome: "differences", differences: 1 }).message,
    ).toContain("1 cell disagrees");
    expect(
      announceParity({ ok: true, outcome: "answered", runOutcome: "differences", differences: 4 }).message,
    ).toContain("4 cells disagree");
  });
});

/* ------------------------------------------------------------------------ *
 * The controls
 * ------------------------------------------------------------------------ */

const seedButton = () => screen.getByRole("button", { name: "Seed entitlements" });
const parityButton = () => screen.getByRole("button", { name: "Run entitlement parity" });

describe("the seed control", () => {
  it("seeds the LIVE revision this mode serves, and the source it was given", async () => {
    seedEntitlementsAction.mockResolvedValue({ ok: true });
    render(<EntitlementPanel {...props({ seeded: 0, seededState: ready([0]) })} />);

    fireEvent.click(seedButton());

    await waitFor(() => expect(seedEntitlementsAction).toHaveBeenCalledWith(REVISION, SINGLE_SOURCE));
    expect(await screen.findByText(/The revision live in test now carries Mark8ly's entitlements/)).toBeInTheDocument();
  });

  it("shows the action's own refusal wording verbatim", async () => {
    seedEntitlementsAction.mockResolvedValue({
      ok: false,
      message: "This revision already carries that product's entitlements.",
    });
    render(<EntitlementPanel {...props()} />);

    fireEvent.click(seedButton());

    expect(
      await screen.findByText("This revision already carries that product's entitlements."),
    ).toBeInTheDocument();
  });

  it("is disabled, with a reason, when the mode has nothing published", () => {
    render(
      <EntitlementPanel {...props({ revisionId: null, seeded: null, seededState: ready([null]) })} />,
    );
    expect(seedButton()).toBeDisabled();
    expect(screen.getByText(/There is nothing to seed until this mode has a published revision/)).toBeInTheDocument();
  });

  it("is disabled, with a reason, for a session without the billing capability", () => {
    render(<EntitlementPanel {...props({ canManage: false })} />);
    expect(seedButton()).toBeDisabled();
    expect(parityButton()).toBeDisabled();
    expect(screen.getAllByText(/You don't have permission to change the plan catalog/)).toHaveLength(2);
  });
});

describe("the parity control", () => {
  it("runs for the source it was given and announces the outcome", async () => {
    runEntitlementParityAction.mockResolvedValue({
      ok: true,
      outcome: "answered",
      runOutcome: "differences",
      differences: 3,
    });
    render(<EntitlementPanel {...props()} />);

    fireEvent.click(parityButton());

    await waitFor(() => expect(runEntitlementParityAction).toHaveBeenCalledWith(SINGLE_SOURCE));
    const announced = await screen.findByText(/3 cells disagree/);
    // Actionable, so it interrupts.
    expect(announced).toHaveAttribute("role", "alert");
  });

  it("announces a clean run as a status, not an alert", async () => {
    runEntitlementParityAction.mockResolvedValue({
      ok: true,
      outcome: "answered",
      runOutcome: "clean",
      differences: 0,
    });
    render(<EntitlementPanel {...props()} />);

    fireEvent.click(parityButton());

    const announced = await screen.findByText(/Recorded: clean/);
    expect(announced).toHaveAttribute("role", "status");
  });

  it("stays enabled on an unseeded revision, because not_bootstrapped is evidence", async () => {
    runEntitlementParityAction.mockResolvedValue({
      ok: true,
      outcome: "answered",
      runOutcome: "not_bootstrapped",
      differences: 0,
    });
    render(<EntitlementPanel {...props({ seeded: 0, seededState: ready([0]) })} />);

    expect(parityButton()).toBeEnabled();
    fireEvent.click(parityButton());

    expect(await screen.findByText(/nothing to compare/)).toBeInTheDocument();
  });

  it("attaches its result to the control that produced it", async () => {
    runEntitlementParityAction.mockResolvedValue({
      ok: false,
      outcome: "unattributable",
      message: "No comparison happened.",
    });
    render(<EntitlementPanel {...props()} />);

    fireEvent.click(parityButton());

    const announced = await screen.findByText("No comparison happened.");
    // A screen-reader operator hears the answer attached to the button they
    // pressed, not as a disconnected announcement elsewhere on the page.
    expect(parityButton()).toHaveAttribute("aria-describedby", announced.getAttribute("id"));
  });

  it("does not leave the previous press's answer beside a pending one", async () => {
    runEntitlementParityAction.mockResolvedValue({
      ok: false,
      outcome: "check-failed",
      message: "The check could not complete.",
    });
    render(<EntitlementPanel {...props()} />);

    fireEvent.click(parityButton());
    expect(await screen.findByText("The check could not complete.")).toBeInTheDocument();

    // The seed's outcome is a different control's; pressing parity again must
    // clear parity's own stale sentence rather than showing it under a spinner.
    let release: (value: unknown) => void = () => {};
    runEntitlementParityAction.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    fireEvent.click(parityButton());

    await waitFor(() =>
      expect(screen.queryByText("The check could not complete.")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Comparing against the plan gate/)).toBeInTheDocument();

    // Settled inside `act` rather than left dangling: a transition that
    // resolves after the test has finished re-renders an unmounted tree and
    // React reports it as an un-acted update — noise that would sit in this
    // suite's output for every future reader.
    await act(async () => {
      release({ ok: true, outcome: "answered", runOutcome: "clean", differences: 0 });
    });
    expect(await screen.findByText(/Recorded: clean/)).toBeInTheDocument();
  });
});
