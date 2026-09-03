import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// `AuthoringPanel` reaches `./actions`, which imports `publish-repo.ts` /
// `plan-catalog-repo.ts` / `stripe-read.ts` (all `server-only`) — mocked here
// the same way `authoring-panel.render.test.tsx` mocks it, so this suite
// exercises the client composition only.
vi.mock("./actions", () => ({
  startDraftAction: vi.fn(),
  discardDraftAction: vi.fn(),
  planPublishAction: vi.fn(),
  publishAction: vi.fn(),
  setAmountAction: vi.fn(),
}));

import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import { AuthoringPanel } from "./authoring-panel";
import { CatalogSurface } from "./catalog-surface";
import { CatalogViews } from "./catalog-views";
import {
  filterCatalogRowsBySearch,
  filterDraftEditorRowsBySearch,
  matchesCatalogSearch,
} from "./catalog-search";

/**
 * Search across the 42 lookup keys.
 *
 * The load-bearing assertion in this file is the last describe block: a search
 * hides rows and must not move a single count. An operator who searches, reads
 * "2 changed" and publishes believing that is the whole change set is the
 * worst outcome this screen can produce, and it is a bug that would look
 * entirely correct on screen.
 */

const READY: SurfaceState = { kind: "ready" };

const row = (over: Partial<CatalogRow>): CatalogRow => ({
  lookupKey: "mark8ly_pro_monthly_developed_v1",
  plan: "pro",
  period: "monthly",
  tier: "developed",
  source: SINGLE_SOURCE,
  currency: "usd",
  unitAmountMinor: 4900,
  taxBehavior: "exclusive",
  ...over,
});

/** One `developed` price carrying two currencies, plus a second plan and a
 *  third plan whose only currency is INR — enough for every match axis. */
const PRO_USD = row({});
const PRO_INR = row({ currency: "inr", unitAmountMinor: 399000 });
const STARTER_USD = row({
  lookupKey: "mark8ly_starter_monthly_developed_v1",
  plan: "starter",
  unitAmountMinor: 1900,
});
const STUDIO_INR = row({
  lookupKey: "mark8ly_studio_annual_ppp_inr_v1",
  plan: "studio",
  period: "annual",
  tier: "ppp",
  currency: "inr",
  unitAmountMinor: 1200000,
});

const CATALOG = [PRO_USD, PRO_INR, STARTER_USD, STUDIO_INR];

const ready = (rows: readonly unknown[]) =>
  resolveState({ isLoading: false, error: null, rows: [...rows], filtered: false });

/** Type into a `SearchFilterInput` and flush its debounce — blur commits
 *  immediately, which is what the kit component promises and what keeps this
 *  suite off fake timers. */
