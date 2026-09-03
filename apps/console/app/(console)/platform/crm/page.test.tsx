import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueuePage, QueueRow, HandoffRow } from "@/lib/db/crm-repo";
import type { ConversionSignal } from "@/lib/crm-conversion";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, UNKNOWN_FOLLOWERS } from "@/lib/db/crm-filters";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";

const dueOpportunities = vi.fn();
const driftingOpportunities = vi.fn();
const wonWithoutConversion = vi.fn();
const fetchConversionSignal = vi.fn();

vi.mock("@/lib/db/crm-repo", () => ({
  wonWithoutConversion: (...args: unknown[]) => wonWithoutConversion(...args),
}));

vi.mock("@/lib/crm-queues", () => ({
  fetchDueQueue: (...args: unknown[]) => dueOpportunities(...args),
  fetchDriftingQueue: (...args: unknown[]) => driftingOpportunities(...args),
}));

vi.mock("@/lib/crm-conversion", () => ({
  fetchConversionSignal: (...args: unknown[]) => fetchConversionSignal(...args),
}));


vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/crm",
  useSearchParams: () => new URLSearchParams(),
}));

import CrmPage, {
  DUE_EMPTY_MESSAGE,
  DRIFTING_EMPTY_MESSAGE,
  HANDOFF_EMPTY_MESSAGE,
  QUEUE_FILTERS,
  readQueueFilters,
  toFilterValues,
  toQueueItem,
  buildHandoffItems,
} from "./page";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `QueuePage` around `rows`, defaulting to the single-page case: `total`
 * is the row count and there is no next cursor.
 *
 * A helper rather than an object literal at every call site because the
 * interesting cases are the ones that OVERRIDE these defaults — a `total`
 * larger than the page is the whole bug this surface had — and those read
 * clearly only when the uninteresting fields are not restated beside them.
 */
function queuePage(rows: QueueRow[], overrides: Partial<QueuePage> = {}): QueuePage {
  return {
    rows,
    total: rows.length,
    precedingCount: 0,
    nextCursor: null,
    previousCursor: null,
    ...overrides,
  };
}

