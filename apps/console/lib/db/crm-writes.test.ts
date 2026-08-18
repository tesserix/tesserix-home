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

const { updateOrganisation, createContact, createOrganisation, DuplicateContactError } =
  await import("./crm-writes");

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

/**
 * A duplicate contact must say so.
 *
 * `crm_contacts_email_lower_uq` / `crm_contacts_instagram_lower_uq` are the
 * two indexes an everyday second attempt trips. Detection is on the Postgres
 * error's `code` and `constraint` fields, never its message: the message is
 * wording, not contract, and a driver or server that phrases it differently
 * would silently turn this into the generic failure again.
 */
function uniqueViolation(constraint: string, code = "23505"): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code, constraint },
  );
}

describe("createContact and the contact unique indexes", () => {
  const INPUT = { organisationId: "g1", email: "ada@example.com" };

  beforeEach(() => {
    query.mockReset();
    // First statement of the transaction is the suppression check; an empty
    // result means "not on the list", so the INSERT is reached.
    query.mockResolvedValueOnce([]);
  });

  /** Resolves with whatever `createContact` threw. */
  async function rejection(error: Error): Promise<unknown> {
    query.mockRejectedValueOnce(error);
    return createContact(INPUT).then(
      () => {
        throw new Error("expected createContact to reject");
      },
      (cause: unknown) => cause,
    );
  }

  it("names the email when crm_contacts_email_lower_uq rejects the insert", async () => {
    const cause = await rejection(uniqueViolation("crm_contacts_email_lower_uq"));
    expect(cause).toBeInstanceOf(DuplicateContactError);
    expect((cause as InstanceType<typeof DuplicateContactError>).key).toBe("email");
    expect((cause as Error).message).toMatch(/already/i);
    expect((cause as Error).message).toMatch(/email/i);
  });

  it("names the handle when crm_contacts_instagram_lower_uq rejects the insert", async () => {
    const cause = await rejection(uniqueViolation("crm_contacts_instagram_lower_uq"));
    expect(cause).toBeInstanceOf(DuplicateContactError);
    expect((cause as InstanceType<typeof DuplicateContactError>).key).toBe("instagramHandle");
    expect((cause as Error).message).toMatch(/already/i);
    expect((cause as Error).message).toMatch(/instagram handle/i);
  });

  it("never says which organisation already holds the contact", async () => {
    // A different tenant's record. The operator learns that the key is taken
    // and nothing else — naming the holder is disclosure, not help.
    const cause = await rejection(uniqueViolation("crm_contacts_email_lower_uq"));
    expect(cause).toBeInstanceOf(DuplicateContactError);
    expect((cause as Error).message).not.toMatch(/g1/);
  });

  it("leaves a 23505 on any other constraint alone", async () => {
    // Only the two contact-identity indexes mean "this contact already
    // exists". Translating every unique violation would put that sentence in
    // front of an operator who hit something else entirely.
    const cause = await rejection(uniqueViolation("crm_opportunities_pkey"));
    expect(cause).not.toBeInstanceOf(DuplicateContactError);
  });

  it("leaves a non-23505 error alone even when it names one of the indexes", async () => {
    // 23503 is a foreign-key violation — a bad `organisation_id`, not a
    // duplicate. The code is what decides; the constraint name only narrows.
    const cause = await rejection(uniqueViolation("crm_contacts_email_lower_uq", "23503"));
    expect(cause).not.toBeInstanceOf(DuplicateContactError);
  });

  it("survives a thrown non-object and re-throws it unchanged", async () => {
    // The inspection reads `code`/`constraint` off the cause. A rejection
    // that is not an object at all must pass straight through, not become a
    // TypeError raised inside the error path itself.
    query.mockRejectedValueOnce(null);
    const cause = await createContact(INPUT).then(
      () => {
        throw new Error("expected createContact to reject");
      },
      (error: unknown) => error,
    );
    expect(cause).toBeNull();
  });

  it("translates the same collision on the new-organisation path", async () => {
    // `createOrganisation`'s first contact goes through the same insert, so
    // both manual-create doors get the same sentence.
    query.mockResolvedValueOnce([{ id: "org-1" }]);
    query.mockRejectedValueOnce(uniqueViolation("crm_contacts_email_lower_uq"));
    await expect(
      createOrganisation({ name: "Dup Co", contact: { email: "ada@example.com" } }),
    ).rejects.toBeInstanceOf(DuplicateContactError);
  });
});
