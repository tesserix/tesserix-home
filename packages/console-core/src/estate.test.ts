import { describe, expect, it } from "vitest";
import { ESTATE, unmigrated } from "./estate";
import { koraNav } from "./nav";

describe("estate", () => {
  it("lists every rail context apps/web defines", () => {
    // apps/web's RailContext union, as of 2026-08-15. If a product is added
    // there and not here, the console's estate view silently omits it.
    expect(ESTATE.map((p) => p.context).sort()).toEqual([
      "devai",
      "dwellm8",
      "homechef",
      "kora",
      "mark8ly",
      "platform",
    ]);
  });

  it("keeps Kora's entry count honest against the nav it actually ships", () => {
    // Kora is the one migrated product, so its count is checkable rather than
    // transcribed — this is the entry that would rot first if koraNav changed.
    const kora = ESTATE.find((p) => p.context === "kora");
    expect(kora?.entries).toBe(koraNav.length);
  });

  it("reports exactly one product as migrated today", () => {
    expect(ESTATE.filter((p) => p.migrated).map((p) => p.name)).toEqual(["Kora"]);
    expect(unmigrated()).toHaveLength(5);
  });

  it("separates display name from rail context", () => {
    // Fe3dr is the case that breaks a naive "name === context" assumption.
    const fe3dr = ESTATE.find((p) => p.name === "Fe3dr");
    expect(fe3dr?.context).toBe("homechef");
  });
});
