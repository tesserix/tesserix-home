import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ══ THE CONSTRAINT-2 PROOF ══
 *
 * WHAT THIS FILE DEFENDS, stated so a reviewer knows what they are reading
 * before they read it:
 *
 *  1. The DM this console renders embeds `crm_contacts.biography` — scrape-
 *     derived personal data about someone who never filled in a form, which is
 *     migration 0019's own description of what that column holds.
 *  2. `eraseContact` (`crm-erasure.ts`) nulls a contact's personal columns and
 *     empties its metadata bag IN ONE STATEMENT, and it does not touch
 *     `crm_activities` — those rows are destroyed only by the organisation
 *     delete cascade, which answers a different request entirely. The same is
 *     true of `console_audit_log`.
 *  3. Therefore any rendered body written to either table OUTLIVES the erasure
 *     request that was supposed to destroy the data it was derived from.
 *     Migration 0027's DPDP paragraph names that exact situation "a compliance
 *     defect, not a feature".
 *
 * The only thing standing between (1) and (3) is that `copyAndLogDm` decides
 * `crm_activities.body` by re-rendering server-side and comparing, rather than
 * by believing a client flag. This file is the proof that the decision holds
 * all the way down to what is durably on disk.
 *
 * ══ WHY THIS EXISTS ALONGSIDE `actions.outreach.test.ts`, AND WHY NEITHER IS
 *    REDUNDANT ══
 *
 * `actions.outreach.test.ts` asserts what the action ASKS FOR: that it
 * re-renders, that it passes `bodyIfEdited: null` on the verbatim path, that a
 * request claiming an edit cannot make it pass the render. Those are assertions
 * about a CALL, with `recordTemplatedDm` mocked.
 *
 * This file asserts the DURABLE STATE OF THE DATABASE, against a real
 * (in-process) Postgres, after the real erasure has run. A correct call into a
 * writer that persisted the wrong column would satisfy every test in that file
 * and none in this one; a writer kept clean while the action learned to believe
 * the client would satisfy every test here on the verbatim path and none there.
 * Deleting either as a duplicate of the other removes half the guarantee.
 *
 * ══ THE SENTINEL, AND WHY THE SCAN IS UNTARGETED ══
 *
 * `biography` is seeded with a unique string that exists nowhere else in this
 * repository, so finding it in a row is proof of where it came from and not a
 * coincidence. The scan is over the WHOLE serialised `metadata`, not over named
 * keys — `crm-erasure.integration.test.ts` makes exactly this choice, and says
 * why: an assertion about named keys keeps passing while everything a future
 * writer adds to the bag survives.
 *
 * A NEGATIVE CONTROL RUNS FIRST, every time: the render is asserted to CONTAIN
 * the sentinel before the table is asserted not to. Without it this whole file
 * passes trivially the day the fixture stops populating `biography`, and a green
 * suite would be evidence of nothing at all.
 *
 * ══ THE RESIDUAL, RESTATED HERE BECAUSE IT IS PART OF THE CLAIM ══
 *
 * An operator who edits one character keeps the rest of the render, biography
 * included, and that text IS stored — `crm-outreach.ts`'s header accepts this
 * deliberately, because a log that refused to record what a human actually
 * wrote would be a work of fiction. So the guarantee this file proves is
 * precisely: NOTHING THIS CONSOLE AUTHORED lands in `crm_activities`. It is not
 * "the biography can never appear there under any circumstance", and reading it
 * as the stronger claim would be reading it wrong. `metadata.edited` is what
 * makes the weaker claim workable: an erasure request can find the small set of
 * human-authored rows with `metadata->>'edited' = 'true'` instead of reading the
 * whole table.
 *
 * THAT RESIDUAL NOW HAS ITS OWN CONTROL, AND ITS OWN TESTS, at the bottom of
 * this file — "eraseContact — the outreach it cannot finish" (#507). Until
 * then the only thing standing behind it was this paragraph and a SQL query in
 * a comment, which describes an obligation rather than holding anyone to one.
 *
 * Own pglite instance — a `vi.mock` in one test file cannot be shared with
 * another (see `crm-erasure.integration.test.ts`).
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    // pglite is a single embedded session and satisfies `TxClient`
    // structurally, so delegating to the real `runTesserixTx` exercises the
    // BEGIN/COMMIT/ROLLBACK that ships — which assertion (7) below is entirely
    // about.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));

const { getCurrentSession } = await import("@tesserix/platform-auth");
const { recordTemplatedDm } = await import("./crm-outreach");
const { SuppressedContactError, addSuppression } = await import("./crm-repo");
const { eraseContact } = await import("./crm-erasure");
const { ERASURE_HASH_KEY_ENV } = await import("./crm-erasure-hash");
// The REAL action, not the repo. Assertion (5) is about who decides `body`,
// and the decision is made here — `recordTemplatedDm` is only ever handed the
// verdict.
const { copyAndLogDm, previewTemplate } = await import(
  "../../app/(console)/platform/crm/[organisation]/actions"
);

/**
 * The scraped bio. Unique in this repository on purpose: an assertion that this
 * string is absent is an assertion about provenance, not about a substring that
 * might have arrived from somewhere innocent.
 */
const SENTINEL = "SENTINEL-BIO-8f3c artisan sourdough since 2019";

/** Operator-authored text, containing no sentinel — the edited path's input,
 *  chosen so assertion (4) can tell "stored because a human wrote it" apart
 *  from "stored because the render leaked in". */
const OPERATOR_TEXT = "Hi Ada — saw you at the Bondi markets. Would love a chat.";

const ACTOR_EMAIL = "ava@tesserix.app";
const ACTOR_SUB = "sub-ava";

let db: PGlite;
let orgId: string;
let contactId: string;
let templateId: string;
let opportunityId: string;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  for (const migration of [
    // The audit table. Loaded because this file drives the REAL action through
    // `withCrmWrite`/`auditedOperation`, and because `console_audit_log` is the
    // OTHER table `eraseContact` cannot reach — the sentinel scan below covers
    // it for the same reason it covers `crm_activities`.
    "0018_console_audit_log.sql",
    "0019_crm_schema.sql",
    // The do-not-contact list in its normalised form — assertion (7)'s subject.
    "0022_crm_suppressions_normalize.sql",
    // `crm_contacts.erased_at`, and the raw-scrape bag: both written by the
    // real `eraseContact` that assertion (6) runs.
    "0024_crm_contacts_erased_at.sql",
    "0027_crm_contacts_metadata.sql",
    // The erasure register. `eraseContact` fails closed without it, so its
    // absence would fail assertion (6) on an INSERT rather than on its claim.
    "0041_crm_erased_identifiers.sql",
    "0043_crm_templates.sql",
  ]) {
    const migrationPath = path.resolve(__dirname, "../../../web/db/migrations", migration);
    await db.exec(readFileSync(migrationPath, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

beforeEach(async () => {
  // `zitadel` so the capability gate in `withCrmWrite` actually RUNS rather
  // than short-circuiting on `requiresCapability(undefined) === false`. The
  // session below carries no `sid`, so `checkOperatorCapabilityLive` resolves
  // `no-sid` and falls back to the session's own role snapshot — the real gate,
  // reaching a real verdict, with no token store to stand up.
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  // `eraseContact` fails closed without this (#226).
  vi.stubEnv(ERASURE_HASH_KEY_ENV, "integration-erasure-key");

  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: ACTOR_SUB,
    email: ACTOR_EMAIL,
    roles: ["crm"],
    iat: 0,
    exp: 0,
  } as never);

  // Both truncated per test: several tests below assert "no row exists", which
  // only means anything on a table no earlier test has written to.
  await db.query(`TRUNCATE crm_organisations CASCADE`);
  await db.query(`TRUNCATE crm_templates`);
  await db.query(`TRUNCATE crm_suppressions`);
  await db.query(`TRUNCATE console_audit_log`);
  await db.query(`TRUNCATE crm_erased_identifiers`);

  const orgRows = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name, location, category)
     VALUES ($1, $2, $3) RETURNING id`,
    ["Flour & Ash", "Bondi", ["bakery"]],
  );
  orgId = orgRows.rows[0].id;

  const contactRows = await db.query<{ id: string }>(
    `INSERT INTO crm_contacts
       (organisation_id, name, email, instagram_handle, biography, metadata,
        source, sourced_at, lawful_basis, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), $8, true)
     RETURNING id`,
    [
      orgId,
      "Ada",
      "ada@flourandash.example",
      "adabakes",
      SENTINEL,
      JSON.stringify({ full_name: "Ada", profile_pic_url: "https://cdn.example/ada.jpg" }),
      "instagram_scrape",
      "legitimate_interest",
    ],
  );
  contactId = contactRows.rows[0].id;

  const oppRows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, product, stage)
     VALUES ($1, $2, 'new') RETURNING id`,
    [orgId, "mark8ly"],
  );
  opportunityId = oppRows.rows[0].id;

  const templateRows = await db.query<{ id: string }>(
    `INSERT INTO crm_templates (name, channel, body, created_by)
     VALUES ($1, 'dm', $2, $3) RETURNING id`,
    [
      "Cold intro",
      "Hi {{contact.name}} — love what {{org.name}} does. {{contact.biography}}",
      ACTOR_EMAIL,
    ],
  );
  templateId = templateRows.rows[0].id;
});

