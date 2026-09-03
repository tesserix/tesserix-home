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

const {
  updateOrganisation,
  updateContact,
  setPrimaryContact,
  createContact,
  createOrganisation,
  DuplicateContactError,
} = await import("./crm-writes");

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

/**
 * #236: the handle the application checks against the do-not-contact list
 * and the handle it hands to the INSERT have to be the same string.
 *
 * Asserted on the parameters `insertContact` passes, not on a row read back:
 * migration 0023's `crm_contacts_normalize()` trigger already normalises on
 * write, so a read-back assertion would pass whether or not the application
 * normalises — it would be testing the trigger. Pinning the parameter is
 * what stops the trigger being load-bearing.
 */
describe("createContact and the instagram handle it hands to the INSERT", () => {
  /** Parameters of the INSERT — call 0 is the suppression check. */
  async function insertParams(instagramHandle: string): Promise<unknown[]> {
    query.mockReset();
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([{ id: "c1" }]);
    await createContact({ organisationId: "g1", instagramHandle });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO crm_contacts/);
    return params as unknown[];
  }

  it("strips a leading @ and lowercases before the insert", async () => {
    expect((await insertParams("@BondiBaker"))[4]).toBe("bondibaker");
  });

  it("hands the insert the same string the suppression check used", async () => {
    query.mockReset();
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([{ id: "c1" }]);
    await createContact({ organisationId: "g1", instagramHandle: " @@BondiBaker " });
    const checkParams = query.mock.calls[0][1] as unknown[];
    const insertedHandle = (query.mock.calls[1][1] as unknown[])[4];
    // Whatever form the check keyed on is the form that gets stored.
    expect(checkParams).toContain(insertedHandle);
  });

  it("still stores null for an absent or blank handle", async () => {
    expect((await insertParams("   "))[4]).toBeNull();
  });
});


/** The contact row `SELECT … FOR UPDATE` returns, unless a test overrides. */
const CURRENT_CONTACT = {
  organisation_id: "g1",
  name: "Priya",
  email: "priya@bondibaker.example",
  phone: null,
  instagram_handle: "bondibaker",
};

const UNCHANGED_CONTACT = {
  contactId: "c1",
  actor: "ops@tesserix.app",
  name: "Priya",
  email: "priya@bondibaker.example",
  phone: null,
  instagramHandle: "bondibaker",
};

