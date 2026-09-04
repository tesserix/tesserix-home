import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { resolveState } from "@/components/kit/surface-state";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import type { CatalogRow } from "@/lib/db/plan-catalog-repo";
import { CatalogSurface } from "./catalog-surface";
import { CatalogViews } from "./catalog-views";

/**
 * The tab shell. What is asserted here is what the tabs COST and what they had
 * to buy back: an operator can now only see one of Browse and Draft & Publish
 * at a time, so the Draft trigger has to say — from Browse — that a draft is
 * waiting and that the last publish attempt did not succeed.
 *
 * `AuthoringPanel` itself is stood in for by a marker element in most tests
 * here: this file is about the shell, and `authoring-panel.render.test.tsx`
 * owns the panel's own render. `page.test.tsx` is what proves the real panel
 * is what the shell is handed.
 */

const PUBLISHED_ROW: CatalogRow = {
  lookupKey: "mark8ly_pro_monthly_developed_v1",
  plan: "pro",
  period: "monthly",
  tier: "developed",
  source: SINGLE_SOURCE,
  currency: "usd",
  unitAmountMinor: 4900,
  taxBehavior: "exclusive",
};

const SECOND_PUBLISHED_ROW: CatalogRow = {
  ...PUBLISHED_ROW,
  lookupKey: "mark8ly_pro_annual_developed_v1",
  period: "annual",
  unitAmountMinor: 49000,
};

const ready = (rows: readonly unknown[]) =>
  resolveState({ isLoading: false, error: null, rows: [...rows], filtered: false });

function renderSurface(over: Partial<Parameters<typeof CatalogSurface>[0]> = {}) {
  return render(
    <CatalogSurface
      mode="test"
      observation={<p>Satisfied — 7/7 days clean, both pairs</p>}
      divergence={<p>Test and live serve the same catalog</p>}
      browse={<p>the published catalog</p>}
      authoring={<p>the authoring panel</p>}
      promoCodes={<p>the promo codes panel</p>}
      draftRows={null}
      catalog={[PUBLISHED_ROW]}
      attemptNeedsAttention={false}
      {...over}
    />,
  );
}

const draftTab = () => screen.getByRole("tab", { name: /Draft & Publish/ });

