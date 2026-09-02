import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `recordTemplatedDm`'s ORDER and its STATEMENTS, asserted at the unit level.
 *
 * Why this file exists alongside `crm-outreach.integration.test.ts`: that file
 * is the constraint-2 proof, and it proves what ended up in the table. This one
 * proves things a finished table cannot show — that the suppression check ran
 * BEFORE the insert rather than merely before the commit, and that the stage
 * move went through `advanceStageOnQuery` rather than a hand-written UPDATE
 * that happened to produce the same rows.
 *
 * The lesson this is written against is Task 6's: a mutation that moved the
 * suppression check AFTER the render left every return-value assertion green,
 * and only a call-ordering assertion caught it. A transaction that rolls back
 * makes the ordering invisible in the final table too, so the same blind spot
 * applies here with more force — `assertNoSuppressedContact` running after the
 * INSERT still rolls the INSERT back, and the resulting database is
 * indistinguishable from the correct one.
 */

const tx = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tesserix")>()),
  // Runs the callback on a query spy rather than a client, so every statement
  // the function issues is recorded in the order it issued them.
  tesserixTx: vi.fn(async (run: (q: unknown) => Promise<unknown>) => run(tx.query)),
}));

vi.mock("./crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crm-repo")>()),
  assertNoSuppressedContact: vi.fn(),
  advanceStageOnQuery: vi.fn(async () => ({ stageChanged: true, productChanged: false })),
}));

import { assertNoSuppressedContact, advanceStageOnQuery, SuppressedContactError } from "./crm-repo";
import { NEXT_ACTION_DAYS } from "../crm";
import {
  recordTemplatedDm,
  ContactUnavailableError,
  TemplateUnavailableError,
} from "./crm-outreach";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const OPP_ID = "44444444-4444-4444-8444-444444444444";

/** A distinctive string, so an assertion that it never reached a parameter
 *  list is checking for something no other fixture could have supplied. */
const SENTINEL = "SENTINEL-BIO-8f3c artisan sourdough since 2019";
const RENDERED = `Hi Ada — ${SENTINEL}`;

interface Rows {
  template?: Array<{ name: string; channel: string; is_archived: boolean }>;
  contact?: Array<{ email: string | null; instagram_handle: string | null }>;
  opportunities?: Array<{ id: string; stage: string }>;
}

/**
 * Answers each statement by what it touches. Deliberately keyed on the SQL
 * rather than on call index: a test that broke the moment a statement was
 * added would be a test about this function's shape, not its rules.
 */
function respondWith(rows: Rows = {}) {
  tx.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM crm_templates")) {
      return rows.template ?? [{ name: "Cold intro", channel: "dm", is_archived: false }];
    }
    if (sql.includes("FROM crm_contacts")) {
      return rows.contact ?? [{ email: "ada@example.com", instagram_handle: "@ada" }];
    }
    if (sql.includes("INSERT INTO crm_activities")) {
      return [{ id: "activity-1" }];
    }
    if (sql.includes("UPDATE crm_opportunities")) {
      return rows.opportunities ?? [{ id: OPP_ID, stage: "new" }];
    }
    return [];
  });
}

function input(overrides: Partial<Parameters<typeof recordTemplatedDm>[0]> = {}) {
  return {
    organisationId: ORG_ID,
    contactId: CONTACT_ID,
    templateId: TEMPLATE_ID,
    bodyIfEdited: null,
    actor: "ava@tesserix.app",
    ...overrides,
  };
}

/** The SQL of every statement issued, in order. */
function statements(): string[] {
  return tx.query.mock.calls.map(([sql]) => sql as string);
}

/** The parameters of the one `crm_activities` INSERT. */
function activityParams(): unknown[] {
  const call = tx.query.mock.calls.find(([sql]) =>
    (sql as string).includes("INSERT INTO crm_activities"),
  );
  if (!call) throw new Error("no crm_activities INSERT was issued");
  return call[1] as unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations, so a `mockRejectedValue`
  // set by one test would otherwise be the suppression answer for every test
  // after it.
  vi.mocked(assertNoSuppressedContact).mockResolvedValue(undefined);
  vi.mocked(advanceStageOnQuery).mockResolvedValue({
    stageChanged: true,
    productChanged: false,
  });
  respondWith();
});