describe("updateContact", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([CURRENT_CONTACT]);
  });

  it("locks the current row before diffing it", async () => {
    await updateContact(UNCHANGED_CONTACT);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE/);
    expect(params).toEqual(["c1"]);
  });

  it("throws when the contact does not exist", async () => {
    query.mockResolvedValue([]);
    await expect(updateContact(UNCHANGED_CONTACT)).rejects.toThrow(/c1/);
  });

  // The organisation edit's rule, and for the same reason: opening the form
  // and pressing save did not happen to this business, so the timeline must
  // not claim it did.
  it("writes nothing at all when nothing changed", async () => {
    const { changed } = await updateContact(UNCHANGED_CONTACT);

    expect(changed).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1); // the SELECT, and nothing after it
  });

  it("updates the changed field and records a per-field diff on the timeline", async () => {
    const { changed } = await updateContact({
      ...UNCHANGED_CONTACT,
      email: "priya@newdomain.example",
    });

    expect(changed).toEqual([
      { field: "email", from: "priya@bondibaker.example", to: "priya@newdomain.example" },
    ]);

    const [updateSql] = query.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE crm_contacts/);

    const [activitySql, activityParams] = query.mock.calls[2];
    expect(activitySql).toMatch(/INSERT INTO crm_activities/);
    expect(activityParams[2]).toBe("Edited email");
    expect(JSON.parse(activityParams[3] as string)).toEqual({
      email: { from: "priya@bondibaker.example", to: "priya@newdomain.example" },
    });
  });

  // A correction is not contact. `logActivity` bumps `last_contacted_at` and
  // runs the suppression check; borrowing it here would make fixing a typo
  // look like an outbound touch and reset the follow-up clock.
  it("writes the activity row directly, so a correction is not a touch", async () => {
    await updateContact({ ...UNCHANGED_CONTACT, name: "Priya S" });

    const [activitySql] = query.mock.calls[2];
    expect(activitySql).not.toMatch(/last_contacted_at/);
  });

  // #236: the string stored must be the string `isSuppressed` keys its check
  // on, or an edited handle silently escapes the do-not-contact list. The
  // contract is exactly `normalizeInstagramHandle`'s — trim, strip leading
  // `@`, lowercase — and this asserts update applies the same one as insert,
  // not a richer one it invented.
  it("normalises an Instagram handle on update, as the insert path does", async () => {
    // The handle must actually differ from the stored one, or the diff is
    // empty and there is no UPDATE to inspect — which is itself the point of
    // normalising before diffing: re-submitting `@BondiBaker` over a stored
    // `bondibaker` is not a change, and must not write a timeline entry
    // saying it was.
    await updateContact({ ...UNCHANGED_CONTACT, instagramHandle: "  @BondiBakerHQ  " });

    const [, params] = query.mock.calls[1];
    expect(params).toContain("bondibakerhq");
  });

  it("treats a differently-cased resubmission of the same handle as no change", async () => {
    const { changed } = await updateContact({
      ...UNCHANGED_CONTACT,
      instagramHandle: "@BondiBaker",
    });

    expect(changed).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("lowercases and trims an edited email, as the insert path does", async () => {
    await updateContact({ ...UNCHANGED_CONTACT, email: "  Priya@NewDomain.Example " });

    const [, params] = query.mock.calls[1];
    expect(params).toContain("priya@newdomain.example");
  });

  // #237's message, not a generic failure: an operator who has just typed an
  // address that is already in the CRM needs to be told to search for it.
  it("raises DuplicateContactError when an edited email collides", async () => {
    query.mockImplementation((sql: string) => {
      if (String(sql).includes("FOR UPDATE")) return Promise.resolve([CURRENT_CONTACT]);
      if (String(sql).includes("UPDATE crm_contacts")) {
        return Promise.reject(
          Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "crm_contacts_email_lower_uq",
          }),
        );
      }
      return Promise.resolve([]);
    });

    await expect(
      updateContact({ ...UNCHANGED_CONTACT, email: "taken@example.com" }),
    ).rejects.toBeInstanceOf(DuplicateContactError);
  });

  // A 23505 on some other constraint is a different fact and must not borrow
  // the "search for it rather than adding a second one" sentence.
  it("re-throws a collision on any other constraint untouched", async () => {
    query.mockImplementation((sql: string) => {
      if (String(sql).includes("FOR UPDATE")) return Promise.resolve([CURRENT_CONTACT]);
      if (String(sql).includes("UPDATE crm_contacts")) {
        return Promise.reject(
          Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "some_other_uq",
          }),
        );
      }
      return Promise.resolve([]);
    });

    await expect(
      updateContact({ ...UNCHANGED_CONTACT, email: "taken@example.com" }),
    ).rejects.not.toBeInstanceOf(DuplicateContactError);
  });
});

describe("setPrimaryContact", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([{ organisation_id: "g1", is_primary: false, name: "Priya" }]);
  });

  // Two primaries would make `primaryContactOrder`'s `is_primary DESC` tiebreak
  // arbitrary across the seven queries that share it — the browse list and the
  // follower-band filter could then disagree about who the primary is.
  it("demotes the siblings in the same statement sequence as the promotion", async () => {
    await setPrimaryContact({ contactId: "c2", actor: "ops@tesserix.app" });

    const sql = query.mock.calls.map(([s]) => String(s)).join("\n");
    expect(sql).toMatch(/is_primary = false/);
    expect(sql).toMatch(/is_primary = true/);
  });

  it("writes nothing when the contact is already primary", async () => {
    query.mockResolvedValue([{ organisation_id: "g1", is_primary: true, name: "Priya" }]);

    await setPrimaryContact({ contactId: "c1", actor: "ops@tesserix.app" });

    expect(query).toHaveBeenCalledTimes(1); // the SELECT, and nothing after it
  });

  it("records the promotion on the timeline", async () => {
    await setPrimaryContact({ contactId: "c2", actor: "ops@tesserix.app" });

    const activity = query.mock.calls.find(([s]) =>
      String(s).includes("INSERT INTO crm_activities"),
    );
    expect(activity, "a promotion that left no trace").toBeDefined();
  });
});
