import { beforeEach, describe, expect, it, vi } from "vitest";
import { MalformedCursorError } from "@/lib/db/keyset-cursor";
import { PlatformApiError } from "@/lib/platform-api-error";

vi.mock("@/lib/db/crm-repo", () => {
  // Mirrors the real `MissingProductError` in `lib/db/crm-repo.ts` — that
  // module is mocked wholesale here (it reaches Postgres via `./tesserix`,
  // which this test suite must not import), so the class under test is this
  // stand-in, not the production one. `crm-queues.ts` and this test both
  // resolve `MissingProductError` through the same mocked module path, so
  // the `instanceof` check below still exercises the real translation: what
  // it cannot catch is this stand-in's shape drifting from the real class,
  // which is why the constructor mirrors it field for field.
  class MissingProductError extends Error {
    constructor(readonly opportunityId: string) {
      super(
        `Opportunity ${opportunityId} was migrated without a product and must be assigned one (via a stage update) before it can be edited.`,
      );
      this.name = "MissingProductError";
    }
  }
  return {
    dueOpportunities: vi.fn(),
    driftingOpportunities: vi.fn(),
    setNextAction: vi.fn(),
    MissingProductError,
  };
});

/**
 * The two queue reads are given DIFFERENT totals so a test asserting on one
 * queue's `total` cannot pass against the other queue's page.
 */
const duePage = () => ({
  rows: [], total: 1, precedingCount: 0, nextCursor: null, previousCursor: null,
});
const driftingPage = () => ({
  rows: [], total: 2, precedingCount: 0, nextCursor: null, previousCursor: null,
});

const withMeta = vi.fn();
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: () => process.env.PLATFORM_API_ORIGIN?.trim() || null,
  platformRequestWithMeta: (...args: unknown[]) => withMeta(...args),
}));

