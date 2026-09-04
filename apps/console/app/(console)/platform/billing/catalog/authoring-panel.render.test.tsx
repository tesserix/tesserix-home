import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

// `./actions` reaches `publish-repo.ts` / `plan-catalog-repo.ts` /
// `stripe-read.ts` (all `server-only`, one of them `stripe`) — mocked so
// this render suite exercises the CLIENT composition only, the same
// discipline `publish-view.render.test.tsx` and
// `draft-editor.render.test.tsx` already apply to the identical module.
const startDraftAction = vi.fn();
const discardDraftAction = vi.fn();
const planPublishAction = vi.fn();
const publishAction = vi.fn();
const setAmountAction = vi.fn();

vi.mock("./actions", () => ({
  startDraftAction: (...args: unknown[]) => startDraftAction(...args),
  discardDraftAction: (...args: unknown[]) => discardDraftAction(...args),
  planPublishAction: (...args: unknown[]) => planPublishAction(...args),
  publishAction: (...args: unknown[]) => publishAction(...args),
  setAmountAction: (...args: unknown[]) => setAmountAction(...args),
}));

import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import { AuthoringPanel, buildDraftEditorRows } from "./authoring-panel";

/**
 * The Critical this suite exists to guard, per the controller's own review:
 * `authoring-panel.tsx` shipped as a 400+-line composition root with NO
 * test file at all, which is exactly how a successful publish silently
 * failing to render its own outcome got past a fully green 2413-test suite.
 * Everything below is new coverage, not a refactor of existing tests.
 */

const READY: SurfaceState = { kind: "ready" };
const EMPTY: SurfaceState = resolveState({ isLoading: false, error: null, rows: [], filtered: false });

const PUBLISHED_ROW: CatalogRow = {
  lookupKey: "mark8ly_pro_monthly_developed_v1",
  plan: "pro",
  period: "monthly",
  tier: "developed",
  source: "mark8ly",
  currency: "usd",
  unitAmountMinor: 4900,
  taxBehavior: "exclusive",
};

const DRAFT_ROW: CatalogRow = { ...PUBLISHED_ROW, unitAmountMinor: 5900 };

const READY_PLAN = {
  revisionId: "draft-1",
  mode: "test" as const,
  counts: {
    create_product: 0,
    create_price: 0,
    replace_price: 1,
    add_currency_option: 0,
    update_tax_behavior: 0,
    archive_price: 0,
    total: 1,
    intended: 1,
    driftCorrection: 0,
    unactionable: 0,
  },
  unactionable: [],
  verdict: { ok: true as const },
};

function baseProps() {
  return {
    mode: "test" as const,
    catalog: [PUBLISHED_ROW],
    catalogState: READY,
    draftState: READY,
    draftId: "draft-1",
    draftRows: [DRAFT_ROW],
    draftRowsState: READY,
    canDraft: true,
    canPublish: true,
    replanHref: "/platform/billing/catalog?mode=test",
  };
}

async function reviewAndConfirm(mode = "test") {
  fireEvent.click(await screen.findByRole("button", { name: /review changes/i }));
  fireEvent.change(screen.getByLabelText(/type the mode name/i), { target: { value: mode } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`publish to ${mode}`, "i") }));
  });
}