describe("CatalogSurface — both panels are reachable, one at a time", () => {
  it("lands on Browse, with the authoring panel not rendered at all", () => {
    renderSurface();

    expect(screen.getByRole("tab", { name: "Browse" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("the published catalog")).toBeInTheDocument();
    // Not merely hidden: `TabsContent` renders `null` for the inactive panel.
    expect(screen.queryByText("the authoring panel")).toBeNull();
  });

  it("reaches the authoring panel on a click, and lets Browse back", () => {
    renderSurface();

    fireEvent.click(draftTab());
    expect(screen.getByText("the authoring panel")).toBeInTheDocument();
    expect(screen.queryByText("the published catalog")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
    expect(screen.getByText("the published catalog")).toBeInTheDocument();
  });

  it("keeps the observation strip and the mode toggle above the tabs, visible from either", () => {
    // The whole reason these two are not inside a tab: the parity verdict is
    // about the catalog both tabs are about, and the mode governs the draft's
    // publish target as much as it governs which catalog is listed. An
    // operator on Draft & Publish who cannot see which mode they are about to
    // write to is the state this arrangement exists to prevent.
    renderSurface();

    fireEvent.click(draftTab());

    expect(screen.getByText("Satisfied — 7/7 days clean, both pairs")).toBeInTheDocument();
    // #527's line rides above the tabs for the same reason: whether test still
    // evidences live is a fact about the catalog both tabs are about.
    expect(screen.getByText("Test and live serve the same catalog")).toBeInTheDocument();
    const modes = screen.getByRole("tablist", { name: "Stripe mode" });
    expect(within(modes).getByRole("tab", { name: "test" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("the Promo codes tab", () => {
  it("is reachable, and renders its panel only when selected", () => {
    // #521 T4's tab. The shell's claim was that a third surface is one array
    // entry plus one prop; this is what that bought.
    renderSurface();

    expect(screen.queryByText("the promo codes panel")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Promo codes" }));

    expect(screen.getByText("the promo codes panel")).toBeInTheDocument();
    expect(screen.queryByText("the published catalog")).toBeNull();
    expect(screen.queryByText("the authoring panel")).toBeNull();
  });

  it("leaves Browse as the landing tab — promo codes are not the page's job", () => {
    renderSurface();

    expect(screen.getByRole("tab", { name: "Browse" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Promo codes" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("carries no badge — nothing about a promo code needs the operator's attention from Browse", () => {
    renderSurface({ attemptNeedsAttention: true, draftRows: [{ ...PUBLISHED_ROW, unitAmountMinor: 5900 }] });

    expect(screen.getByRole("tab", { name: "Promo codes" })).toHaveAccessibleName("Promo codes");
  });
});

describe("the Draft tab's changed-row count", () => {
  it("counts the rows whose amount differs from what is published", () => {
    renderSurface({
      catalog: [PUBLISHED_ROW, SECOND_PUBLISHED_ROW],
      // One edited, one untouched — the count is 1, not 2.
      draftRows: [
        { ...PUBLISHED_ROW, unitAmountMinor: 5900 },
        SECOND_PUBLISHED_ROW,
      ],
    });

    expect(draftTab()).toHaveTextContent("1 changed");
  });

  it("counts a lookup key the published catalog does not have — an added price is a change", () => {
    renderSurface({
      catalog: [PUBLISHED_ROW],
      draftRows: [PUBLISHED_ROW, SECOND_PUBLISHED_ROW],
    });

    expect(draftTab()).toHaveTextContent("1 changed");
  });

  it("counts a row once however many of its currencies moved", () => {
    // The tab is telling an operator how many prices to look at, not how many
    // cells — `DraftEditor`'s rows are per lookup key.
    renderSurface({
      catalog: [PUBLISHED_ROW, { ...PUBLISHED_ROW, currency: "eur", unitAmountMinor: 4500 }],
      draftRows: [
        { ...PUBLISHED_ROW, unitAmountMinor: 5900 },
        { ...PUBLISHED_ROW, currency: "eur", unitAmountMinor: 5500 },
      ],
    });

    expect(draftTab()).toHaveTextContent("1 changed");
  });

  it("carries no count at all when there is no draft — never a 0", () => {
    // "0 changed" on the tab would be a claim: that a draft exists and holds
    // nothing to publish. There is no draft.
    renderSurface({ draftRows: null });

    expect(draftTab()).not.toHaveTextContent("changed");
    expect(draftTab()).toHaveAccessibleName("Draft & Publish");
  });

  it("carries no count for a draft that matches what is published", () => {
    renderSurface({ catalog: [PUBLISHED_ROW], draftRows: [PUBLISHED_ROW] });

    expect(draftTab()).not.toHaveTextContent("changed");
  });
});

describe("the failed-attempt marker", () => {
  it("marks the tab from Browse, so a failed publish is not hidden behind it", () => {
    // Before the tabs, the alert inside `AuthoringPanel` was on screen. After
    // them, an operator can sit on Browse indefinitely — this is what tells
    // them to look.
    renderSurface({ attemptNeedsAttention: true });

    expect(screen.getByRole("tab", { name: "Browse" })).toHaveAttribute("aria-selected", "true");
    expect(draftTab()).toHaveTextContent("Needs attention");
  });

  it("says it in words, not in colour alone", () => {
    renderSurface({ attemptNeedsAttention: true });

    // The accessible name carries the marker, so it survives for an operator
    // reading with a screen reader and for one who cannot distinguish the
    // destructive tint.
    expect(draftTab()).toHaveAccessibleName(/Needs attention/);
  });

  it("shows the marker and the count together — two facts, not one", () => {
    renderSurface({
      attemptNeedsAttention: true,
      catalog: [PUBLISHED_ROW],
      draftRows: [{ ...PUBLISHED_ROW, unitAmountMinor: 5900 }],
    });

    expect(draftTab()).toHaveTextContent("1 changed");
    expect(draftTab()).toHaveTextContent("Needs attention");
  });

  it("leaves the tab unmarked when the latest attempt is nothing to report", () => {
    renderSurface({ attemptNeedsAttention: false });

    expect(draftTab()).not.toHaveTextContent("Needs attention");
  });
});

describe("nested tablists", () => {
  it("names every tablist on the surface distinctly", () => {
    // `PlanCatalogTabs` is a second `SurfaceTabs` INSIDE Browse, and the mode
    // toggle and source filter are pill rows with `role="tablist"` of their
    // own. Four tablists that all announced as "Tabs" would be unnavigable.
    renderSurface({
      browse: (
        <CatalogViews
          mode="test"
          catalog={[PUBLISHED_ROW]}
          catalogState={ready([PUBLISHED_ROW])}
          publication={null}
          publicationState={ready([])}
        />
      ),
    });

    const names = screen
      .getAllByRole("tablist")
      .map((list) => list.getAttribute("aria-label"));

    expect(names).toEqual(
      expect.arrayContaining([
        "Stripe mode",
        "Plan catalog surface",
        "Product",
        "Plan catalog, by plan",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(null);
  });
});