describe("recordTemplatedDm — the suppression re-check", () => {
  it("runs the suppression check BEFORE any statement, not merely before the commit", async () => {
    const order: string[] = [];
    vi.mocked(assertNoSuppressedContact).mockImplementation(async () => {
      order.push("suppression");
    });
    tx.query.mockImplementation(async (sql: string) => {
      order.push(sql.includes("INSERT INTO crm_activities") ? "insert" : "other");
      if (sql.includes("FROM crm_templates")) {
        return [{ name: "Cold intro", channel: "dm", is_archived: false }];
      }
      if (sql.includes("FROM crm_contacts")) return [{ email: null, instagram_handle: "@ada" }];
      if (sql.includes("INSERT INTO crm_activities")) return [{ id: "activity-1" }];
      return [{ id: OPP_ID, stage: "new" }];
    });

    await recordTemplatedDm(input());

    expect(order[0]).toBe("suppression");
    expect(order.indexOf("suppression")).toBeLessThan(order.indexOf("insert"));
  });

  it("is passed the transaction's own query, not the pooled one", async () => {
    await recordTemplatedDm(input());

    expect(assertNoSuppressedContact).toHaveBeenCalledWith(ORG_ID, tx.query);
  });

  it("writes nothing when the organisation is suppressed", async () => {
    vi.mocked(assertNoSuppressedContact).mockRejectedValue(new SuppressedContactError(ORG_ID));

    await expect(recordTemplatedDm(input())).rejects.toBeInstanceOf(SuppressedContactError);
    expect(tx.query).not.toHaveBeenCalled();
  });
});

describe("recordTemplatedDm — what reaches crm_activities", () => {
  it("writes a NULL body when the operator sent our render verbatim", async () => {
    await recordTemplatedDm(input({ bodyIfEdited: null }));

    const params = activityParams();
    expect(params[3]).toBeNull();
    expect(JSON.parse(params[4] as string)).toMatchObject({
      template_id: TEMPLATE_ID,
      edited: false,
    });
  });

  it("never passes the rendered message to the INSERT on the unedited path", async () => {
    // The negative control: the sentinel is what a rendered body WOULD have
    // contained, so an assertion that it is absent is only meaningful because
    // it is exactly the string a mutation would put there.
    expect(RENDERED).toContain(SENTINEL);

    await recordTemplatedDm(input({ bodyIfEdited: null }));

    const serialised = JSON.stringify(tx.query.mock.calls);
    expect(serialised).not.toContain(SENTINEL);
  });

  it("stores the operator's own text, and records that a human authored it", async () => {
    await recordTemplatedDm(input({ bodyIfEdited: "Hi Ada, saw your Tuesday bake." }));

    const params = activityParams();
    expect(params[3]).toBe("Hi Ada, saw your Tuesday bake.");
    expect(JSON.parse(params[4] as string).edited).toBe(true);
  });

  it("records rendered_at as a parseable timestamp", async () => {
    await recordTemplatedDm(input());

    const { rendered_at: renderedAt } = JSON.parse(activityParams()[4] as string);
    expect(Number.isNaN(Date.parse(renderedAt))).toBe(false);
  });

  it("logs the activity against the contact and no single deal", async () => {
    await recordTemplatedDm(input());

    const params = activityParams();
    expect(params[0]).toBe(ORG_ID);
    expect(params[1]).toBe(CONTACT_ID);
    expect(statements().some((sql) => sql.includes("'dm_sent'"))).toBe(true);
  });
});