describe("AuthoringPanel — the publish outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The Critical itself. Before the fix, `AuthoringPanel` rendered the
  // outcome section INSIDE the same draft-dependent branch that returns
  // early once `draftId` is `null` — and a SUCCEEDED publish promotes the
  // revision, which is exactly what makes `draftId` become `null` on the
  // very next render. This test simulates that: publish, then re-render
  // with the props a post-promotion `revalidatePath` would hand back
  // (`draftId: null`), and assert the outcome survives.
  it("keeps showing a succeeded publish's outcome even after the draft disappears from the next render", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
    publishAction.mockResolvedValue({
      ok: true,
      attemptId: "attempt-1",
      outcome: "succeeded",
      promoted: true,
      failedOperations: [],
      operations: [
        { sequence: 1, kind: "replace_price", lookupKey: "mark8ly_pro_monthly_developed_v1", status: "succeeded", error: null },
      ],
      orphans: [],
    });

    const { rerender } = render(<AuthoringPanel {...baseProps()} />);
    await reviewAndConfirm();

    const heading = await screen.findByText("Publish attempt attempt-1");
    expect(within(heading.closest("section")!).getByText(/stripe now matches this revision/i)).toBeInTheDocument();

    // The re-render a real page load performs once `promotePublication` has
    // run: the draft is gone, so `page.tsx` hands back `draftId: null`.
    rerender(<AuthoringPanel {...baseProps()} draftId={null} draftRows={null} draftRowsState={EMPTY} />);

    // The regression: this must still be on screen. Against the
    // pre-fix ordering (outcome block nested inside the draft-dependent
    // return), this assertion fails — `AuthoringPanel` takes the
    // `draftId === null` early return and never reaches the outcome block.
    expect(screen.getByText("Publish attempt attempt-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a draft/i })).toBeInTheDocument();
  });

  it("renders the outcome for a failed publish too", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
    publishAction.mockResolvedValue({
      ok: true,
      attemptId: "attempt-2",
      outcome: "failed",
      promoted: false,
      failedOperations: ["archive_price mark8ly_pro_annual_ppp_v1"],
      operations: [
        { sequence: 1, kind: "archive_price", lookupKey: "mark8ly_pro_annual_ppp_v1", status: "failed", error: "card_declined" },
      ],
      orphans: [{ priceId: "price_stale", lookupKey: null, source: "mark8ly" }],
    });

    render(<AuthoringPanel {...baseProps()} />);
    await reviewAndConfirm();

    const outcomeSection = (await screen.findByText("Publish attempt attempt-2")).closest("section")!;
    expect(within(outcomeSection).getByText(/1 operation\(s\) failed/i)).toBeInTheDocument();
    expect(within(outcomeSection).getByText(/orphaned stripe prices/i)).toBeInTheDocument();
  });
});

describe("AuthoringPanel — publish control gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("withholds the publish control, visibly and with a reason, without publish-catalog", () => {
    render(<AuthoringPanel {...baseProps()} canPublish={false} />);

    expect(screen.queryByRole("button", { name: /review changes/i })).toBeNull();
    expect(planPublishAction).not.toHaveBeenCalled();
    expect(screen.getByText(/publishing is withheld here/i)).toBeInTheDocument();
    expect(screen.getByText(/publish-catalog capability/i)).toBeInTheDocument();
  });

  it("fetches and shows the plan when publish-catalog is held", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });

    render(<AuthoringPanel {...baseProps()} canPublish />);

    expect(await screen.findByRole("button", { name: /review changes/i })).toBeInTheDocument();
    expect(planPublishAction).toHaveBeenCalledWith("draft-1", "test");
  });
});

describe("AuthoringPanel — a failed catalog read does not silently disable the magnitude warning", () => {
  // Both tests below mount with `canPublish` on, so the panel's plan effect
  // calls `planPublishAction` and awaits its promise. The return value is
  // established here rather than being inherited from whichever earlier test
  // happened to set it — otherwise these two only pass in file order, and a
  // wiped mock surfaces as `Cannot read properties of undefined (reading
  // 'then')` inside `authoring-panel.tsx` rather than as a test problem
  // (#550). The plan itself is incidental to what these tests assert.
  beforeEach(() => {
    vi.clearAllMocks();
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
  });

  it("says the comparison baseline is unavailable, rather than silently treating every amount as unchanged", () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        catalogState={{ kind: "error", message: "connection reset" }}
      />,
    );

    expect(screen.getByText(/published catalog could not be read/i)).toBeInTheDocument();
    // The editor itself still mounts — a failed READ-ONLY catalog read is
    // not a reason to block editing outright, only to say the guard is
    // running blind this render.
    expect(screen.getByText(/existing subscribers stay on the price/i)).toBeInTheDocument();
  });

  it("says nothing extra when the catalog read succeeded (including the ordinary not-yet-bootstrapped empty case)", () => {
    render(<AuthoringPanel {...baseProps()} catalog={[]} catalogState={EMPTY} />);

    expect(screen.queryByText(/published catalog could not be read/i)).toBeNull();
  });
});