function search(label: RegExp | string, text: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

/** The editor's own lookup-key labels — anchored so the per-cell input labels
 *  ("<key> usd amount"), which begin the same way, are not counted as rows. */
const draftKeys = () =>
  screen.queryAllByText(/^mark8ly_[a-z0-9_]+_v1$/).map((el) => el.textContent);

const planTabNames = () =>
  within(screen.getByRole("tablist", { name: "Plan catalog, by plan" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

function renderBrowse() {
  return render(
    <CatalogViews
      mode="test"
      catalog={CATALOG}
      catalogState={READY}
      publication={{
        id: "pub-1",
        revisionId: "rev-1",
        publishedBy: "ops@tesserix.dev",
        publishedAt: "2026-09-01T10:00:00.000Z",
      }}
      publicationState={ready([1])}
    />,
  );
}

/* ------------------------------------------------------------------------ *
 * The matcher
 * ------------------------------------------------------------------------ */

describe("matchesCatalogSearch", () => {
  const entry = {
    lookupKey: "mark8ly_pro_monthly_developed_v1",
    plan: "pro",
    currencies: ["usd", "inr"],
  };

  it("matches a substring of the lookup key", () => {
    expect(matchesCatalogSearch(entry, "monthly_developed")).toBe(true);
  });

  it("matches the plan", () => {
    expect(matchesCatalogSearch(entry, "pro")).toBe(true);
  });

  it("matches any one of the price's currencies", () => {
    expect(matchesCatalogSearch(entry, "inr")).toBe(true);
  });

  it("matches nothing outside those three fields", () => {
    // `period` and `tier` are not searched — the brief names lookup key, plan
    // and currency, and every lookup key already carries the period and tier
    // in its own text.
    expect(matchesCatalogSearch(entry, "exclusive")).toBe(false);
  });

  it("treats an empty or blank query as no filter at all", () => {
    expect(matchesCatalogSearch(entry, "")).toBe(true);
  });
});

describe("filterCatalogRowsBySearch", () => {
  it("keeps every row of a price one of whose currencies matched", () => {
    // Not just the INR row: dropping the USD row would leave `DevelopedCard`
    // captioning a two-currency Price "One price, 1 currency".
    expect(filterCatalogRowsBySearch(CATALOG, "inr")).toEqual([PRO_USD, PRO_INR, STUDIO_INR]);
  });

  it("is case-insensitive on all three fields", () => {
    expect(filterCatalogRowsBySearch(CATALOG, "STARTER")).toEqual([STARTER_USD]);
    expect(filterCatalogRowsBySearch(CATALOG, "MARK8LY_STUDIO")).toEqual([STUDIO_INR]);
    expect(filterCatalogRowsBySearch(CATALOG, "INR")).toEqual([PRO_USD, PRO_INR, STUDIO_INR]);
  });

  it("returns the rows untouched for a blank query", () => {
    expect(filterCatalogRowsBySearch(CATALOG, "   ")).toBe(CATALOG);
  });
});

describe("filterDraftEditorRowsBySearch", () => {
  const rows = [
    { lookupKey: "a_pro_v1", plan: "pro", period: "monthly", tier: "developed", baselineCurrency: null, amounts: [{ currency: "usd", draftUnitAmountMinor: 1, publishedUnitAmountMinor: 1, taxBehavior: "exclusive" as const }] },
    { lookupKey: "b_starter_v1", plan: "starter", period: "monthly", tier: "ppp", baselineCurrency: null, amounts: [{ currency: "idr", draftUnitAmountMinor: 2, publishedUnitAmountMinor: 2, taxBehavior: "exclusive" as const }] },
  ];

  it("filters by lookup key, plan and currency alike", () => {
    expect(filterDraftEditorRowsBySearch(rows, "b_starter").map((r) => r.lookupKey)).toEqual(["b_starter_v1"]);
    expect(filterDraftEditorRowsBySearch(rows, "PRO").map((r) => r.lookupKey)).toEqual(["a_pro_v1"]);
    expect(filterDraftEditorRowsBySearch(rows, "idr").map((r) => r.lookupKey)).toEqual(["b_starter_v1"]);
  });
});

/* ------------------------------------------------------------------------ *
 * Browse
 * ------------------------------------------------------------------------ */

describe("Browse — searching the published catalog", () => {
  it("shows every plan before anything is searched", () => {
    renderBrowse();
    expect(planTabNames()).toEqual(["Pro", "Starter", "Studio"]);
  });

  it("narrows to one plan on a lookup-key match", () => {
    renderBrowse();
    search(/search the published catalog/i, "studio_annual_ppp");
    expect(planTabNames()).toEqual(["Studio"]);
  });

  it("narrows to one plan on a plan match", () => {
    renderBrowse();
    search(/search the published catalog/i, "starter");
    expect(planTabNames()).toEqual(["Starter"]);
  });

  it("narrows on a currency match, keeping the matched price's other currencies", () => {
    renderBrowse();
    search(/search the published catalog/i, "inr");

    expect(planTabNames()).toEqual(["Pro", "Studio"]);
    // Pro is the active tab: its developed card still reports BOTH currencies,
    // because the search narrowed which prices are listed and not what a
    // listed price is made of.
    expect(screen.getByText("One price, 2 currencies")).toBeInTheDocument();
  });

  it("matches a currency case-insensitively", () => {
    renderBrowse();
    search(/search the published catalog/i, "INR");
    expect(planTabNames()).toEqual(["Pro", "Studio"]);
  });

  it("names what was searched when nothing matches, and clears back to everything", () => {
    renderBrowse();
    search(/search the published catalog/i, "mark8ly_enterprise");

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByText(/mark8ly_enterprise/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Plan catalog, by plan" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(planTabNames()).toEqual(["Pro", "Starter", "Studio"]);
  });

  it("leaves the publication attribution alone — a search is not a fact about who published", () => {
    renderBrowse();
    search(/search the published catalog/i, "mark8ly_enterprise");

    expect(screen.getByText("ops@tesserix.dev")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Draft & Publish
 * ------------------------------------------------------------------------ */

/** Three changed rows across three plans, so a search on one plan hides two
 *  changed rows — the shape the count invariant below needs. */
const DRAFT_ROWS: readonly CatalogRow[] = [
  { ...PRO_USD, unitAmountMinor: 5900 },
  { ...PRO_INR, unitAmountMinor: 499000 },
  { ...STARTER_USD, unitAmountMinor: 2900 },
  { ...STUDIO_INR, unitAmountMinor: 1400000 },
];

function authoringProps() {
  return {
    mode: "test" as const,
    catalog: CATALOG,
    catalogState: READY,
    draftState: READY,
    draftId: "draft-1",
    draftRows: DRAFT_ROWS,
    draftRowsState: READY,
    canDraft: true,
    // False on purpose: the publish plan is fetched over an action this suite
    // has mocked to `undefined`, and publishing is not what is under test.
    canPublish: false,
    replanHref: "/platform/billing/catalog?mode=test",
  };
}

describe("Draft & Publish — searching the draft", () => {
  it("narrows the editor's rows by lookup key, plan and currency", () => {
    render(<AuthoringPanel {...authoringProps()} />);
    expect(draftKeys()).toHaveLength(3);

    search(/search the draft/i, "starter");
    expect(draftKeys()).toEqual([
      "mark8ly_starter_monthly_developed_v1",
    ]);

    search(/search the draft/i, "studio_annual");
    expect(draftKeys()).toEqual([
      "mark8ly_studio_annual_ppp_inr_v1",
    ]);

    // The Pro price carries both usd and inr, so an `inr` search keeps it
    // alongside the Studio row.
    search(/search the draft/i, "INR");
    expect(draftKeys()).toEqual([
      "mark8ly_pro_monthly_developed_v1",
      "mark8ly_studio_annual_ppp_inr_v1",
    ]);
  });

  it("names what was searched when nothing matches", () => {
    render(<AuthoringPanel {...authoringProps()} />);
    search(/search the draft/i, "mark8ly_enterprise");

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByText(/mark8ly_enterprise/)).toBeInTheDocument();
    expect(draftKeys()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(draftKeys()).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------ *
 * The two searches are separate
 * ------------------------------------------------------------------------ */

describe("the two panels' searches are independent", () => {
  it("does not let a Browse search reach the draft editor, or the reverse", () => {
    // Rendered side by side rather than through `SurfaceTabs`, deliberately:
    // `TabsContent` unmounts the inactive panel, so a tabbed version of this
    // test would pass even if the two shared one piece of state.
    render(
      <>
        <CatalogViews
          mode="test"
          catalog={CATALOG}
          catalogState={READY}
          publication={null}
          publicationState={ready([])}
        />
        <AuthoringPanel {...authoringProps()} />
      </>,
    );

    search(/search the published catalog/i, "starter");
    expect(planTabNames()).toEqual(["Starter"]);
    // The draft editor still lists all three prices.
    expect(draftKeys()).toHaveLength(3);

    search(/search the draft/i, "studio");
    expect(draftKeys()).toEqual([
      "mark8ly_studio_annual_ppp_inr_v1",
    ]);
    // And Browse is still on its own, unrelated term.
    expect(planTabNames()).toEqual(["Starter"]);
  });
});

/* ------------------------------------------------------------------------ *
 * The invariant: a search never changes a count
 * ------------------------------------------------------------------------ */

describe("a search never changes a count", () => {
  it("leaves the Draft tab's changed-row count at the unfiltered number", () => {
    // Every one of the three draft prices differs from what is published, so
    // the tab says "3 changed". Searching `studio` hides two of those three
    // changed prices. If the count were computed from what is rendered it
    // would read "1 changed" — and an operator would publish two edits they
    // had just been told were not there.
    render(
      <CatalogSurface
        mode="test"
        observation={<p>Satisfied — 7/7 days clean, both pairs</p>}
        browse={<p>the published catalog</p>}
        authoring={<AuthoringPanel {...authoringProps()} />}
        promoCodes={<p>the promo codes</p>}
        draftRows={DRAFT_ROWS}
        catalog={CATALOG}
        attemptNeedsAttention={false}
      />,
    );

    const draftTab = () => screen.getByRole("tab", { name: /Draft & Publish/ });
    expect(draftTab()).toHaveTextContent("3 changed");

    fireEvent.click(draftTab());
    search(/search the draft/i, "studio");

    // The search demonstrably hid changed rows...
    expect(draftKeys()).toEqual([
      "mark8ly_studio_annual_ppp_inr_v1",
    ]);
    // ...and the count did not move.
    expect(draftTab()).toHaveTextContent("3 changed");
    expect(draftTab()).toHaveAccessibleName(/3 changed/);
  });

  it("leaves the count alone even when the search matches nothing at all", () => {
    render(
      <CatalogSurface
        mode="test"
        observation={<p>Satisfied — 7/7 days clean, both pairs</p>}
        browse={<p>the published catalog</p>}
        authoring={<AuthoringPanel {...authoringProps()} />}
        promoCodes={<p>the promo codes</p>}
        draftRows={DRAFT_ROWS}
        catalog={CATALOG}
        attemptNeedsAttention={false}
      />,
    );

    const draftTab = () => screen.getByRole("tab", { name: /Draft & Publish/ });
    fireEvent.click(draftTab());
    search(/search the draft/i, "mark8ly_enterprise");

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(draftTab()).toHaveTextContent("3 changed");
  });
});