interface ActivityRow {
  kind: string;
  body: string | null;
  metadata_text: string;
}

async function activities(): Promise<ActivityRow[]> {
  const rows = await db.query<ActivityRow>(
    `SELECT kind, body, metadata::text AS metadata_text
       FROM crm_activities
      ORDER BY occurred_at ASC, kind ASC`,
  );
  return rows.rows;
}

/**
 * The scan. Untargeted on purpose (see the header): every row, both free-text
 * columns, and the whole serialised metadata rather than any key by name — in
 * BOTH tables `eraseContact` cannot reach.
 */
async function expectNoSentinelOnDisk(): Promise<void> {
  for (const row of await activities()) {
    expect(row.body ?? "").not.toContain(SENTINEL);
    expect(row.metadata_text).not.toContain(SENTINEL);
  }
  await expectNoSentinelInAuditLog();
}

/**
 * The audit half of the scan, split out because the EDITED path needs it
 * ALONE: there, `crm_activities.body` legitimately holds the operator's text
 * (sentinel and all), so the whole-disk scan above cannot run — but the claim
 * about `console_audit_log` is unchanged and, on that path, is being tested
 * for the first time against free text that actually contains the biography.
 */
async function expectNoSentinelInAuditLog(): Promise<void> {
  const audit = await db.query<{ target: string | null; metadata: string | null }>(
    `SELECT target, metadata FROM console_audit_log`,
  );
  expect(audit.rows.length).toBeGreaterThan(0);
  for (const row of audit.rows) {
    expect(row.target ?? "").not.toContain(SENTINEL);
    expect(row.metadata ?? "").not.toContain(SENTINEL);
  }
}

