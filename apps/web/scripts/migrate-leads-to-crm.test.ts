import { describe, expect, it } from "vitest";
import {
  organisationName,
  mapStage,
  mapActivityKind,
  mapLead,
  findContactKeyCollisions,
  describeCollision,
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

/** The shape `planMigration` hands the collision check: the raw lead beside
 *  its mapped form. Built through `mapLead` rather than by hand so the test
 *  exercises the same normalisation the migration actually applies. */
interface SeedLead {
  id: string;
  status: string;
  company?: string | null;
  name?: string | null;
  email?: string | null;
  instagram_handle?: string | null;
}

function planned(lead: SeedLead) {
  return { lead, mapped: mapLead(lead) };
}

describe("pre-flight contact key collisions", () => {
  it("catches two leads whose handles differ only by a leading @", () => {
    // The exact live-data case: `leads` has a unique index on
    // `lower(instagram_handle)`, so these two coexist happily at source and
    // only become one identity once this script normalises them.
    const collisions = findContactKeyCollisions([
      planned({ id: "lead-1", company: "A", status: "new", instagram_handle: "@bondibaker" }),
      planned({ id: "lead-2", company: "B", status: "new", instagram_handle: "bondibaker" }),
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0].field).toBe("instagram_handle");
    expect(collisions[0].key).toBe("bondibaker");
    expect(collisions[0].leads.map((entry: { id: string }) => entry.id)).toEqual(["lead-1", "lead-2"]);
  });

  it("catches a lead colliding with a contact already in crm_contacts", () => {
    // This is the one that made the old per-row handling non-convergent:
    // `crm_contacts` has a UNIQUE index on `lower(email)`, so this INSERT
    // fails identically on every re-run. Re-running is not the fix; fixing
    // the source row is, and only a pre-flight refusal can say so.
    const collisions = findContactKeyCollisions(
      [planned({ id: "lead-1", company: "A", status: "new", email: "priya@bondibaker.example" })],
      [{ id: "contact-9", email: "Priya@BondiBaker.example", instagram_handle: null }],
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0].field).toBe("email");
    expect(collisions[0].existing.map((entry: { id: string }) => entry.id)).toEqual(["contact-9"]);
  });

  it("reports the raw values and ids, not just the normalised key", () => {
    // A human cannot act on "bondibaker collides". They can act on which
    // two rows, and what each one actually stores.
    const [collision] = findContactKeyCollisions([
      planned({ id: "lead-1", company: "A", status: "new", instagram_handle: "@BondiBaker" }),
      planned({ id: "lead-2", company: "B", status: "new", instagram_handle: "bondibaker" }),
    ]);
    const text = describeCollision(collision).join("\n");

    expect(text).toContain("lead-1");
    expect(text).toContain("@BondiBaker");
    expect(text).toContain("lead-2");
  });

  it("passes a clean run, and does not collide two leads that both have no email", () => {
    // Instagram-sourced leads have been email-less since 0007. A null key is
    // not a shared key — treating it as one would refuse every real run.
    expect(
      findContactKeyCollisions([
        planned({ id: "lead-1", company: "A", status: "new", instagram_handle: "one" }),
        planned({ id: "lead-2", company: "B", status: "new", instagram_handle: "two" }),
      ]),
    ).toEqual([]);
  });

  it("ignores two pre-existing contacts colliding with each other", () => {
    // Not this migration's doing and not something re-running it can fix;
    // blocking on it would hold the backfill hostage to unrelated data.
    expect(
      findContactKeyCollisions(
        [planned({ id: "lead-1", company: "A", status: "new", instagram_handle: "unrelated" })],
        [
          { id: "contact-1", email: null, instagram_handle: "@dup" },
          { id: "contact-2", email: null, instagram_handle: "dup" },
        ],
      ),
    ).toEqual([]);
  });
});