describe("buildDraftEditorRows", () => {
  it("groups a draft's flat (price x currency) rows into one row per lookup key", () => {
    const draftRows: CatalogRow[] = [
      { ...PUBLISHED_ROW, currency: "usd", unitAmountMinor: 5900 },
      { ...PUBLISHED_ROW, currency: "eur", unitAmountMinor: 5400 },
    ];
    const publishedRows: CatalogRow[] = [
      { ...PUBLISHED_ROW, currency: "usd", unitAmountMinor: 4900 },
      // No `eur` published yet — a brand-new currency in the draft.
    ];

    const rows = buildDraftEditorRows(draftRows, publishedRows);

    expect(rows).toHaveLength(1);
    expect(rows[0].lookupKey).toBe(PUBLISHED_ROW.lookupKey);
    expect(rows[0].plan).toBe(PUBLISHED_ROW.plan);
    expect(rows[0].period).toBe(PUBLISHED_ROW.period);
    expect(rows[0].tier).toBe(PUBLISHED_ROW.tier);
    expect(rows[0].amounts).toEqual([
      { currency: "usd", draftUnitAmountMinor: 5900, publishedUnitAmountMinor: 4900, taxBehavior: "exclusive" },
      { currency: "eur", draftUnitAmountMinor: 5400, publishedUnitAmountMinor: null, taxBehavior: "exclusive" },
    ]);
  });

  it("never guesses a baseline currency — always null", () => {
    const rows = buildDraftEditorRows([PUBLISHED_ROW], [PUBLISHED_ROW]);
    expect(rows[0].baselineCurrency).toBeNull();
  });

  it("preserves the draft rows' own first-seen order across lookup keys", () => {
    const second: CatalogRow = { ...PUBLISHED_ROW, lookupKey: "mark8ly_pro_annual_developed_v1", period: "annual" };
    const rows = buildDraftEditorRows([second, PUBLISHED_ROW], []);
    expect(rows.map((r) => r.lookupKey)).toEqual([second.lookupKey, PUBLISHED_ROW.lookupKey]);
  });
});

/**
 * tesserix-home#410's half of this suite: everything above needs a session
 * `publishAction` result to put an outcome on screen, which is exactly the
 * state that does not survive a reload. These mount the panel cold, with
 * only the props `page.tsx` reads back out of the database, and assert the
 * operator still learns what happened.
 */
