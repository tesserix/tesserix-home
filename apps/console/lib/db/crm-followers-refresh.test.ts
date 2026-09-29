import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the re-scrape reconciliation: what it matches, what it
 * refuses to create, and how it reports a run that did not fully land.
 */

const tesserixQuery = vi.fn();
const setFollowersCount = vi.fn();

vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => tesserixQuery(...args),
  isDatabaseConfigured: () => true,
}));
vi.mock("./crm-writes", () => ({
  setFollowersCount: (...args: unknown[]) => setFollowersCount(...args),
}));

const { refreshFollowerCounts, parseFollowerReadings } = await import("./crm-followers-refresh");

const OPTIONS = { actor: "ops@tesserix.app", dryRun: false } as const;

beforeEach(() => {
  tesserixQuery.mockReset();
  setFollowersCount.mockReset();
  tesserixQuery.mockResolvedValue([
    { id: "c1", instagram_handle: "krafty.knots" },
    { id: "c2", instagram_handle: "by.sud" },
  ]);
  setFollowersCount.mockResolvedValue({ changed: [{ field: "followersCount" }] });
});

describe("refreshFollowerCounts", () => {
  it("matches on the normalised handle, so @ and casing do not matter", async () => {
    const result = await refreshFollowerCounts({
      ...OPTIONS,
      readings: [
        { handle: "@Krafty.Knots", followersCount: 4054 },
        { handle: "  by.sud  ", followersCount: 1021 },
      ],
    });

    const [, params] = tesserixQuery.mock.calls[0];
    expect(params[0]).toEqual(["krafty.knots", "by.sud"]);
    expect(result.matched).toBe(2);
    expect(result.changed).toBe(2);
  });

  it("excludes erased contacts from the lookup", async () => {
    await refreshFollowerCounts({ ...OPTIONS, readings: [{ handle: "krafty.knots", followersCount: 1 }] });

    const [sql] = tesserixQuery.mock.calls[0];
    expect(sql).toMatch(/erased_at IS NULL/);
  });

  // A handle with no contact means the lead was voided, erased, or never
  // imported. Creating one here would route around the lawful basis,
  // provenance and suppression checks `commitImport` performs.
  it("reports an unmatched handle and never creates a contact", async () => {
    const result = await refreshFollowerCounts({
      ...OPTIONS,
      readings: [
        { handle: "krafty.knots", followersCount: 4054 },
        { handle: "jays_silks_and_sarees", followersCount: 2088 },
      ],
    });

    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(["jays_silks_and_sarees"]);
    expect(setFollowersCount).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on a dry run but still reports what it matched", async () => {
    const result = await refreshFollowerCounts({
      ...OPTIONS,
      dryRun: true,
      readings: [{ handle: "krafty.knots", followersCount: 4054 }],
    });

    expect(setFollowersCount).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 1, changed: 0, unmatched: [], failures: [] });
  });

  // A scrape that visited one profile twice must not write the number twice.
  it("de-duplicates repeated handles, last reading winning", async () => {
    await refreshFollowerCounts({
      ...OPTIONS,
      readings: [
        { handle: "krafty.knots", followersCount: 4000 },
        { handle: "@krafty.knots", followersCount: 4054 },
      ],
    });

    expect(setFollowersCount).toHaveBeenCalledTimes(1);
    expect(setFollowersCount).toHaveBeenCalledWith({
      contactId: "c1",
      followersCount: 4054,
      actor: "ops@tesserix.app",
    });
  });

  it("continues past a failing write and reports it", async () => {
    setFollowersCount
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({ changed: [{ field: "followersCount" }] });

    const result = await refreshFollowerCounts({
      ...OPTIONS,
      readings: [
        { handle: "krafty.knots", followersCount: 4054 },
        { handle: "by.sud", followersCount: 1021 },
      ],
    });

    expect(result.changed).toBe(1);
    expect(result.failures).toEqual([{ handle: "krafty.knots", message: "nope" }]);
  });

  it("does not count a contact whose number had not moved", async () => {
    setFollowersCount.mockResolvedValue({ changed: [] });

    const result = await refreshFollowerCounts({
      ...OPTIONS,
      readings: [{ handle: "krafty.knots", followersCount: 4054 }],
    });

    expect(result).toEqual({ matched: 1, changed: 0, unmatched: [], failures: [] });
  });

  it("does no work at all for an empty batch", async () => {
    const result = await refreshFollowerCounts({ ...OPTIONS, readings: [] });

    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ matched: 0, changed: 0, unmatched: [], failures: [] });
  });
});

describe("parseFollowerReadings", () => {
  // THE ONE THAT MATTERS. Instagram renders counts as "4,054"; splitting on
  // every comma reads that line as 4 — a silent 1000x error on exactly the
  // copy-paste this parser exists to accept.
  it("reads a thousands-separated count as one number", () => {
    expect(parseFollowerReadings("kamakshi__clothing,42,200")).toEqual([
      { handle: "kamakshi__clothing", followersCount: 42200 },
    ]);
  });

  it("keeps the @ for the normaliser downstream rather than guessing here", () => {
    expect(parseFollowerReadings("@krafty.knots,4054")).toEqual([
      { handle: "@krafty.knots", followersCount: 4054 },
    ]);
  });

  it("skips blank lines and comments so a list can carry notes", () => {
    const text = ["# tier A, 2026-09-29", "", "by.sud,1021", "   ", "# dead:", "advital,750"].join("\n");

    expect(parseFollowerReadings(text)).toEqual([
      { handle: "by.sud", followersCount: 1021 },
      { handle: "advital", followersCount: 750 },
    ]);
  });

  it.each(["krafty.knots,12abc", "krafty.knots,-5", "krafty.knots,1.5", "krafty.knots,"])(
    "refuses %s, naming the line",
    (line) => {
      expect(() => parseFollowerReadings(line)).toThrow(/line 1/);
    },
  );

  it("refuses a line with no comma at all", () => {
    expect(() => parseFollowerReadings("krafty.knots 4054")).toThrow(/line 1/);
  });
});