beforeEach(() => {
  dueOpportunities.mockReset();
  dueOpportunities.mockResolvedValue(queuePage([]));
  driftingOpportunities.mockReset();
  driftingOpportunities.mockResolvedValue(queuePage([]));
  wonWithoutConversion.mockReset();
  wonWithoutConversion.mockResolvedValue([]);
  fetchConversionSignal.mockReset();
  fetchConversionSignal.mockResolvedValue({ product: "mark8ly", state: "unknown" });
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
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

    await renderCrmPage();

    expect(screen.getByRole("heading", { name: /due/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /drifting/i })).toBeInTheDocument();
  });

  it("renders empty, not ready, when nothing is due", async () => {
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

    await renderCrmPage();

    expect(screen.getByText(/nothing due/i)).toBeInTheDocument();
  });

  it("renders drifting rows separately from due rows", async () => {
    dueOpportunities.mockResolvedValue(queuePage([DUE_ROW]));
    driftingOpportunities.mockResolvedValue(queuePage([DRIFTING_ROW]));

    await renderCrmPage();

    expect(screen.getByText("Bondi Store")).toBeInTheDocument();
    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
    // Drifting's empty copy must not appear once there is a drifting row.
    expect(screen.queryByText(DRIFTING_EMPTY_MESSAGE)).toBeNull();
  });

  it("does not blank the drifting group when the due read fails", async () => {
    dueOpportunities.mockRejectedValue(new Error("due query failed"));
    driftingOpportunities.mockResolvedValue(queuePage([DRIFTING_ROW]));

    await renderCrmPage();

    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
  });

  it("does not blank the due group when the drifting read fails", async () => {
    dueOpportunities.mockResolvedValue(queuePage([DUE_ROW]));
    driftingOpportunities.mockRejectedValue(new Error("drifting query failed"));

    await renderCrmPage();

    expect(screen.getByText("Bondi Store")).toBeInTheDocument();
  });

  // These rejections come straight off `pg`, so a verbatim `.message` puts
  // `relation "crm_opportunities" does not exist` in front of an operator —
  // the read-path twin of the constraint-name leak `lib/crm-write.ts`
  // records. The failing group must also say WHICH group failed, since the
  // other one is still rendering rows beside it.
  it("shows safe copy naming the failed group, never the raw database message", async () => {
    dueOpportunities.mockRejectedValue(
      new Error('relation "crm_opportunities" does not exist'),
    );
    driftingOpportunities.mockResolvedValue(queuePage([DRIFTING_ROW]));

    await renderCrmPage();

    expect(screen.queryByText(/relation "crm_opportunities"/)).toBeNull();
    expect(screen.getByText(/could not load the due queue/i)).toBeInTheDocument();
  });

  // Due and Drifting are two independent reads under one `Promise.allSettled`
  // (the module doc's whole point), so a session with no operator token row
  // fails BOTH of them with the same condition. Three stacked "sign in
  // again" callouts (this test, plus one more once Handoff is visited) would
  // be worse than the generic error this state replaces — see #300 task 4.
  it("shows one sign-in prompt, not two, when the session has no platform token", async () => {
    const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
    dueOpportunities.mockRejectedValue(noToken);
    driftingOpportunities.mockRejectedValue(noToken);

    await renderCrmPage();

    expect(screen.getAllByRole("link", { name: /sign in again/i })).toHaveLength(1);
  });

  it("still shows the other group's real rows when only one queue has no platform token", async () => {
    // The suppression is specific to the reauth-required kind: a group that
    // resolved normally must render normally beside the single prompt, not
    // be blanked out along with it.
    const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
    dueOpportunities.mockRejectedValue(noToken);
    driftingOpportunities.mockResolvedValue(queuePage([DRIFTING_ROW]));

    await renderCrmPage();

    expect(screen.getAllByRole("link", { name: /sign in again/i })).toHaveLength(1);
    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
  });

  it("sends the operator back to the exact filtered URL they were on", async () => {
    const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
    dueOpportunities.mockRejectedValue(noToken);
    driftingOpportunities.mockRejectedValue(noToken);

    await renderCrmPage({ product: "mark8ly" });

    const link = screen.getByRole("link", { name: /sign in again/i });
    const href = link.getAttribute("href")!;
    expect(href.startsWith("/auth/login?returnTo=")).toBe(true);
    expect(decodeURIComponent(href.split("returnTo=")[1])).toBe("/platform/crm?product=mark8ly");
  });

  it("renders filtered-empty, not empty, when an active filter matches nothing", async () => {
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

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
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

    await renderCrmPage({ product: "mark8ly", stage: "qualified", owner: "Asha" });

    expect(dueOpportunities).toHaveBeenCalledWith(
      { product: "mark8ly", stage: "qualified", owner: "Asha" },
      expect.any(Number),
      undefined,
    );
    expect(driftingOpportunities).toHaveBeenCalledWith(
      { product: "mark8ly", stage: "qualified", owner: "Asha" },
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it("does not forward an unrecognised stage from the URL to the reads", async () => {
    // A bad value in a hand-edited or bookmarked URL reads as "unfiltered",
    // never reaches SQL, and never renders a 500.
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

    await renderCrmPage({ stage: "banana" });

    expect(dueOpportunities).toHaveBeenCalledWith({}, expect.any(Number), undefined);
    expect(screen.getByText(DUE_EMPTY_MESSAGE)).toBeInTheDocument();
  });
});

/**
 * Rows for a queue that fills a page. `count` is the page limit in the
 * tests below, not a token 2 or 3: this surface's defect was invisible under
 * the limit — it rendered a full page and said nothing about the rows past
 * it — so a fixture smaller than a page cannot reproduce it.
 */
function queueRows(count: number, prefix: string): QueueRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ...DRIFTING_ROW,
    id: `${prefix}-${index}`,
    organisationId: `org-${prefix}-${index}`,
    organisationName: `${prefix} ${index}`,
  }));
}

/** The page limit both queues are read with (`DUE_LIMIT`/`DRIFTING_LIMIT`). */
const PAGE_LIMIT = 100;

function duePager() {
  return screen.getByRole("navigation", { name: "the due queue pagination" });
}

function driftingPager() {
  return screen.getByRole("navigation", { name: "the drifting queue pagination" });
}

