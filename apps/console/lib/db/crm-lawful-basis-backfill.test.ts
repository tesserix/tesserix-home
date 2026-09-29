import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the #248 backfill: which rows it selects, which it
 * refuses to touch, and how it reports a run that did not fully succeed.
 */

const tesserixQuery = vi.fn();
const setLawfulBasis = vi.fn();

vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => tesserixQuery(...args),
  isDatabaseConfigured: () => true,
}));
vi.mock("./crm-writes", () => ({
  setLawfulBasis: (...args: unknown[]) => setLawfulBasis(...args),
}));

const { backfillLawfulBasis } = await import("./crm-lawful-basis-backfill");

const OPTIONS = {
  basis: "legitimate_interests",
  actor: "ops@tesserix.app",
  dryRun: false,
} as const;

beforeEach(() => {
  tesserixQuery.mockReset();
  setLawfulBasis.mockReset();
  tesserixQuery.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
  setLawfulBasis.mockResolvedValue({ changed: [{ field: "lawfulBasis" }] });
});

describe("backfillLawfulBasis", () => {
  // Both halves of the WHERE matter and neither is incidental: the marker is
  // what makes a human's existing determination safe from this job, and
  // `erased_at IS NULL` is what stops it asserting a justification for
  // holding data somebody asked to have destroyed.
  it("selects only unerased rows still holding the legacy marker", async () => {
    await backfillLawfulBasis(OPTIONS);

    const [sql, params] = tesserixQuery.mock.calls[0];
    expect(sql).toMatch(/lawful_basis = \$1/);
    expect(sql).toMatch(/erased_at IS NULL/);
    expect(params).toEqual(["not_recorded_pre_migration"]);
  });

  it("writes through setLawfulBasis so every row lands on a timeline", async () => {
    const result = await backfillLawfulBasis(OPTIONS);

    expect(setLawfulBasis).toHaveBeenCalledTimes(2);
    expect(setLawfulBasis).toHaveBeenCalledWith({
      contactId: "c1",
      lawfulBasis: "legitimate_interests",
      actor: "ops@tesserix.app",
    });
    expect(result).toEqual({ candidates: 2, changed: 2, failures: [] });
  });

  // The safe invocation has to be the one that writes nothing, because the
  // failure mode is a compliance record that confidently states something
  // untrue across every migrated contact at once.
  it("writes nothing on a dry run but still reports what it would touch", async () => {
    const result = await backfillLawfulBasis({ ...OPTIONS, dryRun: true });

    expect(setLawfulBasis).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 2, changed: 0, failures: [] });
  });

  // One bad row must not strand the rest halfway through a compliance
  // backfill — but the run must not then report itself as clean either.
  it("continues past a failing row and reports it", async () => {
    setLawfulBasis
      .mockRejectedValueOnce(new Error("contact c1 not found"))
      .mockResolvedValueOnce({ changed: [{ field: "lawfulBasis" }] });

    const result = await backfillLawfulBasis(OPTIONS);

    expect(result.changed).toBe(1);
    expect(result.failures).toEqual([{ contactId: "c1", message: "contact c1 not found" }]);
  });

  // A re-run finds rows the previous run already moved only if it crashed
  // mid-way; either way an unchanged row must not inflate the count.
  it("does not count a row setLawfulBasis reported as unchanged", async () => {
    setLawfulBasis.mockResolvedValue({ changed: [] });

    const result = await backfillLawfulBasis(OPTIONS);

    expect(result).toEqual({ candidates: 2, changed: 0, failures: [] });
  });

  it("applies a limit so a run can be rehearsed on a handful", async () => {
    await backfillLawfulBasis({ ...OPTIONS, limit: 5 });

    const [sql] = tesserixQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT 5/);
  });
});
