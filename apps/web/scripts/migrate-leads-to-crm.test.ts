import { describe, expect, it } from "vitest";
import { organisationName, mapStage } from "./migrate-leads-to-crm.mjs";

describe("lead → crm mapping", () => {
  it("names the organisation from company, then name, then handle", () => {
    expect(organisationName({ company: "Bondi Baker", name: "Ava", instagram_handle: "bondibaker" })).toBe("Bondi Baker");
    expect(organisationName({ company: null, name: "Ava", instagram_handle: "bondibaker" })).toBe("Ava");
    expect(organisationName({ company: null, name: null, instagram_handle: "bondibaker" })).toBe("bondibaker");
  });

  it("maps converted to won", () => {
    // The old vocabulary conflated the stage with what it produced.
    expect(mapStage("converted")).toBe("won");
    expect(mapStage("qualified")).toBe("qualified");
  });

  it("refuses a lead it cannot name rather than inventing one", () => {
    // Guards the guard: a fallback of "" would let unnamed rows through and
    // produce organisations nobody can identify.
    expect(() => organisationName({ company: null, name: null, instagram_handle: null })).toThrow();
  });
});
