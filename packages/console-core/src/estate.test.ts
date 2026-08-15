import { describe, expect, it } from "vitest";
import { ESTATE, unmigrated } from "./estate";
import { koraNav } from "./nav";

describe("estate", () => {
  it("covers every rail context apps/web defines", () => {
    // apps/web's RailContext union, as of 2026-08-15. If a product is added
    // there and not here, the console's estate view silently omits it.
    //
    // A SUBSET check, not equality: ESTATE is deliberately larger. HMS is in
    // the estate with no apps/web rail at all, which is the fact worth
    // carrying — it is the one product where console decisions can still shape
    // the product rather than retrofit it.
    const contexts = new Set(ESTATE.map((p) => p.context));
    for (const rail of [
      "devai",
      "dwellm8",
      "homechef",
      "kora",
      "mark8ly",
      "platform",
    ]) {
      expect(contexts, `apps/web rail "${rail}" missing from ESTATE`).toContain(
        rail,
      );
    }
  });

  it("carries HMS as a product with no rail yet", () => {
    // Zero entries is the point, not an oversight: HMS has no console presence.
    // Recording it as absent-with-zero rather than omitting it keeps the gap
    // visible on the estate map.
    const hms = ESTATE.find((p) => p.context === "hms");
    expect(hms).toBeDefined();
    expect(hms?.entries).toBe(0);
    expect(hms?.migrated).toBe(false);
  });

  it("keeps Kora's entry count honest against the nav it actually ships", () => {
    // Kora is the one migrated product, so its count is checkable rather than
    // transcribed — this is the entry that would rot first if koraNav changed.
    const kora = ESTATE.find((p) => p.context === "kora");
    expect(kora?.entries).toBe(koraNav.length);
  });

  it("reports exactly one product as migrated today", () => {
    expect(ESTATE.filter((p) => p.migrated).map((p) => p.name)).toEqual(["Kora"]);
    // Derived from ESTATE rather than hardcoded: a count that has to be edited
    // every time a product is added is a count that gets edited without being
    // read, which is how the DevAI and Dwellm8 summaries went stale.
    expect(unmigrated()).toHaveLength(ESTATE.length - 1);
  });

  it("separates display name from rail context", () => {
    // Fe3dr is the case that breaks a naive "name === context" assumption.
    const fe3dr = ESTATE.find((p) => p.name === "Fe3dr");
    expect(fe3dr?.context).toBe("homechef");
  });
});