describe("AuthoringPanel — the outcome that survives a reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planPublishAction.mockResolvedValue({ ok: true, plan: READY_PLAN });
  });

  const PERSISTED_FAILURE = {
    attemptId: "attempt-9",
    outcome: "failed" as const,
    promoted: false,
    operations: [
      {
        sequence: 1,
        kind: "archive_price",
        lookupKey: "mark8ly_pro_annual_ppp_v1",
        status: "failed" as const,
        error: "rate_limit",
      },
    ],
  };

  it("renders a persisted failed outcome on a cold mount, with no session publish at all", () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={PERSISTED_FAILURE}
        attemptState={READY}
        operationsState={READY}
        orphans={[]}
        orphansState={EMPTY}
      />,
    );

    expect(publishAction).not.toHaveBeenCalled();
    const section = screen.getByText("Publish attempt attempt-9").closest("section")!;
    expect(within(section).getByText(/1 operation\(s\) failed/i)).toBeInTheDocument();
    expect(within(section).getByText("archive_price")).toBeInTheDocument();
  });

  it("lets the session outcome win over the persisted one", async () => {
    publishAction.mockResolvedValue({
      ok: true,
      attemptId: "attempt-10",
      outcome: "succeeded",
      promoted: true,
      failedOperations: [],
      operations: [
        { sequence: 1, kind: "replace_price", lookupKey: "mark8ly_pro_monthly_developed_v1", status: "succeeded", error: null },
      ],
      orphans: [],
    });

    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={PERSISTED_FAILURE}
        attemptState={READY}
        operationsState={READY}
        orphans={[]}
        orphansState={EMPTY}
      />,
    );

    expect(screen.getByText("Publish attempt attempt-9")).toBeInTheDocument();
    await reviewAndConfirm();

    expect(await screen.findByText("Publish attempt attempt-10")).toBeInTheDocument();
    expect(screen.queryByText("Publish attempt attempt-9")).toBeNull();
  });

  it("surfaces orphans even when there is no attempt to attach them to", () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={null}
        attemptState={EMPTY}
        operationsState={EMPTY}
        orphans={[{ priceId: "price_stranded", lookupKey: null, source: "mark8ly" }]}
        orphansState={READY}
      />,
    );

    expect(screen.getByText(/orphaned stripe prices/i)).toBeInTheDocument();
    expect(screen.getByText(/price_stranded/)).toBeInTheDocument();
    // No attempt means no attempt heading, no operations table and no
    // re-plan control — there is nothing to re-plan.
    expect(screen.queryByText(/^Publish attempt /)).toBeNull();
    expect(screen.queryByRole("link", { name: /re-plan/i })).toBeNull();
  });

  it("renders no outcome section at all when there is neither a persisted attempt nor an orphan", () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={null}
        attemptState={EMPTY}
        operationsState={EMPTY}
        orphans={[]}
        orphansState={EMPTY}
      />,
    );

    expect(screen.queryByText(/latest publish attempt/i)).toBeNull();
    expect(screen.queryByText(/orphaned stripe prices/i)).toBeNull();
  });

  it("says the orphan check is unavailable rather than rendering a page that looks clean", () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={null}
        attemptState={EMPTY}
        operationsState={EMPTY}
        orphans={[]}
        orphansState={{ kind: "error", message: "stripe timed out" }}
      />,
    );

    expect(screen.getByText(/stripe timed out/i)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * The sticky publish rail
 * ------------------------------------------------------------------------ */

/**
 * The split: the draft editor on the left, the publish rail on the right,
 * stuck in view while the editor scrolls.
 *
 * The rail is `PublishSection` exactly as it was — `PublishView`, its typed
 * mode gate, its guard verdict and its refusal path are moved, not rewritten,
 * so what this suite asserts about them is where they RENDER. What publishing
 * DOES is `publish-view.render.test.tsx`'s and `actions.test.ts`' subject and
 * is deliberately not restated here.
 */

/** Type into a `SearchFilterInput` and flush its debounce — blur commits
 *  immediately. Same helper `catalog-search.test.tsx` uses, for the same
 *  reason: it keeps this suite off fake timers. */
function searchDraft(text: string) {
  const input = screen.getByLabelText(/search the draft/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

const rail = () => screen.getByRole("region", { name: "Publish" });

/** Every operation kind at once, so `operationLines` emits all five of its
 *  lines and this suite is asserting the real function's output rather than
 *  one lucky branch of it. */
const EVERY_KIND_PLAN = {
  ...READY_PLAN,
  counts: {
    create_product: 1,
    create_price: 2,
    replace_price: 3,
    add_currency_option: 1,
    update_tax_behavior: 1,
    archive_price: 4,
    total: 12,
    intended: 5,
    driftCorrection: 7,
    unactionable: 0,
  },
};

describe("AuthoringPanel — the publish rail's contents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the operation lines, by kind and in execution order, inside the rail", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
    render(<AuthoringPanel {...baseProps()} />);

    // Awaited on the rail itself: the plan arrives over `planPublishAction`,
    // so nothing below is on screen until it resolves.
    expect(await screen.findByText(/1 Stripe Product created/)).toBeInTheDocument();

    const lines = within(rail())
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");

    // The vocabulary is `operationLines`' own, per OPERATION KIND — not an
    // invented pair of counts. `add_currency_option` and
    // `update_tax_behavior` are one line ("updated in place"), which is why
    // 1 + 1 reads as 2.
    expect(lines).toEqual([
      "1 Stripe Product created",
      "2 created — a Price that does not exist in Stripe yet",
      "2 updated in place — the existing Price object is kept",
      expect.stringContaining("3 replaced"),
      expect.stringContaining("4 archived"),
    ]);
  });

  it("keeps the publish action itself in the rail, and only there", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
    render(<AuthoringPanel {...baseProps()} />);

    const review = await screen.findByRole("button", { name: /review changes/i });
    // Exactly one, never a narrow-viewport duplicate: a second copy is how a
    // surface ends up with two controls matching the same verb and an
    // operator unable to tell which one commits.
    expect(screen.getAllByRole("button", { name: /review changes/i })).toHaveLength(1);
    expect(rail().contains(review)).toBe(true);
  });

  it("keeps PublishView's typed-mode gate intact in its new position", async () => {
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
    render(<AuthoringPanel {...baseProps()} />);

    fireEvent.click(await screen.findByRole("button", { name: /review changes/i }));
    const confirm = screen.getByRole("button", { name: /publish to test/i });

    // Disabled until the mode is typed — the gate, unchanged by the move.
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type the mode name/i), { target: { value: "test" } });
    expect(screen.getByRole("button", { name: /publish to test/i })).toBeEnabled();
    expect(publishAction).not.toHaveBeenCalled();
  });
});

