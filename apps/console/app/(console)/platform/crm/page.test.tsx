import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { QueueRow } from "@/lib/db/crm-repo";

const dueOpportunities = vi.fn();
const driftingOpportunities = vi.fn();

vi.mock("@/lib/db/crm-repo", () => ({
  dueOpportunities: (...args: unknown[]) => dueOpportunities(...args),
  driftingOpportunities: (...args: unknown[]) => driftingOpportunities(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/crm",
  useSearchParams: () => new URLSearchParams(),
}));

import CrmPage, {
  DUE_EMPTY_MESSAGE,
  DRIFTING_EMPTY_MESSAGE,
  QUEUE_FILTERS,
  readQueueFilters,
  toFilterValues,
  toQueueItem,
} from "./page";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  dueOpportunities.mockReset();
  driftingOpportunities.mockReset();
});

const DUE_ROW: QueueRow = {
  id: "opp-1",
  organisationId: "org-1",
  organisationName: "Bondi Store",
  product: "mark8ly",
  stage: "contacted",
  owner: "Asha",
  nextActionAt: "2026-08-10T09:00:00.000Z",
  nextActionNote: "Call about renewal",
  lastContactedAt: "2026-08-01T09:00:00.000Z",
  quietSince: "2026-08-01T09:00:00.000Z",
  isStarred: false,
};

const DRIFTING_ROW: QueueRow = {
  id: "opp-2",
  organisationId: "org-2",
  organisationName: "Never Contacted Co",
  product: null,
  stage: "new",
  owner: null,
  nextActionAt: null,
  nextActionNote: null,
  lastContactedAt: null,
  quietSince: "2026-07-01T09:00:00.000Z",
  isStarred: true,
};

async function renderCrmPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  render(await CrmPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("CrmPage", () => {
  it("renders Due and Drifting as separate groups", async () => {
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

    await renderCrmPage();

    expect(screen.getByRole("heading", { name: /due/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /drifting/i })).toBeInTheDocument();
  });

  it("renders empty, not ready, when nothing is due", async () => {
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

    await renderCrmPage();

    expect(screen.getByText(/nothing due/i)).toBeInTheDocument();
  });

  it("renders drifting rows separately from due rows", async () => {
    dueOpportunities.mockResolvedValue([DUE_ROW]);
    driftingOpportunities.mockResolvedValue([DRIFTING_ROW]);

    await renderCrmPage();

    expect(screen.getByText("Bondi Store")).toBeInTheDocument();
    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
    // Drifting's empty copy must not appear once there is a drifting row.
    expect(screen.queryByText(DRIFTING_EMPTY_MESSAGE)).toBeNull();
  });

  it("does not blank the drifting group when the due read fails", async () => {
    dueOpportunities.mockRejectedValue(new Error("due query failed"));
    driftingOpportunities.mockResolvedValue([DRIFTING_ROW]);

    await renderCrmPage();

    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
  });

  it("does not blank the due group when the drifting read fails", async () => {
    dueOpportunities.mockResolvedValue([DUE_ROW]);
    driftingOpportunities.mockRejectedValue(new Error("drifting query failed"));

    await renderCrmPage();

    expect(screen.getByText("Bondi Store")).toBeInTheDocument();
  });

  it("renders filtered-empty, not empty, when an active filter matches nothing", async () => {
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

    await renderCrmPage({ product: "homechef" });

    expect(screen.queryByText(DUE_EMPTY_MESSAGE)).toBeNull();
    expect(screen.getAllByText("No matches").length).toBeGreaterThan(0);
  });

  it("passes the parsed filter to both reads rather than filtering the returned page", async () => {
    // Ruling 11: `dueOpportunities`/`driftingOpportunities` are ORDER BY …
    // LIMIT. A row matching the filter but ranked below the limit cut-off is
    // only ever returned if the predicate runs in SQL — filtering the
    // already-paged TypeScript array can never see it. This test pins that
    // the page forwards the filter into the read rather than reintroducing
    // a post-filter; `crm-repo.integration.test.ts` pins the SQL side of the
    // same guarantee against a real database.
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

    await renderCrmPage({ product: "mark8ly", stage: "qualified", owner: "Asha" });

    expect(dueOpportunities).toHaveBeenCalledWith(
      { product: "mark8ly", stage: "qualified", owner: "Asha" },
      expect.any(Number),
    );
    expect(driftingOpportunities).toHaveBeenCalledWith(
      { product: "mark8ly", stage: "qualified", owner: "Asha" },
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("does not forward an unrecognised stage from the URL to the reads", async () => {
    // A bad value in a hand-edited or bookmarked URL reads as "unfiltered",
    // never reaches SQL, and never renders a 500.
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

    await renderCrmPage({ stage: "banana" });

    expect(dueOpportunities).toHaveBeenCalledWith({}, expect.any(Number));
    expect(screen.getByText(DUE_EMPTY_MESSAGE)).toBeInTheDocument();
  });
});

describe("readQueueFilters", () => {
  it("offers every product in the estate, not only those with rows today", () => {
    const product = QUEUE_FILTERS.find((d) => d.key === "product");
    expect(product?.options?.map((o) => o.value)).toContain("dwellm8");
    expect(product?.options?.length).toBeGreaterThan(3);
  });

  it("does not offer won/lost in the stage select — both queries always exclude them", () => {
    // Offering a stage the query refuses would render two empty groups with
    // nothing telling the operator the choice was refused rather than
    // simply unmatched.
    const stage = QUEUE_FILTERS.find((d) => d.key === "stage");
    const values = stage?.options?.map((o) => o.value) ?? [];
    expect(values).not.toContain("won");
    expect(values).not.toContain("lost");
    expect(values).toEqual(["new", "contacted", "qualified"]);
  });

  it("drops a value no descriptor offers", () => {
    expect(readQueueFilters({ stage: "banana" })).toEqual({});
  });

  it("reads a valid stage and product", () => {
    expect(readQueueFilters({ stage: "contacted", product: "mark8ly" })).toEqual({
      stage: "contacted",
      product: "mark8ly",
    });
  });

  it("reads a free-text owner filter", () => {
    expect(readQueueFilters({ owner: "Asha" })).toEqual({ owner: "Asha" });
  });
});

describe("toFilterValues", () => {
  it("shows the bar only what the server actually applied", () => {
    expect(toFilterValues({ stage: "contacted" })).toEqual({ stage: "contacted" });
  });
});

describe("toQueueItem", () => {
  it("orders and displays by quietSince, not lastContactedAt", () => {
    // A never-contacted row has a null lastContactedAt, but quietSince falls
    // back to its creation date — the value this list is ordered by. Reading
    // waitingSince from lastContactedAt would show nothing for exactly the
    // rows most at risk of being forgotten.
    const item = toQueueItem(DRIFTING_ROW);
    expect(item.waitingSince).toBe(DRIFTING_ROW.quietSince);
  });

  it("builds the org detail href from organisationId", () => {
    expect(toQueueItem(DUE_ROW).href).toBe("/platform/crm/org-1");
  });

  it("carries the stage in the status slot", () => {
    expect(toQueueItem(DUE_ROW).status?.label.toLowerCase()).toContain("contacted");
  });

  it("uses nextActionAt as dueAt", () => {
    expect(toQueueItem(DUE_ROW).dueAt).toBe(DUE_ROW.nextActionAt);
  });
});