/** The render an operator is about to copy, through the same action the
 *  composer calls — and the negative control on every test that uses it. */
async function renderAndAssertItLeaks(): Promise<string> {
  const preview = await previewTemplate({ organisationId: orgId, contactId, templateId });
  if (!preview.ok) throw new Error(`preview refused: ${preview.message}`);
  // (2) THE NEGATIVE CONTROL. Everything below is worthless without it.
  expect(preview.text).toContain(SENTINEL);
  return preview.text;
}

async function logVerbatim(): Promise<string> {
  const rendered = await renderAndAssertItLeaks();
  const result = await copyAndLogDm({
    organisationId: orgId,
    contactId,
    templateId,
    submittedText: rendered,
  });
  // Asserted, not assumed: a refused write leaves an empty table, and an empty
  // table satisfies every "does not contain the sentinel" assertion below for
  // entirely the wrong reason.
  expect(result).toEqual({ ok: true });
  return rendered;
}

describe("copyAndLogDm — no scrape-derived text reaches crm_activities", () => {
  it("renders the scraped biography into the message the operator copies", async () => {
    // (2) standing alone, so the control is legible as its own fact rather than
    // only as a precondition inside the tests that rely on it. This is what
    // makes every absence assertion below meaningful.
    const rendered = await renderAndAssertItLeaks();
    expect(rendered).toBe(`Hi Ada — love what Flour & Ash does. ${SENTINEL}`);
  });

  it("writes no row carrying the biography, in body or anywhere in metadata", async () => {
    // (1) THE SENTINEL SCAN.
    await logVerbatim();

    const rows = await activities();
    // Both rows the write produces: the `dm_sent` one and the `stage_change`
    // one `advanceStageOnQuery` inserts in the same transaction. Named here so
    // a future change that stops writing one is a failure rather than a scan
    // over fewer rows that silently keeps passing.
    expect(rows.map((row) => row.kind).sort()).toEqual(["dm_sent", "stage_change"]);
    await expectNoSentinelOnDisk();
  });

  it("persists the template id, the render time and edited=false instead of the text", async () => {
    // (3) WHAT IS PERSISTED INSTEAD — the reconstruction key, which by
    // construction stops working the moment the contact is erased.
    await logVerbatim();

    const rows = await db.query<{
      body: string | null;
      template_id: string;
      rendered_at: string;
      edited: string;
    }>(
      `SELECT body,
              metadata->>'template_id' AS template_id,
              metadata->>'rendered_at' AS rendered_at,
              metadata->>'edited'      AS edited
         FROM crm_activities WHERE kind = 'dm_sent'`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.body).toBeNull();
    expect(row.template_id).toBe(templateId);
    expect(Number.isNaN(Date.parse(row.rendered_at))).toBe(false);
    expect(row.edited).toBe("false");
  });

  it("stores the operator's own words, and marks that row edited", async () => {
    // (4) THE EDITED PATH IS DISTINGUISHED. `metadata.edited` is what lets an
    // erasure request find the human-authored rows without reading the table.
    await renderAndAssertItLeaks();
    const result = await copyAndLogDm({
      organisationId: orgId,
      contactId,
      templateId,
      submittedText: OPERATOR_TEXT,
    });
    expect(result).toEqual({ ok: true });

    const rows = await db.query<{ body: string | null; edited: string }>(
      `SELECT body, metadata->>'edited' AS edited
         FROM crm_activities WHERE kind = 'dm_sent'`,
    );
    expect(rows.rows[0].body).toBe(OPERATOR_TEXT);
    expect(rows.rows[0].edited).toBe("true");
    // The operator's text is theirs and is stored; the render's is not and is
    // not. Scanned anyway, because "stored the right string" and "stored ONLY
    // the right string" are different claims.
    await expectNoSentinelOnDisk();
  });

  it("gives the verbatim render a NULL body even though it arrived as free text", async () => {
    // (5) THE SMUGGLING ATTEMPT, through the ACTION rather than the repo.
    //
    // `submittedText` is the only free-text field in this feature, so the way
    // to push the biography into `crm_activities.body` is to submit the render
    // itself and have it treated as the operator's own words. There is no
    // `edited` flag to lie with — the type has no such field — because the
    // SERVER decides, by re-rendering and comparing. The row that comes back
    // is the evidence that it did.
    await logVerbatim();

    const rows = await db.query<{ body: string | null; edited: string }>(
      `SELECT body, metadata->>'edited' AS edited
         FROM crm_activities WHERE kind = 'dm_sent'`,
    );
    expect(rows.rows[0].body).toBeNull();
    expect(rows.rows[0].edited).toBe("false");
  });

  it("still holds no trace of the biography after the contact has been erased", async () => {
    // (6) SURVIVES ERASURE — the assertion that states the whole point.
    //
    // The REAL `eraseContact`, not a hand-set `erased_at`: the claim is about
    // what the shipped erasure leaves behind, and a hand-set column would
    // prove only that this test can write to it.
    await logVerbatim();
    const erased = await eraseContact(contactId);
    expect(erased?.previousName).toBe("Ada");

    // Guards the guard, the same way the erasure suite's own metadata test
    // does: an erasure that quietly did nothing would leave every assertion
    // below passing for the wrong reason.
    const contact = await db.query<{ biography: string | null; erased_at: string | null }>(
      `SELECT biography, erased_at FROM crm_contacts WHERE id = $1`,
      [contactId],
    );
    expect(contact.rows[0].biography).toBeNull();
    expect(contact.rows[0].erased_at).not.toBeNull();

    // Activities OUTLIVE the erasure — that is the design, and it is exactly
    // why nothing derived from the erased columns may ever have been written
    // to them.
    const rows = await activities();
    expect(rows.length).toBeGreaterThan(0);
    await expectNoSentinelOnDisk();
  });
});

