import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { QueueRow, HandoffRow } from "@/lib/db/crm-repo";
import type { ConversionSignal } from "@/lib/crm-conversion";

const dueOpportunities = vi.fn();
const driftingOpportunities = vi.fn();
const wonWithoutConversion = vi.fn();
const fetchConversionSignal = vi.fn();

vi.mock("@/lib/db/crm-repo", () => ({
  dueOpportunities: (...args: unknown[]) => dueOpportunities(...args),
  driftingOpportunities: (...args: unknown[]) => driftingOpportunities(...args),
  wonWithoutConversion: (...args: unknown[]) => wonWithoutConversion(...args),
}));

vi.mock("@/lib/crm-conversion", () => ({
  fetchConversionSignal: (...args: unknown[]) => fetchConversionSignal(...args),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ toString: () => "tx_session=abc" }),
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

beforeEach(() => {
  dueOpportunities.mockReset();
  dueOpportunities.mockResolvedValue([]);
  driftingOpportunities.mockReset();
  driftingOpportunities.mockResolvedValue([]);
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
    dueOpportunities.mockResolvedValue([]);
    driftingOpportunities.mockResolvedValue([]);

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

    const items = await buildHandoffItems([rowA, rowB], "tx_session=abc");

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

    const itemsPromise = buildHandoffItems([rowA, rowB], "tx_session=abc");

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

    const itemsPromise = buildHandoffItems(rows, "tx_session=abc");

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
    const items = await buildHandoffItems([answered, hung], "tx_session=abc", {
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
    const items = await buildHandoffItems([row], "tx_session=abc");
    expect(items[0].signal).toEqual({ product: "mark8ly", state: "unknown" });
    expect(fetchConversionSignal).not.toHaveBeenCalled();
  });

  it("asks each row's own product, not a fixed one", async () => {
    fetchConversionSignal.mockResolvedValue({ product: "kora", state: "none" });
    const row: HandoffRow = { ...HANDOFF_ROW, product: "kora" };
    await buildHandoffItems([row], "tx_session=abc");
    expect(fetchConversionSignal).toHaveBeenCalledWith("kora", row.primaryEmail, "tx_session=abc");
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