function hrefOf(link: HTMLElement): URLSearchParams {
  return new URLSearchParams(link.getAttribute("href")!.split("?")[1]);
}

describe("CrmPage queue pagination", () => {
  // The bug itself: production holds 259 drifting organisations and this
  // surface rendered 100 of them with nothing on the page to say the other
  // 159 existed. An operator working the queue to the bottom concluded they
  // had seen everything.
  it("reports the whole matching set, not the page size, when a queue exceeds one page", async () => {
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), { total: 259, nextCursor: "cursor-page-2" }),
    );

    await renderCrmPage();

    expect(driftingPager()).toHaveTextContent("1–100 of 259");
    const next = screen.getByRole("link", { name: "Next page of the drifting queue" });
    expect(hrefOf(next).get("driftCursor")).toBe("cursor-page-2");
  });

  // Both queues, because each carries its own `precedingCount` through its
  // own props: a page-two Due reading "1–100" would tell an operator they
  // were at the top of a queue they had already worked halfway down.
  it("reports the position of a later page, not just its size", async () => {
    dueOpportunities.mockResolvedValue(
      queuePage(queueRows(50, "due"), { total: 150, precedingCount: 100 }),
    );
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), {
        total: 259,
        precedingCount: 100,
        nextCursor: "cursor-page-3",
      }),
    );

    await renderCrmPage({ dueCursor: "due-page-2", driftCursor: "cursor-page-2" });

    expect(duePager()).toHaveTextContent("101–150 of 150");
    expect(driftingPager()).toHaveTextContent("101–200 of 259");
  });

  it("gives each queue its own cursor param, so paging one leaves the other where it was", async () => {
    dueOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "due"), { total: 150, nextCursor: "due-2" }),
    );
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), { total: 259, nextCursor: "drift-2" }),
    );

    await renderCrmPage({ driftCursor: "drift-1" });

    // Paging Due carries the Drifting cursor across untouched — a single
    // shared `cursor` param would send Drifting back to page one (or, worse,
    // resume it from a position that belongs to the other queue).
    const dueNext = hrefOf(screen.getByRole("link", { name: "Next page of the due queue" }));
    expect(dueNext.get("dueCursor")).toBe("due-2");
    expect(dueNext.get("driftCursor")).toBe("drift-1");

    const driftNext = hrefOf(
      screen.getByRole("link", { name: "Next page of the drifting queue" }),
    );
    expect(driftNext.get("driftCursor")).toBe("drift-2");
    expect(driftNext.has("dueCursor")).toBe(false);
  });

  it("gives each queue its own previous link, replacing only its own cursor", async () => {
    dueOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "due"), {
        total: 150,
        precedingCount: 100,
        previousCursor: "due-back-1",
      }),
    );
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), {
        total: 259,
        precedingCount: 100,
        previousCursor: "drift-back-1",
      }),
    );

    await renderCrmPage({ dueCursor: "due-2", driftCursor: "drift-2" });

    // Paging Due backwards must leave Drifting exactly where the operator
    // left it — the same rule the next links follow, in the direction
    // nothing exercised before.
    const duePrevious = hrefOf(
      screen.getByRole("link", { name: "Previous page of the due queue" }),
    );
    expect(duePrevious.get("dueCursor")).toBe("due-back-1");
    expect(duePrevious.get("driftCursor")).toBe("drift-2");

    const driftPrevious = hrefOf(
      screen.getByRole("link", { name: "Previous page of the drifting queue" }),
    );
    expect(driftPrevious.get("driftCursor")).toBe("drift-back-1");
    expect(driftPrevious.get("dueCursor")).toBe("due-2");
  });

  it("offers no previous link on page one of either queue", async () => {
    dueOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "due"), { total: 150, nextCursor: "due-2" }),
    );
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), { total: 259, nextCursor: "drift-2" }),
    );

    await renderCrmPage();

    expect(screen.queryByRole("link", { name: /Previous page of/ })).toBeNull();
  });

  it("reads each queue's cursor from its own param", async () => {
    await renderCrmPage({ dueCursor: "due-abc", driftCursor: "drift-xyz" });

    expect(dueOpportunities).toHaveBeenCalledWith({}, PAGE_LIMIT, "due-abc");
    expect(driftingOpportunities).toHaveBeenCalledWith(
      {},
      expect.any(Number),
      PAGE_LIMIT,
      "drift-xyz",
    );
  });

  it("carries the active filters into the next-page link", async () => {
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), { total: 259, nextCursor: "drift-2" }),
    );

    await renderCrmPage({ stage: "new", owner: "Asha" });

    const next = hrefOf(screen.getByRole("link", { name: "Next page of the drifting queue" }));
    expect(next.get("stage")).toBe("new");
    expect(next.get("owner")).toBe("Asha");
  });

  it("offers no next link on the last page", async () => {
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(3, "drift"), { total: 203, precedingCount: 200 }),
    );

    await renderCrmPage({ driftCursor: "drift-3" });

    expect(driftingPager()).toHaveTextContent("201–203 of 203");
    expect(screen.queryByRole("link", { name: "Next page of the drifting queue" })).toBeNull();
  });

  // "0 of 0" beside a pager is worse than the empty copy: it reads as a
  // surface that lost its rows rather than one with nothing waiting.
  it("keeps the empty message and renders no pager when a queue is genuinely empty", async () => {
    await renderCrmPage();

    expect(screen.getByText(DUE_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(DRIFTING_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: /pagination/ })).toBeNull();
  });

  it("renders no pager for a queue whose read failed", async () => {
    dueOpportunities.mockRejectedValue(new Error("due query failed"));
    driftingOpportunities.mockResolvedValue(
      queuePage(queueRows(PAGE_LIMIT, "drift"), { total: 259, nextCursor: "drift-2" }),
    );

    await renderCrmPage();

    expect(screen.queryByRole("navigation", { name: "the due queue pagination" })).toBeNull();
    // ...and the queue that DID load still has its own pager.
    expect(driftingPager()).toBeInTheDocument();
  });

  // The repo rejects a malformed cursor rather than silently serving page
  // one, so a hand-edited `?dueCursor=` arrives here as a rejection. It is
  // already isolated to its own group by `Promise.allSettled`, which is what
  // keeps it from becoming an unhandled 500 for the whole page: the queue
  // that could not be positioned shows the same operator-safe failure copy
  // any other read failure does, and the other queue is untouched.
  it("surfaces a malformed cursor as that queue's failure, never as a broken page", async () => {
    dueOpportunities.mockRejectedValue(new Error("dueOpportunities: malformed cursor"));
    driftingOpportunities.mockResolvedValue(queuePage([DRIFTING_ROW]));

    await renderCrmPage({ dueCursor: "not-a-cursor" });

    expect(screen.getByText(/could not load the due queue/i)).toBeInTheDocument();
    expect(screen.queryByText(/malformed cursor/i)).toBeNull();
    expect(screen.getByText("Never Contacted Co")).toBeInTheDocument();
  });

  // Two pagers on one page: without distinct accessible names a screen
  // reader user listing links hears "Next, Next".
  it("names each pager after its own queue", async () => {
    dueOpportunities.mockResolvedValue(queuePage([DUE_ROW], { total: 4, nextCursor: "due-2" }));
    driftingOpportunities.mockResolvedValue(
      queuePage([DRIFTING_ROW], { total: 9, nextCursor: "drift-2" }),
    );

    await renderCrmPage();

    expect(duePager()).toHaveTextContent("1–1 of 4");
    expect(driftingPager()).toHaveTextContent("1–1 of 9");
    expect(screen.getAllByRole("link", { name: /^Next page of/ })).toHaveLength(2);
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

  it("reads the unassigned sentinel even though it names no real product", () => {
    // The ESTATE check alone would reject this the same way it rejects
    // "banana" below — it has to be special-cased ahead of that check, or
    // the "Unassigned" filter option silently does nothing when picked.
    expect(readQueueFilters({ product: UNASSIGNED_PRODUCT })).toEqual({
      product: UNASSIGNED_PRODUCT,
    });
  });

  it("still drops an unrecognised product that isn't the sentinel", () => {
    expect(readQueueFilters({ product: "banana" })).toEqual({});
  });

  it("offers every country COUNTRY_LABELS declares, plus Unknown", () => {
    // Derived from COUNTRY_LABELS's own keys, not a hand-picked subset — a
    // `toContain`-only assertion would still pass if a code were dropped
    // from the options, which is exactly the regression this test exists to
    // catch. "Unknown" is last, like "Unassigned" on the product filter: it
    // answers a different question than picking a market does, and without
    // it the 208 organisations with no derived country are unreachable.
    const country = QUEUE_FILTERS.find((d) => d.key === "country");
    expect(country?.options?.map((o) => o.value)).toEqual([
      ...Object.keys(COUNTRY_LABELS),
      UNKNOWN_COUNTRY,
    ]);
    expect(country?.options?.at(-1)?.label).toBe("Unknown");
  });

  it("offers every follower band FOLLOWER_BANDS declares, plus Unknown", () => {
    const followers = QUEUE_FILTERS.find((d) => d.key === "followers");
    expect(followers?.options?.map((o) => o.value)).toEqual([
      "under1k",
      "k1to10k",
      "over10k",
      UNKNOWN_FOLLOWERS,
    ]);
    // A data state, never a value: "0" or "None" would read as a measured
    // follower count of zero.
    expect(followers?.options?.at(-1)?.label).toBe("Unknown");
  });

  it("reads the unknown sentinels even though they name no country or band", () => {
    // Both fail their own recognised-value check by design (the sentinel is
    // not a COUNTRY_LABELS key, and not a FOLLOWER_BANDS key), so each has
    // to be admitted explicitly or the option silently does nothing.
    expect(readQueueFilters({ country: UNKNOWN_COUNTRY })).toEqual({ country: UNKNOWN_COUNTRY });
    expect(readQueueFilters({ followers: UNKNOWN_FOLLOWERS })).toEqual({
      followers: UNKNOWN_FOLLOWERS,
    });
  });

  it("carries the unknown sentinels back to the bar as applied values", () => {
    expect(toFilterValues({ country: UNKNOWN_COUNTRY, followers: UNKNOWN_FOLLOWERS })).toEqual({
      country: UNKNOWN_COUNTRY,
      followers: UNKNOWN_FOLLOWERS,
    });
  });

  it("reads a valid country", () => {
    expect(readQueueFilters({ country: "IN" })).toEqual({ country: "IN" });
  });

  it("drops an unrecognised country rather than passing it to SQL", () => {
    // Same contract as the organisations page: a code outside COUNTRY_LABELS
    // reads as unfiltered, never reaches the repo's exact-match clause.
    expect(readQueueFilters({ country: "ZZ" })).toEqual({});
  });

  it("drops an Object.prototype member name as a country", () => {
    // `Object.hasOwn`, not `in` — `in` walks the prototype chain, so
    // `?country=__proto__` (or `constructor`, `toString`) would otherwise
    // read as a recognised code.
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(readQueueFilters({ country: key })).toEqual({});
    }
  });

  it("reads a valid follower band", () => {
    expect(readQueueFilters({ followers: "over10k" })).toEqual({ followers: "over10k" });
  });

  it("drops an unrecognised follower band rather than passing it to SQL", () => {
    expect(readQueueFilters({ followers: "banana" })).toEqual({});
  });
});

