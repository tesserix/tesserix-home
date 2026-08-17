import { describe, expect, it } from "vitest";
import {
  organisationName,
  mapStage,
  mapActivityKind,
  mapLead,
} from "./migrate-leads-to-crm.mjs";

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

  it("maps status_change to stage_change — the old vocabulary named the event after the field, not the fact", () => {
    expect(mapActivityKind("status_change")).toBe("stage_change");
  });

  it("passes every other activity kind through unchanged", () => {
    expect(mapActivityKind("note")).toBe("note");
    expect(mapActivityKind("dm_sent")).toBe("dm_sent");
    expect(mapActivityKind("call")).toBe("call");
  });

  it("rejects an activity kind it doesn't recognize rather than guessing", () => {
    expect(() => mapActivityKind("smoke_signal")).toThrow();
  });

  it("never sets a product on a migrated opportunity — a migrated lead was never matched to one", () => {
    const lead = {
      id: "lead-1",
      company: "Bondi Baker",
      name: null,
      instagram_handle: null,
      status: "qualified", // stage that would require a product on a non-migrated row
      created_at: new Date("2026-01-01"),
    };
    const { opportunity } = mapLead(lead);
    expect(opportunity.product).toBeNull();
  });
});