describe("AuthoringPanel — the split, and publishing at every width", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
  });

  it("sticks the rail within the panel rather than to the viewport", async () => {
    render(<AuthoringPanel {...baseProps()} />);
    await screen.findByRole("button", { name: /review changes/i });

    const railClasses = rail().className.split(/\s+/);
    // `sticky`, never `fixed`: the console layout wraps every page in a fixed
    // sidebar and a `sticky top-0 z-20` header, and a `fixed` rail would be
    // positioned against the viewport and sit on top of both.
    expect(railClasses).toContain("lg:sticky");
    expect(railClasses).not.toContain("fixed");
    // The console header is `h-14` (3.5rem) — this is that plus a 1rem gap,
    // so the rail parks clear of it rather than under it.
    expect(railClasses).toContain("lg:top-[4.5rem]");

    const grid = rail().parentElement!;
    expect(grid.className).toContain("lg:grid-cols-3");
    // Not decoration: a stretched grid item is already its container's height
    // and a sticky box with no room to travel simply sits still.
    expect(grid.className).toContain("lg:items-start");
  });

  it("leaves the rail an ordinary stacked block below the breakpoint, so publishing stays reachable narrow", async () => {
    render(<AuthoringPanel {...baseProps()} />);
    await screen.findByRole("button", { name: /review changes/i });

    const railClasses = rail().className.split(/\s+/);
    // Never hidden at any width, and every breakpoint-scoped class it carries
    // is `lg:`-prefixed — so below `lg` the rail is a plain block under the
    // editor, the same single DOM subtree, and the publish control it holds
    // is on screen at every width rather than behind a media query.
    expect(railClasses).not.toContain("hidden");
    expect(railClasses.filter((cls) => cls.includes(":")).every((cls) => cls.startsWith("lg:"))).toBe(
      true,
    );
    expect(rail().parentElement!.className.split(/\s+/)).not.toContain("hidden");
  });
});