describe("recordTemplatedDm — the template and the contact", () => {
  it("refuses an archived template and writes nothing", async () => {
    respondWith({ template: [{ name: "Retired", channel: "dm", is_archived: true }] });

    await expect(recordTemplatedDm(input())).rejects.toBeInstanceOf(TemplateUnavailableError);
    expect(statements().some((sql) => sql.includes("INSERT INTO crm_activities"))).toBe(false);
  });

  it("refuses to log an email template as a DM", async () => {
    respondWith({ template: [{ name: "Nurture", channel: "email", is_archived: false }] });

    await expect(recordTemplatedDm(input())).rejects.toBeInstanceOf(TemplateUnavailableError);
    expect(statements().some((sql) => sql.includes("INSERT INTO crm_activities"))).toBe(false);
  });

  it("scopes the contact to the organisation and excludes erased ones", async () => {
    await recordTemplatedDm(input());

    const call = tx.query.mock.calls.find(([sql]) =>
      (sql as string).includes("FROM crm_contacts"),
    );
    expect(call?.[0]).toContain("organisation_id = $2");
    expect(call?.[0]).toContain("erased_at IS NULL");
    expect(call?.[1]).toEqual([CONTACT_ID, ORG_ID]);
  });

  it("refuses a contact that belongs to another organisation, or has been erased", async () => {
    respondWith({ contact: [] });

    await expect(recordTemplatedDm(input())).rejects.toBeInstanceOf(ContactUnavailableError);
    expect(statements().some((sql) => sql.includes("INSERT INTO crm_activities"))).toBe(false);
  });
});

describe("recordTemplatedDm — the clocks and the stage", () => {
  // The interval is `NEXT_ACTION_DAYS` inlined rather than bound as `$n`: the
  // assignment is now `nextActionAssignment` (crm-repo.ts), a fragment two
  // statements with differently-numbered placeholders share. Asserted against
  // the constant so changing it moves this test with it.
  it("moves the next action NEXT_ACTION_DAYS out and touches the drift clock", async () => {
    await recordTemplatedDm(input());

    const call = tx.query.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE crm_opportunities"),
    );
    expect(call?.[0]).toContain(`now() + interval '${NEXT_ACTION_DAYS} days'`);
    expect(call?.[0]).toContain("last_contacted_at = now()");
  });

  // #502 — a future date is the operator's decision, and sending a template
  // does not un-make it. This path used to assign unconditionally while the
  // plain activity log did not; one column written by two rules is a
  // difference no operator could predict.
  it("fills or refreshes the next action rather than overwriting a future one", async () => {
    await recordTemplatedDm(input());

    const call = tx.query.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE crm_opportunities"),
    );
    expect(call?.[0]).toContain("next_action_at IS NULL OR next_action_at <= now()");
    // The note is gated on the same condition — a note naming this template
    // beside a date scheduled for another reason describes a plan nobody made.
    expect(call?.[0]).toContain("next_action_note = CASE WHEN");
  });

  it("excludes closed and grandfathered deals, which would abort the transaction", async () => {
    await recordTemplatedDm(input());

    const call = tx.query.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE crm_opportunities"),
    );
    expect(call?.[0]).toContain("stage NOT IN ('won', 'lost')");
    expect(call?.[0]).toContain("stage IN ('new', 'contacted') OR product IS NOT NULL");
  });

  it("advances a stage-new deal through advanceStageOnQuery, on this transaction", async () => {
    await recordTemplatedDm(input());

    expect(advanceStageOnQuery).toHaveBeenCalledWith(tx.query, {
      opportunityId: OPP_ID,
      to: "contacted",
      actor: "ava@tesserix.app",
    });
  });

  it("never writes the stage UPDATE by hand", async () => {
    await recordTemplatedDm(input());

    // `advanceStageOnQuery` owns the rule that every transition writes its
    // `stage_change` activity. A hand-rolled `SET stage = …` here would be a
    // second copy of it — and the copy that drifts is the one that stops
    // writing the activity.
    expect(statements().some((sql) => /SET[\s\S]*\bstage\s*=/.test(sql))).toBe(false);
  });

  it("leaves a deal already past new where it is", async () => {
    respondWith({ opportunities: [{ id: OPP_ID, stage: "contacted" }] });

    const result = await recordTemplatedDm(input());

    expect(advanceStageOnQuery).not.toHaveBeenCalled();
    expect(result.stagesAdvanced).toBe(0);
    expect(result.opportunitiesTouched).toBe(1);
  });

  it("reports the contact's handle for the audit row, never the message", async () => {
    const result = await recordTemplatedDm(input({ bodyIfEdited: RENDERED }));

    expect(result.contactLabel).toBe("@ada");
  });
});
