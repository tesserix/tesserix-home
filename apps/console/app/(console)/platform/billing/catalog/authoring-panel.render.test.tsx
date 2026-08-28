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
  beforeEach(() => {
    vi.clearAllMocks();
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