describe("recordTemplatedDm — the write is one transaction", () => {
  it("refuses a suppressed contact, leaving no activity and no stage move", async () => {
    // (7) SUPPRESSION RE-CHECK. Added AFTER the preview would have passed, so
    // this is the both-ends rule doing the work it exists for: a preview is a
    // promise about a state that may already be old.
    await renderAndAssertItLeaks();
    await addSuppression({
      instagramHandle: "adabakes",
      reason: "asked us to stop",
      actor: ACTOR_EMAIL,
    });

    await expect(
      recordTemplatedDm({
        organisationId: orgId,
        contactId,
        templateId,
        bodyIfEdited: null,
        actor: ACTOR_EMAIL,
      }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    // Rolled back AS A UNIT: no activity, and the stage did not move. A
    // `dm_sent` row with the lead still at `new` — or a stage move with no
    // activity — is the corruption the one-transaction rule exists to prevent.
    expect(await activities()).toHaveLength(0);
    const opp = await db.query<{ stage: string; last_contacted_at: string | null }>(
      `SELECT stage, last_contacted_at FROM crm_opportunities WHERE id = $1`,
      [opportunityId],
    );
    expect(opp.rows[0].stage).toBe("new");
    expect(opp.rows[0].last_contacted_at).toBeNull();
  });
});

describe("copyAndLogDm — what sending a DM implies", () => {
  it("moves the stage to contacted, logs the change and pushes both clocks", async () => {
    // (8) THE STAGE AND THE CLOCK. Half of these landing is worse than none:
    // a logged DM with the lead still at `new` puts it back in the queue to be
    // DMed a second time.
    await logVerbatim();

    const opp = await db.query<{
      stage: string;
      next_action_at: Date;
      next_action_note: string | null;
      last_contacted_at: Date | null;
    }>(
      `SELECT stage, next_action_at, next_action_note, last_contacted_at
         FROM crm_opportunities WHERE id = $1`,
      [opportunityId],
    );
    const row = opp.rows[0];
    expect(row.stage).toBe("contacted");
    expect(row.last_contacted_at).not.toBeNull();
    expect(row.next_action_note).toBe('Follow up on "Cold intro"');
    // ~4 days out (NEXT_ACTION_DAYS), asserted as a range rather than an
    // instant because `now()` moved between the write and this read.
    const daysOut =
      (new Date(row.next_action_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(3.9);
    expect(daysOut).toBeLessThan(4.1);

    const change = await db.query<{ body: string | null; from_stage: string; to_stage: string }>(
      `SELECT body, metadata->>'from' AS from_stage, metadata->>'to' AS to_stage
         FROM crm_activities WHERE kind = 'stage_change'`,
    );
    expect(change.rows).toHaveLength(1);
    expect(change.rows[0].from_stage).toBe("new");
    expect(change.rows[0].to_stage).toBe("contacted");
  });

  /**
   * #502 — a default, not a rule, on this path as well as the composer's.
   *
   * This statement assigned `now() + 4 days` unconditionally, so an operator
   * who had deliberately parked a lead ("check back in a month") lost that
   * decision the moment anyone sent it a template. The plain activity log
   * learned to leave a future date alone; two paths writing one column by two
   * rules is a difference no operator could predict, so both now run the same
   * `nextActionAssignment` fragment.
   *
   * The note is asserted too, and that is the half a date-only test would
   * miss: leaving the date but rewriting the note to name this template
   * describes a plan nobody made.
   */
  it("leaves a future next action, and its note, exactly where the operator put them", async () => {
    const parked = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query(
      `UPDATE crm_opportunities
          SET next_action_at = $2, next_action_note = 'Ring after the season'
        WHERE id = $1`,
      [opportunityId, parked.toISOString()],
    );

    await logVerbatim();

    const opp = await db.query<{ next_action_at: Date; next_action_note: string | null }>(
      `SELECT next_action_at, next_action_note FROM crm_opportunities WHERE id = $1`,
      [opportunityId],
    );
    const daysOut =
      (new Date(opp.rows[0].next_action_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(daysOut)).toBe(30);
    expect(opp.rows[0].next_action_note).toBe("Ring after the season");

    // And the DM was still recorded — respecting the date is not the same as
    // declining to log the outreach. (Two rows: the `dm_sent` and the
    // `stage_change` it implies.)
    expect(await activities()).toHaveLength(2);
  });

  // The other half: an overdue date is refreshed, or working a lead could
  // never take it off the top of Due.
  it("refreshes a next action that has already passed", async () => {
    await db.query(
      `UPDATE crm_opportunities SET next_action_at = now() - interval '9 days' WHERE id = $1`,
      [opportunityId],
    );

    await logVerbatim();

    const opp = await db.query<{ next_action_at: Date; next_action_note: string | null }>(
      `SELECT next_action_at, next_action_note FROM crm_opportunities WHERE id = $1`,
      [opportunityId],
    );
    const daysOut =
      (new Date(opp.rows[0].next_action_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(3.9);
    expect(daysOut).toBeLessThan(4.1);
    expect(opp.rows[0].next_action_note).toBe('Follow up on "Cold intro"');
  });
});

/**
 * ══ THE RESIDUAL, NOW PROVEN RATHER THAN ONLY STATED (#507) ══
 *
 * The suite above proves the NARROW claim: nothing this console authored
 * reaches `crm_activities`. Its header is explicit that this is not the same
 * as "the biography can never appear there" — an operator who edits one
 * character keeps the rest of the render, biography included, and that text is
 * stored because a log that refused to record what a human wrote would be
 * fiction.
 *
 * That residual had no test at all. What it had was a SQL query in a comment,
 * which is a description of an obligation rather than a control over one. This
 * block is the control: it drives the edited path with text that DELIBERATELY
 * KEEPS the sentinel, runs the real `eraseContact`, and asserts that the
 * erasure hands back the rows it could not finish and stamps them where a
 * query can find them months later.
 *
 * WHAT IT DOES NOT ASSERT, because the decision was the other way: it does not
 * assert the text is gone. `eraseContact` deliberately does not destroy it —
 * the operator's own sentence and the quoted biography are one string with no
 * boundary between them, so nulling `body` deletes the record of what a human
 * said in order to reach the part that was ours. See "# The residual" in
 * `crm-erasure.ts` for the argument and for what auto-redaction would have
 * cost. A test asserting `body IS NULL` after erasure would be pinning the
 * option that was rejected.
 */

/** The dm_sent row, with the fields all four tests below read. */
async function dmSentRow(): Promise<{
  id: string;
  body: string | null;
  metadata_text: string;
  pending_review: string | null;
}> {
  const rows = await db.query<{
    id: string;
    body: string | null;
    metadata_text: string;
    pending_review: string | null;
  }>(
    `SELECT id, body, metadata::text AS metadata_text,
            metadata->>'erasure_pending_review' AS pending_review
       FROM crm_activities WHERE kind = 'dm_sent'`,
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0];
}

/**
 * The edited path, driven with text that KEEPS the biography — which is the
 * only version of "edited" that reproduces the gap. The existing suite's
 * edited test submits `OPERATOR_TEXT`, which contains no sentinel by design,
 * so it proves the write path and says nothing about the residual.
 *
 * Two negative controls, both of which must run before anything below means
 * anything: the render leaks the sentinel (`renderAndAssertItLeaks`), and the
 * text actually submitted still carries it after the edit.
 */
async function logEditedKeepingTheBiography(): Promise<string> {
  const rendered = await renderAndAssertItLeaks();
  const edited = `${rendered} Let me know if next week suits.`;
  expect(edited).toContain(SENTINEL);
  expect(edited).not.toBe(rendered);

  const result = await copyAndLogDm({
    organisationId: orgId,
    contactId,
    templateId,
    submittedText: edited,
  });
  expect(result).toEqual({ ok: true });
  return edited;
}

/** The real erasure, with the fixture asserted to have been worth erasing. */
async function eraseAndAssertItRan(): Promise<{ activitiesPendingRedaction: string[] }> {
  // NEGATIVE CONTROL. Without this the whole block passes trivially the day
  // the fixture stops populating `biography` — a green suite evidencing
  // nothing, which is the failure mode this file's header names.
  const before = await db.query<{ biography: string | null }>(
    `SELECT biography FROM crm_contacts WHERE id = $1`,
    [contactId],
  );
  expect(before.rows[0].biography).toContain(SENTINEL);

  const erased = await eraseContact(contactId);
  if (!erased) throw new Error("eraseContact found no contact");

  // Guards the guard: an erasure that quietly did nothing would leave every
  // assertion below passing for the wrong reason.
  const after = await db.query<{ biography: string | null; erased_at: string | null }>(
    `SELECT biography, erased_at FROM crm_contacts WHERE id = $1`,
    [contactId],
  );
  expect(after.rows[0].biography).toBeNull();
  expect(after.rows[0].erased_at).not.toBeNull();
  return erased;
}

describe("eraseContact — the outreach it cannot finish", () => {
  it("leaves the biography in an edited DM's body, which is the gap being closed", async () => {
    // THE PRECONDITION, standing on its own so the rest is legible as a
    // response to a real defect rather than to a hypothetical one. This is the
    // exact state #507 describes: scraped biography text sitting in a table
    // `eraseContact` does not reach.
    await logEditedKeepingTheBiography();

    const row = await dmSentRow();
    expect(row.body).toContain(SENTINEL);
    expect(row.metadata_text).toContain('"edited": true');

    await eraseAndAssertItRan();

    // Still there AFTER the erasure — deliberately, and this is the whole
    // reason the row has to be flagged instead.
    const afterErasure = await dmSentRow();
    expect(afterErasure.body).toContain(SENTINEL);
  });

  it("hands the erasure's caller the rows it could not finish", async () => {
    await logEditedKeepingTheBiography();
    const row = await dmSentRow();

    const erased = await eraseAndAssertItRan();

    // The id itself, not a count: a caller that has to go and find them would
    // be back to the query-in-a-comment this replaces.
    expect(erased.activitiesPendingRedaction).toEqual([row.id]);
  });

  it("stamps the row so the obligation outlives the response that reported it", async () => {
    // THE LOAD-BEARING ASSERTION. A returned list lives as long as one HTTP
    // response; an operator whose tab dies after the commit would be left with
    // a completed erasure, an audit row saying so, and nothing on disk
    // recording that a step remained. The stamp is what makes "is any erasure
    // unfinished, and since when" answerable at any time by anyone.
    await logEditedKeepingTheBiography();
    await eraseAndAssertItRan();

    const row = await dmSentRow();
    expect(row.pending_review).not.toBeNull();
    expect(Number.isNaN(Date.parse(row.pending_review!))).toBe(false);

    // The query the runbook publishes, run for real — the obligation is
    // findable without knowing which erasures ever happened.
    const found = await db.query<{ id: string }>(
      `SELECT id FROM crm_activities WHERE metadata ? 'erasure_pending_review'`,
    );
    expect(found.rows.map((r) => r.id)).toEqual([row.id]);
  });

  it("reports the same outstanding row on a repeat erasure, keeping the original timestamp", async () => {
    // The mirror of `erased_at`'s COALESCE. A second click erased nothing new,
    // but the rows are as outstanding as they were — and how LONG they have
    // been outstanding is the compliance-relevant fact a reset would destroy.
    await logEditedKeepingTheBiography();
    const first = await eraseAndAssertItRan();
    // Asserted, not assumed: two EMPTY lists are equal, so without this the
    // comparison below passes on an erasure that reports nothing at all —
    // exactly the regression this test exists to catch.
    expect(first.activitiesPendingRedaction).toHaveLength(1);
    const firstStamp = (await dmSentRow()).pending_review;
    expect(firstStamp).not.toBeNull();

    const second = await eraseContact(contactId);
    expect(second?.activitiesPendingRedaction).toEqual(first.activitiesPendingRedaction);
    expect((await dmSentRow()).pending_review).toBe(firstStamp);
  });

  it("flags nothing when the operator sent our render verbatim", async () => {
    // The other half, and the one that keeps the list worth reading. A control
    // that flagged every activity would be discarded by the first operator who
    // met it, and the verbatim row has a NULL body — there is nothing in it to
    // redact.
    await logVerbatim();

    const erased = await eraseAndAssertItRan();

    expect(erased.activitiesPendingRedaction).toEqual([]);
    const found = await db.query(
      `SELECT id FROM crm_activities WHERE metadata ? 'erasure_pending_review'`,
    );
    expect(found.rows).toHaveLength(0);
  });

  it("keeps the biography out of console_audit_log even when the operator's own text quotes it", async () => {
    // THE `console_audit_log` DECISION, made a test rather than a comment.
    //
    // That table is the second one `eraseContact` cannot reach, and it is NOT
    // getting the same flag-for-review treatment — deliberately: it is the
    // DPDP evidence that the erasure happened, it deliberately retains the
    // contact's previous name, and redacting evidence to satisfy an erasure
    // destroys the proof the erasure was performed. The control there is that
    // no message text is written to it in the first place — `target` is the
    // handle or the email plus an id, `summary` is counts.
    //
    // Until now only a code comment held that line on this path. This is the
    // first test in which free text CONTAINING the biography flows through
    // `copyAndLogDm` into the audit writer, so it is the first time the claim
    // is actually exercised rather than asserted about text that never had the
    // sentinel in it.
    await logEditedKeepingTheBiography();
    await expectNoSentinelInAuditLog();

    await eraseAndAssertItRan();
    await expectNoSentinelInAuditLog();
  });
});
