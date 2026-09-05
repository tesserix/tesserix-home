import { describe, expect, it } from "vitest";
import { isLive, state, targeting, type Announcement } from "./announcements";

const base: Announcement = {
  id: "a1", title: "t", body: "b", severity: "info",
  starts_at: "2026-09-01T00:00:00Z", ends_at: null,
  audience_filter: {}, is_published: true, updated_at: "2026-09-01T00:00:00Z",
};
const NOW = new Date("2026-09-05T12:00:00Z");

describe("state", () => {
  it("separates the four states an operator scans for", () => {
    expect(state({ ...base, is_published: false }, NOW)).toBe("draft");
    expect(state({ ...base, starts_at: "2026-09-09T00:00:00Z" }, NOW)).toBe("scheduled");
    expect(state({ ...base, ends_at: "2026-09-02T00:00:00Z" }, NOW)).toBe("ended");
    expect(state(base, NOW)).toBe("live");
  });

  it("calls an unpublished future announcement a draft, not scheduled", () => {
    // Scheduling something that was never published would read as "this will
    // go out on Tuesday" when nothing will.
    expect(state({ ...base, is_published: false, starts_at: "2026-09-09T00:00:00Z" }, NOW)).toBe("draft");
  });
});

describe("isLive", () => {
  it("agrees with the API's three conditions", () => {
    expect(isLive(base, NOW)).toBe(true);
    expect(isLive({ ...base, is_published: false }, NOW)).toBe(false);
    expect(isLive({ ...base, starts_at: "2026-09-09T00:00:00Z" }, NOW)).toBe(false);
    expect(isLive({ ...base, ends_at: "2026-09-02T00:00:00Z" }, NOW)).toBe(false);
  });

  it("treats a null end as running indefinitely rather than as ended", () => {
    expect(isLive({ ...base, ends_at: null }, NOW)).toBe(true);
  });
});

describe("targeting", () => {
  it("reads the two keys the query matches on", () => {
    expect(targeting({ products: ["mark8ly"], statuses: ["active"] }))
      .toEqual({ products: ["mark8ly"], statuses: ["active"] });
  });

  it("reads an absent key as untargeted, matching the query's NULL branch", () => {
    // `audience_filter->'products' IS NULL` means EVERY product. Reading it as
    // "no products" would render an estate-wide broadcast as reaching nobody.
    expect(targeting({})).toEqual({ products: [], statuses: [] });
  });

  it("ignores a filter key it does not know rather than failing", () => {
    // The schema is "intentionally permissive so we can grow filters without a
    // migration"; a console that threw on an unknown key would make growing
    // one a breaking change.
    expect(targeting({ products: ["mark8ly"], tags: ["beta"] }).products).toEqual(["mark8ly"]);
  });

  it("drops non-string entries rather than rendering them", () => {
    expect(targeting({ products: ["mark8ly", 42, null] }).products).toEqual(["mark8ly"]);
  });
});
