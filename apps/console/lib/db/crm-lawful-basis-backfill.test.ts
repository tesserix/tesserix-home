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

  // ── Correcting a basis that was recorded wrongly (the DPDP relabel) ──

  // `from` is what lets the job read a cohort by a real basis rather than
  // only by the legacy marker. Without it the 259 Indian contacts — already
  // moved to `legitimate_interests` by #248 — are invisible to this job.
  it("selects by the basis named in `from` when one is given", async () => {
    await backfillLawfulBasis({
      ...OPTIONS,
      from: "legitimate_interests",
      basis: "dpdp_public_data_exempt",
    });

    const [, params] = tesserixQuery.mock.calls[0];
    expect(params).toEqual(["legitimate_interests"]);
  });

  // THE TEST THAT MATTERS MOST. `legitimate_interests` is the correct label
  // for the Australian, Canadian and European contacts, so a relabel keyed on
  // the old value alone would overwrite 175 EU/UK determinations with an
  // India-only exemption. `source` is the only thing standing between the
  // correction and that outcome.
  it("narrows to one source so a relabel cannot reach other markets", async () => {
    await backfillLawfulBasis({
      ...OPTIONS,
      from: "legitimate_interests",
      basis: "dpdp_public_data_exempt",
      source: "instagram_outreach",
    });

    const [sql, params] = tesserixQuery.mock.calls[0];
    // Table-qualified since the organisation join landed; `source` lives on
    // `crm_contacts` and `country` on `crm_organisations`.
    expect(sql).toMatch(/AND c\.source = \$2/);
    expect(params).toEqual(["legitimate_interests", "instagram_outreach"]);
  });

  it("matches every source when none is given", async () => {
    await backfillLawfulBasis(OPTIONS);

    const [sql, params] = tesserixQuery.mock.calls[0];
    expect(sql).not.toMatch(/source/);
    expect(params).toHaveLength(1);
  });

  // `setLawfulBasis` compares before writing, so this combination would
  // report "259 candidates, 0 changed" — indistinguishable from a correction
  // that had already been applied. It is an operator error and has to read
  // like one.
  it("refuses a run where `from` and `basis` are the same value", async () => {
    await expect(
      backfillLawfulBasis({ ...OPTIONS, from: "legitimate_interests" }),
    ).rejects.toThrow(/would change nothing/);

    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(setLawfulBasis).not.toHaveBeenCalled();
  });

  // `source` alone stopped separating the cohorts once the sweep imported all
  // ten markets as two batches that both landed as `source = 'import'`.
  it("narrows by organisation country, joining because contacts have none", async () => {
    await backfillLawfulBasis({
      ...OPTIONS,
      from: "legitimate_interests",
      basis: "dpdp_public_data_exempt",
      source: "import",
      country: "IN",
    });

    const [sql, params] = tesserixQuery.mock.calls[0];
    expect(sql).toMatch(/JOIN crm_organisations o ON o\.id = c\.organisation_id/);
    expect(sql).toMatch(/AND c\.source = \$2/);
    expect(sql).toMatch(/AND o\.country = \$3/);
    expect(params).toEqual(["legitimate_interests", "import", "IN"]);
  });

  // The bug a hardcoded `$2` in the country clause would cause: with no
  // `source`, country must bind to $2, not to a parameter never pushed.
  it("numbers the country placeholder from the params actually bound", async () => {
    await backfillLawfulBasis({
      ...OPTIONS,
      from: "legitimate_interests",
      basis: "dpdp_public_data_exempt",
      country: "IN",
    });

    const [sql, params] = tesserixQuery.mock.calls[0];
    expect(sql).toMatch(/AND o\.country = \$2/);
    expect(sql).not.toMatch(/c\.source/);
    expect(params).toEqual(["legitimate_interests", "IN"]);
  });

  it("still defaults to the legacy marker when `from` is omitted", async () => {
    await backfillLawfulBasis(OPTIONS);

    const [, params] = tesserixQuery.mock.calls[0];
    expect(params).toEqual(["not_recorded_pre_migration"]);
  });
});