describe("crm-queues dual path", () => {
  // The repo mocks' return values are established here rather than in the
  // `vi.mock` factory above: a factory runs once per file, so a return value
  // set there is state the FIRST test leaves behind for the rest to inherit,
  // and `vi.clearAllMocks()` does not put it back. Setting them per test
  // makes each test self-contained, and keeps the file working under
  // `restoreMocks` — which wipes implementations between tests (#550).
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.PLATFORM_API_ORIGIN;
    const repo = await import("@/lib/db/crm-repo");
    vi.mocked(repo.dueOpportunities).mockResolvedValue(duePage());
    vi.mocked(repo.driftingOpportunities).mockResolvedValue(driftingPage());
    vi.mocked(repo.setNextAction).mockResolvedValue(undefined);
  });

  it("reads Postgres when PLATFORM_API_ORIGIN is unset", async () => {
    const repo = await import("@/lib/db/crm-repo");
    const { fetchDueQueue } = await import("./crm-queues");
    const page = await fetchDueQueue({ stage: "new" }, 100);
    expect(repo.dueOpportunities).toHaveBeenCalledWith({ stage: "new" }, 100, undefined);
    expect(withMeta).not.toHaveBeenCalled();
    expect(page.total).toBe(1);
  });

  it("calls the platform API when PLATFORM_API_ORIGIN is set", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({
      data: { opportunities: [] },
      meta: { total: 9, preceding_count: 0 },
    });
    const repo = await import("@/lib/db/crm-repo");
    const { fetchDueQueue } = await import("./crm-queues");
    const page = await fetchDueQueue({ stage: "new" }, 100);
    expect(repo.dueOpportunities).not.toHaveBeenCalled();
    expect(withMeta).toHaveBeenCalledWith("crm due queue", "/v1/crm/queues/due?stage=new&limit=100");
    expect(page.total).toBe(9);
  });

  it("reads Postgres for the drifting queue when PLATFORM_API_ORIGIN is unset", async () => {
    const repo = await import("@/lib/db/crm-repo");
    const { fetchDriftingQueue } = await import("./crm-queues");
    const page = await fetchDriftingQueue({ stage: "new" }, 14, 100, "cur");
    expect(repo.driftingOpportunities).toHaveBeenCalledWith({ stage: "new" }, 14, 100, "cur");
    expect(withMeta).not.toHaveBeenCalled();
    expect(page.total).toBe(2);
  });

  it("sends stale_days on the drifting queue", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({ data: { opportunities: [] }, meta: {} });
    const { fetchDriftingQueue } = await import("./crm-queues");
    await fetchDriftingQueue({}, 14, 100);
    expect(withMeta).toHaveBeenCalledWith(
      "crm drifting queue",
      "/v1/crm/queues/drifting?limit=100&stale_days=14",
    );
  });

  it("PUTs the next action with a JSON body when the API is on", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockResolvedValue({ data: { opportunity: {} }, meta: undefined });
    const { saveNextAction } = await import("./crm-queues");
    await saveNextAction({ opportunityId: "abc", at: null, note: "later", actor: "sam@example.com" });
    expect(withMeta).toHaveBeenCalledWith(
      "crm next action",
      "/v1/crm/opportunities/abc/next-action",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ at: null, note: "later" }),
      }),
    );
  });

  it("falls back to the repo for the next action when the API is off", async () => {
    const repo = await import("@/lib/db/crm-repo");
    const { saveNextAction } = await import("./crm-queues");
    const input = { opportunityId: "abc", at: null, note: "later", actor: "sam@example.com" };
    await saveNextAction(input);
    expect(repo.setNextAction).toHaveBeenCalledWith(input);
    expect(withMeta).not.toHaveBeenCalled();
  });

  it("turns a cursor refusal from fetchDueQueue into a MalformedCursorError", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockRejectedValue(
      new PlatformApiError(
        "crm due queue: BAD_REQUEST — the cursor could not be read; start from the first page",
        400,
      ),
    );
    const { fetchDueQueue } = await import("./crm-queues");
    await expect(fetchDueQueue({}, 100, "stale-cursor")).rejects.toBeInstanceOf(
      MalformedCursorError,
    );
  });

  it("turns a cursor refusal from fetchDriftingQueue into a MalformedCursorError", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockRejectedValue(
      new PlatformApiError(
        "crm drifting queue: BAD_REQUEST — the cursor could not be read; start from the first page",
        400,
      ),
    );
    const { fetchDriftingQueue } = await import("./crm-queues");
    await expect(fetchDriftingQueue({}, 14, 100, "stale-cursor")).rejects.toBeInstanceOf(
      MalformedCursorError,
    );
  });

  it("turns a terminal-stage refusal into an empty QueuePage instead of throwing", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    withMeta.mockRejectedValue(
      new PlatformApiError(
        'crm due queue: VALIDATION_FAILED — the filter is not valid: stage: "won" is terminal; neither queue contains a won or lost opportunity',
        422,
      ),
    );
    const { fetchDueQueue } = await import("./crm-queues");
    const page = await fetchDueQueue({ stage: "won" }, 100);
    expect(page).toEqual({
      rows: [],
      total: 0,
      precedingCount: 0,
      nextCursor: null,
      previousCursor: null,
    });
  });

  it("turns a product-required refusal from saveNextAction into a MissingProductError", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    const repo = await import("@/lib/db/crm-repo");
    withMeta.mockRejectedValue(
      new PlatformApiError(
        'crm next action: VALIDATION_FAILED — this opportunity was migrated without a product and cannot be updated until one is set (it is at stage "qualified")',
        422,
      ),
    );
    const { saveNextAction } = await import("./crm-queues");
    const input = { opportunityId: "abc", at: null, note: "later", actor: "sam@example.com" };
    await expect(saveNextAction(input)).rejects.toBeInstanceOf(repo.MissingProductError);
  });

  it("does not swallow a 422 that is not the terminal-stage or product-required refusal", async () => {
    process.env.PLATFORM_API_ORIGIN = "http://platform-api.test";
    const error = new PlatformApiError(
      "crm due queue: VALIDATION_FAILED — the filter is not valid: limit must be between 1 and 200",
      422,
    );
    withMeta.mockRejectedValue(error);
    const { fetchDueQueue } = await import("./crm-queues");
    await expect(fetchDueQueue({}, 999)).rejects.toBe(error);
  });
});
