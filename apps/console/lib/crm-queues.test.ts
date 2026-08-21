import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/crm-repo", () => ({
  dueOpportunities: vi.fn().mockResolvedValue({
    rows: [], total: 1, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
  driftingOpportunities: vi.fn().mockResolvedValue({
    rows: [], total: 2, precedingCount: 0, nextCursor: null, previousCursor: null,
  }),
  setNextAction: vi.fn().mockResolvedValue(undefined),
}));

const withMeta = vi.fn();
vi.mock("@/lib/platform-api", () => ({
  platformApiOrigin: () => process.env.PLATFORM_API_ORIGIN?.trim() || null,
  platformRequestWithMeta: (...args: unknown[]) => withMeta(...args),
}));

describe("crm-queues dual path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PLATFORM_API_ORIGIN;
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
});