describe("toFilterValues", () => {
  it("shows the bar only what the server actually applied", () => {
    expect(toFilterValues({ stage: "contacted" })).toEqual({ stage: "contacted" });
  });

  it("includes country and followers when applied", () => {
    expect(toFilterValues({ country: "IN", followers: "over10k" })).toEqual({
      country: "IN",
      followers: "over10k",
    });
  });
});

const HANDOFF_ROW: HandoffRow = {
  opportunityId: "opp-9",
  organisationId: "org-9",
  organisationName: "Bondi Baker",
  product: "mark8ly",
  primaryEmail: "priya@bondibaker.example",
  closedAt: "2026-08-10T00:00:00.000Z",
};

describe("Handoff", () => {
  it("lists won opportunities with no conversion recorded", async () => {
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(/bondi baker/i)).toBeInTheDocument();
  });

  it("shows a suggested match as unconfirmed rather than linking it", async () => {
    // A wrongly auto-linked conversion corrupts the attribution this exists
    // to produce, and writes a ref into the wrong product's namespace.
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);
    fetchConversionSignal.mockResolvedValue({
      product: "mark8ly",
      state: "complete",
      ref: "tenant_9f2",
      label: "Bondi Store",
      observedAt: "2026-08-17T09:00:00.000Z",
    });

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByRole("button", { name: /confirm/i })).toBeInTheDocument();
    // Not linked automatically: the page's own read of the organisation
    // never happened (this is a server render pulling apart the union), and
    // nothing here calls `linkConversion` — only user interaction with the
    // confirm button can.
  });

  it("shows unknown rather than not-converted when the product could not be reached", async () => {
    // THE rule: `unknown` and `none` must never read the same to an
    // operator. Rendering `unknown` as "not converted" is the false
    // negative this whole surface exists to prevent.
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);
    fetchConversionSignal.mockResolvedValue({ product: "mark8ly", state: "unknown" });

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/not converted/i)).toBeNull();
  });

  it("does not offer a confirm button for a definite \"none\"", async () => {
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);
    fetchConversionSignal.mockResolvedValue({ product: "mark8ly", state: "none" });

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  // The other half of the distinctness rule: a test asserting only that
  // `unknown` doesn't say "not converted" would still pass an
  // implementation that renders `none` as "Unknown — could not check" too.
  // Both halves have to hold.
  it('renders "Not converted" for a definite none — not the unknown copy', async () => {
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);
    fetchConversionSignal.mockResolvedValue({ product: "mark8ly", state: "none" });

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(/not converted/i)).toBeInTheDocument();
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  // The case the live data produces on DAY ONE: `migrate-leads-to-crm.mjs`
  // maps `converted → won` with `product: null` on every migrated deal, so
  // the first migrated won lead lands straight in this queue. The surface
  // used to throw on it — one such row put the entire handoff tab into its
  // error state — and excluding those rows instead would have hidden the
  // whole migrated backlog. It renders, labelled "Unassigned" the same way
  // the work queue labels a product-less opportunity, and nothing is asked
  // of a product that was never assigned.
  it("renders a migrated won opportunity with no product rather than throwing", async () => {
    wonWithoutConversion.mockResolvedValue([
      { ...HANDOFF_ROW, product: null, primaryEmail: "priya@bondibaker.example" },
    ]);

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(/bondi baker/i)).toBeInTheDocument();
    expect(screen.getByText(/unassigned/i)).toBeInTheDocument();
    // No product to address a conversion-status call to, so none is made —
    // and the row must not read as a fabricated "Not converted".
    expect(fetchConversionSignal).not.toHaveBeenCalled();
    expect(screen.queryByText(/not converted/i)).toBeNull();
    // Nor as "could not check": nothing was checked, and there was nothing
    // to check. "Could not" describes an attempt that failed and invites an
    // operator to wait it out; this row will read the same way until the
    // deal has a product, which only linking a conversion gives it.
    expect(screen.getByText(/not checked/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not check/i)).toBeNull();
  });

  // The other half of that distinction, same shape as the `none`/`unknown`
  // pair above: a row that DOES have a product and whose check genuinely
  // failed must still say so, or the two have simply been collapsed the
  // other way round.
  it('renders "could not check" for a real failed check, not the not-checked copy', async () => {
    wonWithoutConversion.mockResolvedValue([HANDOFF_ROW]);
    fetchConversionSignal.mockRejectedValue(new Error("upstream is down"));

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(/could not check/i)).toBeInTheDocument();
    expect(screen.queryByText(/no product/i)).toBeNull();
  });

  it("prompts sign-in, returning to the handoff tab, when the session has no platform token", async () => {
    // wonWithoutConversion goes through dbReadError like the work queues do,
    // so this exercises the same fix from the other side of the tab split.
    const noToken = Object.assign(new Error("no token"), { noOperatorToken: true });
    wonWithoutConversion.mockRejectedValue(noToken);

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    const link = screen.getByRole("link", { name: /sign in again/i });
    expect(decodeURIComponent(link.getAttribute("href")!.split("returnTo=")[1])).toBe(
      "/platform/crm?tab=handoff",
    );
  });

  it("renders empty, not ready, when nothing is waiting for handoff", async () => {
    wonWithoutConversion.mockResolvedValue([]);

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(screen.getByText(HANDOFF_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  // Important: `wonWithoutConversion` is up to `HANDOFF_LIMIT` rows, each
  // fanned out into its own `fetchConversionSignal` call. Every one of them
  // is a guaranteed `unknown` today (apps/web's endpoint doesn't exist yet),
  // and if apps/web ever hangs instead of 404s, this is an 8s stall — on
  // the WORK queue, which has nothing to do with handoff. The Work tab must
  // never pay for a fan-out nobody is looking at.
  it("does not read the handoff queue or fan out any signal call when the Work tab is active", async () => {
    dueOpportunities.mockResolvedValue(queuePage([]));
    driftingOpportunities.mockResolvedValue(queuePage([]));

    render(await CrmPage({ searchParams: Promise.resolve({}) }));

    expect(wonWithoutConversion).not.toHaveBeenCalled();
    expect(fetchConversionSignal).not.toHaveBeenCalled();
  });

  // Symmetric check: the Handoff tab has no business paying for the Work
  // tab's queries either.
  it("does not read the due/drifting queues when the Handoff tab is active", async () => {
    wonWithoutConversion.mockResolvedValue([]);

    render(await CrmPage({ searchParams: Promise.resolve({ tab: "handoff" }) }));

    expect(dueOpportunities).not.toHaveBeenCalled();
    expect(driftingOpportunities).not.toHaveBeenCalled();
  });
});

describe("buildHandoffItems", () => {
  it("isolates one product's rejection to its own row, without blanking the others", async () => {
    const rowA: HandoffRow = { ...HANDOFF_ROW, opportunityId: "a", organisationId: "org-a" };
    const rowB: HandoffRow = {
      ...HANDOFF_ROW,
      opportunityId: "b",
      organisationId: "org-b",
      primaryEmail: "other@example.com",
    };
    fetchConversionSignal.mockImplementation(async (_product: string, email: string) => {
      if (email === rowA.primaryEmail) throw new Error("upstream hung");
      return { product: "mark8ly", state: "none" } satisfies ConversionSignal;
    });

    const items = await buildHandoffItems([rowA, rowB]);

    expect(items).toHaveLength(2);
    expect(items[0].signal.state).toBe("unknown");
    expect(items[1].signal.state).toBe("none");
  });

  // Important (review round 1): the test above proves only per-row error
  // isolation — a sequential `for...of` with a `try/catch` around each
  // await passes it identically, so it never actually pins the "never
  // sequential" guarantee (the N×8s stall Task 9's review exists to
  // prevent). This test uses promises this suite controls the resolution
  // of, so a sequential implementation is PROVABLY stuck after issuing only
  // the first call — it cannot start row B's request until row A's promise
  // settles, and nothing here ever settles it before the assertion runs,
  // no matter how many microtask ticks pass.
  it("issues every row's request before any of them resolves, not one at a time", async () => {
    const rowA: HandoffRow = { ...HANDOFF_ROW, opportunityId: "a", organisationId: "org-a" };
    const rowB: HandoffRow = {
      ...HANDOFF_ROW,
      opportunityId: "b",
      organisationId: "org-b",
      primaryEmail: "other@example.com",
    };

    let resolveA!: (signal: ConversionSignal) => void;
    let resolveB!: (signal: ConversionSignal) => void;
    const deferredA = new Promise<ConversionSignal>((resolve) => {
      resolveA = resolve;
    });
    const deferredB = new Promise<ConversionSignal>((resolve) => {
      resolveB = resolve;
    });
    let calls = 0;
    fetchConversionSignal.mockImplementation(async (_product: string, email: string) => {
      calls++;
      return email === rowA.primaryEmail ? deferredA : deferredB;
    });

    const itemsPromise = buildHandoffItems([rowA, rowB]);

    // Neither deferred promise has been resolved yet, so a sequential
    // implementation cannot have issued row B's call at this point under
    // ANY number of microtask ticks — it is still awaiting row A's, which
    // this test deliberately has not settled.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);

    resolveA({ product: "mark8ly", state: "unknown" });
    resolveB({ product: "mark8ly", state: "none" });
    const items = await itemsPromise;

    expect(items[0].signal.state).toBe("unknown");
    expect(items[1].signal.state).toBe("none");
  });

  // Important: unbounded fan-out was flagged alongside "never sequential" —
  // a handoff queue at HANDOFF_LIMIT (100) firing 100 simultaneous requests
  // at the one apps/web proxy every product's check goes through is its own
  // failure mode. This pins the other half: concurrency is bounded, not
  // just "not sequential".
  it("caps simultaneous requests rather than firing all of them at once", async () => {
    const rowCount = 25;
    const rows: HandoffRow[] = Array.from({ length: rowCount }, (_, index) => ({
      ...HANDOFF_ROW,
      opportunityId: `opp-${index}`,
      organisationId: `org-${index}`,
      primaryEmail: `lead-${index}@example.com`,
    }));

    const resolvers: Array<(signal: ConversionSignal) => void> = [];
    let calls = 0;
    fetchConversionSignal.mockImplementation(
      () =>
        new Promise<ConversionSignal>((resolve) => {
          calls++;
          resolvers.push(resolve);
        }),
    );

    const itemsPromise = buildHandoffItems(rows);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Fewer than every row — the cap held even though nothing has resolved
    // yet to free up a worker.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(rowCount);
    const capped = calls;

    // Freeing every outstanding slot lets the remaining rows proceed —
    // proving the shortfall above was a concurrency cap, not a broken
    // fan-out that dropped rows on the floor.
    while (resolvers.length > 0) {
      resolvers.shift()!({ product: "mark8ly", state: "none" });
      await Promise.resolve();
    }
    const items = await itemsPromise;

    expect(capped).toBeLessThan(rowCount);
    expect(items).toHaveLength(rowCount);
    expect(items.every((item) => item.signal.state === "none")).toBe(true);
  });

  // Ruling 32: the cap bounds concurrent CONNECTIONS, not total TIME —
  // without a total deadline, a queue where every call hangs runs
  // `HANDOFF_LIMIT / HANDOFF_FETCH_CONCURRENCY` sequential waves of the
  // client's own 8s timeout each, an order of magnitude past a single
  // unbounded fan-out. A row still in flight when the deadline elapses must
  // render as `unknown` — the render must not wait on it — while a row that
  // genuinely answered before the deadline keeps its real answer.
  it("renders a row that has not answered by the deadline as unknown, without waiting for it", async () => {
    const answered: HandoffRow = { ...HANDOFF_ROW, opportunityId: "fast", organisationId: "org-fast" };
    const hung: HandoffRow = {
      ...HANDOFF_ROW,
      opportunityId: "slow",
      organisationId: "org-slow",
      primaryEmail: "slow@example.com",
    };
    fetchConversionSignal.mockImplementation(
      async (_product: string, email: string) =>
        email === answered.primaryEmail
          ? { product: "mark8ly", state: "none" }
          : new Promise<ConversionSignal>(() => {}), // never resolves
    );

    const started = Date.now();
    const items = await buildHandoffItems([answered, hung], {
      deadlineMs: 20,
    });
    const elapsed = Date.now() - started;

    // The whole call returned close to the deadline, not stuck waiting on
    // the hung row indefinitely.
    expect(elapsed).toBeLessThan(2_000);
    const byId = Object.fromEntries(items.map((item) => [item.opportunityId, item]));
    expect(byId.fast.signal.state).toBe("none");
    expect(byId.slow.signal.state).toBe("unknown");
  });

  it("treats a row with no contact email as unknown without calling the product", async () => {
    const row: HandoffRow = { ...HANDOFF_ROW, primaryEmail: null };
    const items = await buildHandoffItems([row]);
    expect(items[0].signal).toEqual({ product: "mark8ly", state: "unknown" });
    expect(fetchConversionSignal).not.toHaveBeenCalled();
  });

  it("asks each row's own product, not a fixed one", async () => {
    fetchConversionSignal.mockResolvedValue({ product: "kora", state: "none" });
    const row: HandoffRow = { ...HANDOFF_ROW, product: "kora" };
    await buildHandoffItems([row]);
    expect(fetchConversionSignal).toHaveBeenCalledWith("kora", row.primaryEmail);
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
