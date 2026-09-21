import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => query(...args),
  isDatabaseConfigured: () => true,
}));

import { funnelSummary, STALLED_LIMIT } from "./crm-funnel-repo";
import { CRM_STAGES } from "../crm";

/**
 * The funnel read's SHAPE and its SQL, asserted at the unit level.
 *
 * What this file can prove that the integration test cannot: that the counts
 * an operator reads are built by filling in the stages the database did NOT
 * mention, rather than by listing only the stages that happened to have rows.
 * A `GROUP BY` answers nothing for a stage with no deals, and a panel that
 * silently omits `lost` is indistinguishable from one reporting zero losses
 * until the day there is a loss.
 *
 * The `notVoided` assertions are here rather than only in the integration
 * test for the reason #251's own helper comment gives: the whole risk of a
 * void is a query that was missed, and a missed conjunct is visible in the
 * statement long before it is visible in a row count.
 */

function rows(overrides: { stage: string; count: string }[]) {
  return overrides;
}

beforeEach(() => {
  query.mockReset();
});

/** The two statements `funnelSummary` issues, in order. */
function settle(
  counts: { stage: string; count: string }[],
  stalled: Record<string, unknown>[] = [],
) {
  query.mockResolvedValueOnce(counts).mockResolvedValueOnce(stalled);
}

describe("funnelSummary", () => {
  it("states a count for every stage, including the ones the database never mentioned", async () => {
    settle(rows([{ stage: "new", count: "7" }]));

    const summary = await funnelSummary();

    expect(summary.counts.map((entry) => entry.stage)).toEqual([...CRM_STAGES]);
    expect(summary.counts.find((entry) => entry.stage === "new")?.count).toBe(7);
    // The four stages the GROUP BY returned nothing for.
    for (const stage of ["contacted", "qualified", "won", "lost"] as const) {
      expect(summary.counts.find((entry) => entry.stage === stage)?.count).toBe(0);
    }
  });

  it("totals only what it counted", async () => {
    settle(
      rows([
        { stage: "new", count: "7" },
        { stage: "won", count: "3" },
      ]),
    );

    const summary = await funnelSummary();

    expect(summary.total).toBe(10);
  });

  it("excludes voided deals from both reads", async () => {
    settle(rows([]));

    await funnelSummary();

    const [countsSql] = query.mock.calls[0] as [string];
    const [stalledSql] = query.mock.calls[1] as [string];
    expect(countsSql).toContain("voided_at IS NULL");
    expect(stalledSql).toContain("voided_at IS NULL");
  });

  it("asks only for open stages when listing stalled deals", async () => {
    settle(rows([]));

    await funnelSummary();

    const [stalledSql] = query.mock.calls[1] as [string];
    // "How long has this won deal been won" is not a question.
    expect(stalledSql).toContain("stage NOT IN ('won', 'lost')");
  });

  it("dates a stalled deal from its last stage change, and from creation when it has none", async () => {
    const moved = new Date("2026-09-01T00:00:00.000Z");
    const created = new Date("2026-07-04T00:00:00.000Z");
    settle(rows([]), [
      {
        id: "a",
        organisation_id: "org-a",
        organisation_name: "Moved Co",
        product: "mark8ly",
        stage: "contacted",
        owner: "Priya",
        since: moved,
      },
      {
        id: "b",
        organisation_id: "org-b",
        organisation_name: "Never Moved Co",
        product: null,
        stage: "new",
        owner: null,
        since: created,
      },
    ]);

    const summary = await funnelSummary();

    expect(summary.stalled).toHaveLength(2);
    expect(summary.stalled[0]).toMatchObject({
      id: "a",
      organisationId: "org-a",
      organisationName: "Moved Co",
      stage: "contacted",
      owner: "Priya",
      since: moved,
    });
    expect(summary.stalled[1]).toMatchObject({
      id: "b",
      product: null,
      owner: null,
      since: created,
    });
  });

  it("reads the since value out of stage_change activities, not out of any other kind", async () => {
    settle(rows([]));

    await funnelSummary();

    const [stalledSql] = query.mock.calls[1] as [string];
    expect(stalledSql).toContain("'stage_change'");
  });

  it("bounds the stalled list", async () => {
    settle(rows([]));

    await funnelSummary();

    const [, params] = query.mock.calls[1] as [string, unknown[]];
    expect(params).toContain(STALLED_LIMIT);
  });

  it("rejects rather than reporting a partial funnel when a read fails", async () => {
    query.mockRejectedValueOnce(new Error("pg down"));

    await expect(funnelSummary()).rejects.toThrow("pg down");
  });
});
