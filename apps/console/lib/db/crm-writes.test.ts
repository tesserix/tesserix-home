import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit coverage for `crm-writes.ts` — the statements it issues and the
 * refusals it makes before issuing any.
 *
 * The rollback and constraint guarantees are proven against a real database
 * in `crm-writes.integration.test.ts`; what belongs here is the SQL shape and
 * the parameters, which a mocked query can pin exactly.
 */

const query = vi.fn();
vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => query(...args),
  // Same shape `crm-repo.test.ts` uses: `tesserixTx` hands its callback a
  // client-scoped query, and the mock funnels transactional and plain calls
  // through one spy so a test can assert the whole SELECT/UPDATE/INSERT
  // sequence in order.
  tesserixTx: (fn: (query: (...args: unknown[]) => unknown) => unknown) => fn(query),
  isDatabaseConfigured: () => true,
}));

const { updateOrganisation } = await import("./crm-writes");

/** The current row `SELECT ... FOR UPDATE` returns, unless a test overrides. */
const CURRENT = {
  name: "Bondi Baker",
  location: "Sydney",
  website_url: "https://bondi.example",
  category: ["bakery"],
  tags: ["warm"],
};

const UNCHANGED_INPUT = {
  organisationId: "g1",
  actor: "ops@tesserix.app",
  name: "Bondi Baker",
  location: "Sydney",
  websiteUrl: "https://bondi.example",
  category: ["bakery"],
  tags: ["warm"],
};

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue([{ ...CURRENT }]);
});

describe("updateOrganisation", () => {
  it("rejects a blank name before touching the database", async () => {
    await expect(
      updateOrganisation({ ...UNCHANGED_INPUT, name: "   " }),
    ).rejects.toThrow(/name/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unsafe website url before touching the database", async () => {
    await expect(
      updateOrganisation({ ...UNCHANGED_INPUT, websiteUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/websiteUrl/);
    expect(query).not.toHaveBeenCalled();
  });

  it("locks the current row before diffing it", async () => {
    await updateOrganisation(UNCHANGED_INPUT);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE/);
    expect(params).toEqual(["g1"]);
  });

  it("throws when the organisation does not exist", async () => {
    query.mockResolvedValue([]);
    await expect(updateOrganisation(UNCHANGED_INPUT)).rejects.toThrow(/not found/i);
  });

  it("writes nothing at all when nothing changed", async () => {
    // A no-op save must not forge an audit trail entry: the timeline is read
    // as the record of what happened to this business, and "someone opened
    // the form and pressed save" did not happen to it.
    const { changed } = await updateOrganisation(UNCHANGED_INPUT);
    expect(changed).toEqual([]);
    // One statement only: the locking SELECT. No UPDATE, no activity row.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT/);
  });

  it("treats an equal-after-normalisation edit as a no-op", async () => {
    // Whitespace and a duplicated tag are not a change to the record.
    const { changed } = await updateOrganisation({
      ...UNCHANGED_INPUT,
      name: "  Bondi Baker  ",
      tags: ["warm", " warm ", "  "],
    });
    expect(changed).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("re-derives country from the new location", async () => {
    // #232 filters the follow-up queue by country; an edit that leaves
    // `country` on the old location silently mis-files the organisation.
    await updateOrganisation({ ...UNCHANGED_INPUT, location: "Delhi" });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/country\s*=/);
    expect(params).toEqual([
      "g1",
      "Bondi Baker",
      "Delhi",
      "IN",
      "https://bondi.example",
      ["bakery"],
      ["warm"],
    ]);
  });

  it("clears country when the location is cleared", async () => {
    await updateOrganisation({ ...UNCHANGED_INPUT, location: "   " });
    const [, params] = query.mock.calls[1];
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
  });

  it("stamps updated_at by hand — there is no trigger on the table", async () => {
    await updateOrganisation({ ...UNCHANGED_INPUT, name: "Bondi Bakery" });
    expect(query.mock.calls[1][0]).toMatch(/updated_at\s*=\s*now\(\)/);
  });

  it("normalises category and tags: trims, drops blanks, dedupes, keeps order", async () => {
    await updateOrganisation({
      ...UNCHANGED_INPUT,
      category: [" cafe ", "bakery", "cafe", "   "],
      tags: [],
    });
    const [, params] = query.mock.calls[1];
    expect(params[5]).toEqual(["cafe", "bakery"]);
    expect(params[6]).toEqual([]);
  });

  it("stores an empty website url as NULL, not an empty string", async () => {
    await updateOrganisation({ ...UNCHANGED_INPUT, websiteUrl: "  " });
    expect(query.mock.calls[1][1][4]).toBeNull();
  });

  it("never writes converted_* — linkConversion stays the single writer", async () => {
    // `crm_org_conversion_complete` requires converted_ref and
    // converted_product travel together; an edit form has no business
    // touching either.
    await updateOrganisation({ ...UNCHANGED_INPUT, name: "Bondi Bakery" });
    expect(query.mock.calls[1][0]).not.toMatch(/converted_/);
  });

  it("records the diff as one activity row in the same transaction", async () => {
    const { changed } = await updateOrganisation({
      ...UNCHANGED_INPUT,
      name: "Bondi Bakery",
      location: "Delhi",
    });
    expect(changed).toEqual([
      { field: "name", from: "Bondi Baker", to: "Bondi Bakery" },
      { field: "location", from: "Sydney", to: "Delhi" },
    ]);

    expect(query).toHaveBeenCalledTimes(3);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO crm_activities/);
    expect(sql).toMatch(/'note'/);
    expect(params[0]).toBe("g1");
    // The actor comes from the caller — the writer never invents one.
    expect(params[1]).toBe("ops@tesserix.app");
    expect(params[2]).toMatch(/name/);
    expect(params[2]).toMatch(/location/);
    expect(JSON.parse(params[3] as string)).toEqual({
      name: { from: "Bondi Baker", to: "Bondi Bakery" },
      location: { from: "Sydney", to: "Delhi" },
    });
  });
});