describe("AuthoringPanel — what must not be inside a column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
  });

  const PERSISTED_FAILURE_FOR_SPLIT = {
    attemptId: "attempt-rail",
    outcome: "failed" as const,
    promoted: false,
    operations: [
      {
        sequence: 1,
        kind: "archive_price",
        lookupKey: "mark8ly_pro_annual_ppp_v1",
        status: "failed" as const,
        error: "rate_limit",
      },
    ],
  };

  /** True when `earlier` comes before `later` in document order. */
  function precedes(earlier: Element, later: Element): boolean {
    return Boolean(
      earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }

  it("puts the live-mode warning above the split, full width, not in the rail", async () => {
    render(<AuthoringPanel {...baseProps()} mode="live" />);
    await screen.findByRole("button", { name: /review changes/i });

    const warning = screen.getByText(/this is the live stripe account/i);
    const grid = rail().parentElement!;
    expect(grid.contains(warning)).toBe(false);
    expect(precedes(warning, grid)).toBe(true);
  });

  it("says nothing about live on the test mode", async () => {
    render(<AuthoringPanel {...baseProps()} />);
    await screen.findByRole("button", { name: /review changes/i });

    expect(screen.queryByText(/this is the live stripe account/i)).toBeNull();
  });

  it("puts the failed-attempt alert above the split, full width, not in the rail", async () => {
    render(
      <AuthoringPanel
        {...baseProps()}
        persistedOutcome={PERSISTED_FAILURE_FOR_SPLIT}
        attemptState={READY}
        operationsState={READY}
        orphans={[]}
        orphansState={EMPTY}
      />,
    );
    await screen.findByRole("button", { name: /review changes/i });

    const outcome = screen.getByRole("region", { name: "Publish outcome" });
    const grid = rail().parentElement!;
    expect(grid.contains(outcome)).toBe(false);
    // An operator must not have to scroll a 42-row editor past to learn that
    // a publish failed.
    expect(precedes(outcome, grid)).toBe(true);
  });
});

/** Four changed rows across three lookup keys, so a search on one plan hides
 *  changed rows the rail's plan still counts. */
const SPLIT_PUBLISHED: readonly CatalogRow[] = [
  PUBLISHED_ROW,
  { ...PUBLISHED_ROW, lookupKey: "mark8ly_starter_monthly_developed_v1", plan: "starter", unitAmountMinor: 1900 },
  { ...PUBLISHED_ROW, lookupKey: "mark8ly_studio_annual_ppp_inr_v1", plan: "studio", currency: "inr", unitAmountMinor: 1200000 },
];

const SPLIT_DRAFT: readonly CatalogRow[] = SPLIT_PUBLISHED.map((row) => ({
  ...row,
  unitAmountMinor: row.unitAmountMinor + 100,
}));

describe("AuthoringPanel — a search narrows the editor and nothing else", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planPublishAction.mockResolvedValue({ ok: true, plan: EVERY_KIND_PLAN });
  });

  it("leaves the rail byte-for-byte unchanged by a search that hides changed rows", async () => {
    render(
      <AuthoringPanel {...baseProps()} catalog={SPLIT_PUBLISHED} draftRows={SPLIT_DRAFT} />,
    );
    await screen.findByRole("button", { name: /review changes/i });

    const before = rail().innerHTML;
    expect(screen.getAllByText(/^mark8ly_[a-z0-9_]+_v1$/)).toHaveLength(3);

    searchDraft("starter");

    // The editor narrowed…
    expect(screen.getAllByText(/^mark8ly_[a-z0-9_]+_v1$/)).toHaveLength(1);
    // …and the rail did not. The rail describes the WHOLE revision: a hidden
    // changed row is still a changed row and still publishes, so a search
    // that quietly shrank what the rail says it will do would let an operator
    // publish edits they believe are not there. Same invariant
    // `catalog-search.test.tsx` holds over the Draft tab's badge.
    expect(rail().innerHTML).toBe(before);
    expect(planPublishAction).toHaveBeenCalledTimes(1);
  });
});
