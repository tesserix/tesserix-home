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

  it("normalises the contact's email and handle exactly as the app's lookups do", () => {
    // A stored `@BondiBaker` can never match `findMatchingOrganisationId`'s
    // normalised lookup, so the next import would create the organisation a
    // second time — the duplication that function exists to prevent.
    const { contact } = mapLead({
      id: "lead-1",
      company: "Bondi Baker",
      status: "new",
      email: "  Ava@Example.COM ",
      instagram_handle: " @@BondiBaker ",
      created_at: new Date("2026-01-01"),
    });
    expect(contact.email).toBe("ava@example.com");
    expect(contact.instagram_handle).toBe("bondibaker");
  });

  it("normalises a whitespace-only contact key to null rather than an empty string", () => {
    const { contact } = mapLead({
      id: "lead-1",
      company: "Bondi Baker",
      status: "new",
      email: "   ",
      instagram_handle: "@",
      created_at: new Date("2026-01-01"),
    });
    expect(contact.email).toBeNull();
    expect(contact.instagram_handle).toBeNull();
  });

  it("preserves the lead's created_at on all three rows", () => {
    const createdAt = new Date("2025-03-04T05:06:07Z");
    const { organisation, contact, opportunity } = mapLead({
      id: "lead-1",
      company: "Bondi Baker",
      status: "new",
      created_at: createdAt,
    });
    expect(organisation.created_at).toBe(createdAt);
    expect(contact.created_at).toBe(createdAt);
    expect(opportunity.created_at).toBe(createdAt);
  });

  it("gives a migrated won/lost deal a closed_at so it does not sort last in the handoff queue", () => {
    const createdAt = new Date("2025-03-04T00:00:00Z");
    const lastContacted = new Date("2025-06-01T00:00:00Z");

    const won = mapLead({
      id: "lead-1",
      company: "Bondi Baker",
      status: "converted",
      created_at: createdAt,
      last_contacted_at: lastContacted,
    });
    expect(won.opportunity.closed_at).toBe(lastContacted);

    const lost = mapLead({
      id: "lead-2",
      company: "Bondi Baker",
      status: "lost",
      created_at: createdAt,
    });
    expect(lost.opportunity.closed_at).toBe(createdAt);

    const open = mapLead({
      id: "lead-3",
      company: "Bondi Baker",
      status: "contacted",
      created_at: createdAt,
      last_contacted_at: lastContacted,
    });
    expect(open.opportunity.closed_at).toBeNull();
  });
});
