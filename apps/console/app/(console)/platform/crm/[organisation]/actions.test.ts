import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  advanceStage: vi.fn(),
  logActivity: vi.fn(),
  linkConversion: vi.fn(),
}));
vi.mock("@/lib/crm-queues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm-queues")>()),
  saveNextAction: vi.fn(),
}));
vi.mock("@/lib/db/crm-writes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-writes")>()),
  createContact: vi.fn(),
  createOpportunity: vi.fn(),
  updateOrganisation: vi.fn(),
}));
vi.mock("@/lib/db/crm-erasure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-erasure")>()),
  eraseContact: vi.fn(),
  deleteOrganisation: vi.fn(),
}));
// `withCrmWrite` itself is wrapped, not replaced: the erasure tests below
// need to inspect the exact arguments actions.ts passes it (the `hard-delete`
// capability, the `describe` callback) while still exercising the real
// gate/audit path every other describe block in this file relies on — a
// bare mock would have to reimplement `withCrmWrite`'s own contract to keep
// those other tests meaningful.
vi.mock("@/lib/crm-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crm-write")>();
  return { ...actual, withCrmWrite: vi.fn(actual.withCrmWrite) };
});
// Ruling 15: `actions.ts` now goes through the REAL `auditedOperation`
// (audit-repo.ts is not mocked) — only its own two leaf dependencies are,
// exactly the way `audit-repo.test.ts` tests `auditedOperation` itself.
// That is the point: a passing test here is evidence about the actual
// control this app ships, not about a copy of it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import {
  advanceStage,
  logActivity,
  linkConversion as linkConversionRow,
  MissingProductError,
  AlreadyLinkedError,
  SuppressedContactError,
} from "@/lib/db/crm-repo";
import { saveNextAction as setNextAction } from "@/lib/crm-queues";
import {
  createContact,
  createOpportunity as createOpportunityRow,
  updateOrganisation,
  DuplicateContactError,
} from "@/lib/db/crm-writes";
import { eraseContact, deleteOrganisation } from "@/lib/db/crm-erasure";
import { withCrmWrite } from "@/lib/crm-write";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  changeStage,
  scheduleNextAction,
  addActivity,
  linkConversion,
  addContactAction,
  createOpportunityAction,
  eraseContactAction,
  deleteOrganisationAction,
  updateOrganisationAction,
} from "./actions";

const ORG_ID = "8b6a7a4a-0000-0000-0000-000000000000";
const OPP_ID = "5f0b2c34-0000-0000-0000-000000000000";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The one write `writeAuditEntry` issues — `[actor, action, target,
 *  occurredAt, metadata]`, per audit-repo.ts. Pulled out so every test reads
 *  the audit row the same way instead of indexing into `mock.calls` inline. */
function lastAuditInsert(): { action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { action, target, summary: metadata ? JSON.parse(metadata) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("changeStage", () => {
  it("advances the stage, audits crm.stage.change with a real transition count, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(advanceStage).mockResolvedValue({ stageChanged: true, productChanged: true });

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
      product: "mark8ly",
    });

    expect(result).toEqual({ ok: true });
    expect(advanceStage).toHaveBeenCalledWith({
      opportunityId: OPP_ID,
      to: "qualified",
      actor: "ava@tesserix.app",
      product: "mark8ly",
      lostReason: undefined,
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.stage.change",
      target: OPP_ID,
      summary: { transitions: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  // Important 5: the audit row must describe what actually happened, not
  // what was requested. A no-op write (the repo's own guard-the-guard case)
  // is a real, honest outcome — `{transitions: 0}` — not a sentinel meaning
  // "something went wrong" and not fabricated as `{transitions: 1}` just
  // because a transition was asked for.
  it("records a no-op write as transitions: 0, not a fabricated transition", async () => {
    signIn(["crm"]);
    vi.mocked(advanceStage).mockResolvedValue({ stageChanged: false, productChanged: false });

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "contacted",
    });

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "crm.stage.change",
      target: OPP_ID,
      summary: { transitions: 0 },
    });
  });

  // Important 3: a product re-pointed on a live deal with the stage
  // untouched must not be recorded under the same action as a real
  // transition — an audit reader could not otherwise tell "the deal moved"
  // from "someone changed its product without moving it" apart.
  it("audits a stage-unchanged product fix as crm.product.set, not crm.stage.change", async () => {
    signIn(["crm"]);
    vi.mocked(advanceStage).mockResolvedValue({ stageChanged: false, productChanged: true });

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
      product: "mark8ly",
    });

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "crm.product.set",
      target: OPP_ID,
      summary: { transitions: 0 },
    });
  });

  it("refuses without console entry, before the repo is touched, and audits the refusal", async () => {
    // #409 task 3: `withCrmWrite`'s capability check now runs inside
    // `auditedOperation`, so this refusal writes a `capability.refused` row
    // instead of writing nothing (it used to run before `auditedOperation`
    // even started). The repo itself is still never touched.
    signIn(undefined);
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "contacted",
    });
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(advanceStage).not.toHaveBeenCalled();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects an unrecognised stage without calling the session or the repo", async () => {
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "converted",
    });
    expect(result).toEqual({ ok: false, message: `"converted" is not a CRM stage.` });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(advanceStage).not.toHaveBeenCalled();
  });

  it("refuses to qualify without a product before touching the session", async () => {
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/product/i);
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it("refuses to mark lost without a reason before touching the session", async () => {
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "lost",
      product: "mark8ly",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/reason/i);
    expect(getCurrentSession).not.toHaveBeenCalled();
  });

  it("maps a database-unavailable failure to a generic message, not the raw error, and writes no audit row", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "contacted",
    });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(advanceStage).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  // The single most important property of `auditedOperation`: a failed
  // audit write discards the result and throws — a caller must never be
  // able to obtain a value the audit trail doesn't also have a row for.
  // Exercised here against the REAL `auditedOperation` (only `tesserixQuery`
  // is mocked, to make the INSERT itself fail) rather than a mock of
  // `auditedOperation` standing in for that guarantee.
  it("discards the result when the audit write fails, and does not report success", async () => {
    signIn(["crm"]);
    vi.mocked(advanceStage).mockResolvedValue({ stageChanged: true, productChanged: true });
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
      product: "mark8ly",
    });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    // Guards the guard: the operation genuinely ran (this is a real failure
    // of the WRITE, not an earlier bail-out) — but the caller never gets
    // `{ok: true}` for a change whose audit row does not exist.
    expect(advanceStage).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
    // Pins WHICH query failed: `advanceStage` is mocked (it never reaches
    // `tesserixQuery` in this test), so the one call `tesserixQuery` sees is
    // `writeAuditEntry`'s INSERT — the same assertion `audit-repo.test.ts`
    // makes for this exact property, on the real `writeAuditEntry` call.
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tesserixQuery).mock.calls[0][0]).toContain(
      "INSERT INTO console_audit_log",
    );
  });
});

describe("scheduleNextAction", () => {
  it("schedules the next action, audits it, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(setNextAction).mockResolvedValue(undefined);

    const result = await scheduleNextAction({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      at: "2026-08-20T09:00:00.000Z",
      note: "call back",
    });

    expect(result).toEqual({ ok: true });
    expect(setNextAction).toHaveBeenCalledWith({
      opportunityId: OPP_ID,
      at: "2026-08-20T09:00:00.000Z",
      note: "call back",
      actor: "ava@tesserix.app",
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.next_action.set",
      target: OPP_ID,
      summary: { scheduled: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  // The real MissingProductError path: `setNextAction` is the function that
  // actually throws it (crm-repo.ts), unlike `advanceStage`, which never
  // does — so mocking it here exercises a rejection this code path can
  // really produce.
  it("refuses a grandfathered row with the repo's own message", async () => {
    signIn(["crm"]);
    vi.mocked(setNextAction).mockRejectedValue(new MissingProductError(OPP_ID));

    const result = await scheduleNextAction({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      at: null,
      note: null,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/product/i);
    expect(tesserixQuery).not.toHaveBeenCalled();
  });
});

describe("addActivity", () => {
  it("logs an activity, audits it, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await addActivity({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      kind: "note",
      body: "left a voicemail",
    });

    expect(result).toEqual({ ok: true });
    expect(logActivity).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      kind: "note",
      actor: "ava@tesserix.app",
      body: "left a voicemail",
    });
    expect(lastAuditInsert().action).toBe("crm.activity.log");
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  it("rejects an unrecognised kind without calling the session or the repo", async () => {
    const result = await addActivity({
      organisationId: ORG_ID,
      kind: "carrier_pigeon",
    });
    expect(result).toEqual({
      ok: false,
      message: `"carrier_pigeon" is not an activity kind an operator can log directly.`,
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  // Critical 2: `stage_change` (and `assigned`) are system-authored. A
  // generic "log an activity" action that accepted them could write a
  // `stage_change` row with an arbitrary body and no stage having moved —
  // exactly the corruption `advanceStage`'s one-transaction guarantee exists
  // to prevent, reachable from the other direction if this didn't refuse it.
  it("rejects an attempt to log a stage_change activity directly", async () => {
    const result = await addActivity({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      kind: "stage_change",
      body: "forged: pretend this moved to won",
    });
    expect(result).toEqual({
      ok: false,
      message: `"stage_change" is not an activity kind an operator can log directly.`,
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  // #245. The composer logs at organisation level and names no deal, so this
  // is the shape every contact event from the console now arrives in. The
  // action layer needed no change to accept it — `opportunityId` was already
  // optional and `isHumanActivityKind` already admitted all six kinds — and
  // this test is what keeps that true: a later `opportunityId` requirement
  // here would re-break the drift clock from above.
  it("forwards a contact kind that names no deal, and audits it against the organisation", async () => {
    signIn(["crm"]);
    vi.mocked(logActivity).mockResolvedValue(undefined);

    const result = await addActivity({
      organisationId: ORG_ID,
      kind: "call",
      body: "spoke to Ana",
    });

    expect(result).toEqual({ ok: true });
    expect(logActivity).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      opportunityId: undefined,
      kind: "call",
      actor: "ava@tesserix.app",
      body: "spoke to Ana",
    });
    expect(lastAuditInsert().target).toBe(ORG_ID);
  });

  it("rejects an attempt to log an assigned activity directly", async () => {
    const result = await addActivity({
      organisationId: ORG_ID,
      kind: "assigned",
    });
    expect(result.ok).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe("linkConversion", () => {
  it("links, audits crm.conversion.link with the organisation name, and revalidates both surfaces", async () => {
    signIn(["crm"]);
    vi.mocked(linkConversionRow).mockResolvedValue({
      organisationId: ORG_ID,
      organisationName: "Bondi Baker",
      product: "mark8ly",
      method: "matched",
    });

    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "tenant_9f2",
      label: "Bondi Store",
      method: "matched",
    });

    expect(result).toEqual({ ok: true });
    expect(linkConversionRow).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "tenant_9f2",
      label: "Bondi Store",
      method: "matched",
      actor: "ava@tesserix.app",
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.conversion.link",
      // Minor: the id alongside the name — a display name alone is neither
      // unique nor stable, which would make this the one CRM audit row an
      // operator can't join back to a real record.
      target: `Bondi Baker (${ORG_ID})`,
      summary: { linked: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm");
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  // Ruling 30: a second confirmation losing a race against the first (two
  // rows for the same organisation in the handoff queue, a stale tab, a
  // second operator) must read as a clear, distinct fact — not the generic
  // "not saved" every other caught error falls back to.
  it("maps AlreadyLinkedError to a distinct, operator-facing message", async () => {
    signIn(["crm"]);
    vi.mocked(linkConversionRow).mockRejectedValue(new AlreadyLinkedError(ORG_ID));

    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "matched",
    });

    expect(result).toEqual({
      ok: false,
      message: "This organisation already has a conversion recorded.",
    });
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing ref without calling the session or the repo", async () => {
    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "   ",
      method: "manual",
    });
    expect(result).toEqual({
      ok: false,
      message: "A product and a reference are required to link a conversion.",
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(linkConversionRow).not.toHaveBeenCalled();
  });

  // THE rule this action exists to encode: an email match is a suggestion an
  // operator confirms, never an automatic link. There is no code path here
  // that reaches `linkConversionRow` without the caller — the handoff view's
  // confirm button or its manual-entry form — having already supplied a
  // `method`, and an invalid one is refused before any write is attempted.
  it("rejects an invalid link method before touching the session", async () => {
    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "auto" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/valid link method/);
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(linkConversionRow).not.toHaveBeenCalled();
  });

  it("refuses without console entry, before the repo is touched, and audits the refusal", async () => {
    // #409 task 3 — see the identical note on `changeStage`'s equivalent test
    // above.
    signIn(undefined);
    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "manual",
    });
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(linkConversionRow).not.toHaveBeenCalled();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });
});

/**
 * `crm_opportunities.product` and `crm_organisations.converted_product` are
 * plain `text` with no CHECK and no foreign key — the estate is a TypeScript
 * constant, not a table — so this boundary is the only thing standing
 * between a typo and a product name the funnel will report attribution by.
 */
describe("product validation against the estate", () => {
  beforeEach(() => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(tesserixQuery).mockResolvedValue([]);
  });

  it("refuses a stage change to a product that is not in the estate", async () => {
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
      product: "mark8ley",
    });
    expect(result).toEqual({ ok: false, message: `"mark8ley" is not a product in the estate.` });
    expect(advanceStage).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("refuses a conversion link to a product that is not in the estate", async () => {
    const result = await linkConversion({
      organisationId: ORG_ID,
      product: "mark8ley",
      ref: "tenant_9f2",
      method: "manual",
    });
    expect(result).toEqual({ ok: false, message: `"mark8ley" is not a product in the estate.` });
    expect(linkConversionRow).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("still accepts a real estate context — guards the guard", async () => {
    vi.mocked(advanceStage).mockResolvedValue({ stageChanged: true, productChanged: true });
    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "qualified",
      product: "mark8ly",
    });
    expect(result).toEqual({ ok: true });
  });
});

// design.md:224 — the do-not-contact list is checked at import AND when
// logging outreach. The refusal is an operator-facing fact with a next step,
// so it must reach them verbatim rather than as the generic "not saved".
describe("addActivity and the do-not-contact list", () => {
  it("surfaces the suppression refusal to the operator", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    vi.mocked(logActivity).mockRejectedValue(new SuppressedContactError(ORG_ID));

    const result = await addActivity({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      kind: "dm_sent",
      body: "hello",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/do-not-contact list/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Finding 4: outreach was blocked, but manual creation was not — a person
  // who asked not to be contacted could simply be typed back in. Refused in
  // `createContact` (crm-writes.ts); this asserts the refusal reaches the
  // operator intact rather than as the generic "That change was not saved."
  it("surfaces the suppression refusal when a suppressed contact is added by hand", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    vi.mocked(createContact).mockRejectedValue(
      new SuppressedContactError(
        undefined,
        "That contact is on the do-not-contact list. Remove the suppression before adding them.",
      ),
    );

    const result = await addContactAction({ organisationId: ORG_ID, email: "gone@example.com" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/do-not-contact list/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * Item 6: the other half of the same refusal. A `23505` on either
 * contact-identity index arrived as `withCrmWrite`'s generic "That change was
 * not saved." — indistinguishable, to an operator, from a transport failure
 * worth retrying. The import path already resolves this exact condition
 * informatively (`matchedExisting`, crm-repo.ts); the manual door now does too.
 */
describe("addContactAction and the contact unique indexes", () => {
  it("names the email when that key is already taken", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    vi.mocked(createContact).mockRejectedValue(new DuplicateContactError("email"));

    const result = await addContactAction({ organisationId: ORG_ID, email: "taken@example.com" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/already/i);
    expect(result.ok === false && result.message).toMatch(/email/i);
    // Which organisation holds it is another business's record.
    expect(result.ok === false && result.message).not.toContain(ORG_ID);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("names the Instagram handle when that is the key that collided", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    vi.mocked(createContact).mockRejectedValue(new DuplicateContactError("instagramHandle"));

    const result = await addContactAction({ organisationId: ORG_ID, instagramHandle: "takenshop" });

    expect(result.ok === false && result.message).toMatch(/instagram handle/i);
  });
});

describe("addContactAction", () => {
  it("adds a contact, audits crm.contact.create, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(createContact).mockResolvedValue({ contactId: "contact-1" });

    const result = await addContactAction({
      organisationId: ORG_ID,
      name: "Ava",
      email: "ava@example.com",
    });

    expect(result).toEqual({ ok: true });
    expect(createContact).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      name: "Ava",
      email: "ava@example.com",
      phone: undefined,
      instagramHandle: undefined,
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.create",
      target: ORG_ID,
      summary: { contacts: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  it("trims every field server-side", async () => {
    signIn(["crm"]);
    vi.mocked(createContact).mockResolvedValue({ contactId: "contact-1" });

    await addContactAction({
      organisationId: ORG_ID,
      name: "  Ava  ",
      phone: "  0400 000 000  ",
      instagramHandle: "  @bondibaker  ",
    });

    expect(createContact).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      name: "Ava",
      email: undefined,
      phone: "0400 000 000",
      instagramHandle: "@bondibaker",
    });
  });

  it("refuses a contact with no identifying field, before touching the session", async () => {
    const result = await addContactAction({ organisationId: ORG_ID });

    expect(result).toEqual({
      ok: false,
      message: "Enter at least a name, email, phone, or Instagram handle.",
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("refuses without console entry", async () => {
    signIn(undefined);
    const result = await addContactAction({ organisationId: ORG_ID, name: "Ava" });
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(createContact).not.toHaveBeenCalled();
  });
});

describe("createOpportunityAction", () => {
  it("opens an opportunity, audits crm.opportunity.create, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(createOpportunityRow).mockResolvedValue({ opportunityId: "opp-2" });

    const result = await createOpportunityAction({
      organisationId: ORG_ID,
      product: "mark8ly",
      owner: "priya",
    });

    expect(result).toEqual({ ok: true });
    expect(createOpportunityRow).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      product: "mark8ly",
      owner: "priya",
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.opportunity.create",
      target: ORG_ID,
      summary: { opportunities: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  // The design's third motivating case (crm-writes.ts): a business lost in
  // March that returns in November is a new opportunity, not a resurrection
  // of the old row — a bare organisationId, no product yet, is legal.
  it("opens an opportunity with no product", async () => {
    signIn(["crm"]);
    vi.mocked(createOpportunityRow).mockResolvedValue({ opportunityId: "opp-3" });

    const result = await createOpportunityAction({ organisationId: ORG_ID });

    expect(result).toEqual({ ok: true });
    expect(createOpportunityRow).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      product: undefined,
      owner: undefined,
    });
  });

  it("refuses a product that is not in the estate, before touching the session", async () => {
    const result = await createOpportunityAction({ organisationId: ORG_ID, product: "mark8ley" });

    expect(result).toEqual({ ok: false, message: `"mark8ley" is not a product in the estate.` });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(createOpportunityRow).not.toHaveBeenCalled();
  });

  it("refuses without console entry", async () => {
    signIn(undefined);
    const result = await createOpportunityAction({ organisationId: ORG_ID, product: "mark8ly" });
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(createOpportunityRow).not.toHaveBeenCalled();
  });
});

describe("eraseContactAction", () => {
  const CONTACT_ID = "contact-1";

  it("gates contact erasure on hard-delete, not read", async () => {
    signIn(undefined);
    await eraseContactAction(CONTACT_ID);
    const options = vi.mocked(withCrmWrite).mock.calls[0][1];
    expect(options).toEqual(expect.objectContaining({ capability: "hard-delete" }));
  });

  it("erases, audits crm.contact.erase, and revalidates the organisation's detail page", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      // null: this call is the one that erased the contact, not a repeat.
      erasedAt: null,
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true });
    expect(eraseContact).toHaveBeenCalledWith(CONTACT_ID);
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.erase",
      target: `Priya Raman (${CONTACT_ID})`,
      summary: { erased: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
    // Finding 3: the browse list renders the primary contact's name, so an
    // erasure that only revalidates the detail page leaves the erased name
    // legible on the surface `createOrganisationAction` already revalidates.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/organisations");
  });

  // The name belongs in the audit row (asserted above via `target`), not
  // echoed back to the screen the erasure was just performed on.
  it("does not put the erased contact's name in the UI result", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      erasedAt: null,
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(JSON.stringify(result)).not.toContain("Priya Raman");
  });

  it("reports a missing contact as already gone rather than as a failure", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue(null);

    const result = await eraseContactAction(CONTACT_ID);

    expect(result.ok).toBe(true);
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.erase",
      target: CONTACT_ID,
      summary: { erased: 0 },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Important 2 (fix round 1): re-erasing an already-erased contact must not
  // write a second, indistinguishable "erased" row into console_audit_log —
  // that log is the evidence #140 consumes that a DPDP request was honoured,
  // and a fabricated second erasure in it is worse than a redundant click.
  it("reports erased: 0, not 1, when the contact was already erased", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "[erased]",
      // Non-null: the PRE-image already carried an erasure timestamp, so
      // this call is a no-op re-erase, not a genuine first one.
      erasedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.erase",
      target: `[erased] (${CONTACT_ID})`,
      summary: { erased: 0 },
    });
  });

  // The two audit summaries a real first-then-second click sequence
  // produces must differ, exactly as they would in `console_audit_log`.
  it("the second call's audit summary differs from the first's", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValueOnce({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      erasedAt: null,
    });
    await eraseContactAction(CONTACT_ID);
    const firstSummary = lastAuditInsert().summary;

    vi.mocked(eraseContact).mockResolvedValueOnce({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "[erased]",
      erasedAt: "2026-01-01T00:00:00.000Z",
    });
    await eraseContactAction(CONTACT_ID);
    const secondSummary = lastAuditInsert().summary;

    expect(firstSummary).toEqual({ erased: 1 });
    expect(secondSummary).toEqual({ erased: 0 });
    expect(secondSummary).not.toEqual(firstSummary);
  });

  // Important (fix round 2): the same audit-write-fails-after-commit risk
  // `deleteOrganisationAction` was fixed for applies here too, with more
  // force — this is the DPDP path, where the audit row is the evidence a
  // request was honoured. Mirrors "tells the operator the deletion
  // succeeded but was not recorded" above.
  it("tells the operator the erasure succeeded but was not recorded, when the audit write fails", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      erasedAt: null,
    });
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "The contact's details are gone, but that erasure was not recorded in the audit log. Please report this.",
    });
    // Guards the guard: the erasure genuinely ran — this is not an earlier
    // bail-out — but the audit row for it does not exist.
    expect(eraseContact).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an operator who holds read but not hard-delete", async () => {
    signIn(["crm"]);

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(eraseContact).not.toHaveBeenCalled();
  });
});

describe("deleteOrganisationAction", () => {
  it("gates organisation delete on hard-delete", async () => {
    signIn(undefined);
    await deleteOrganisationAction(ORG_ID);
    const options = vi.mocked(withCrmWrite).mock.calls[0][1];
    expect(options).toEqual(expect.objectContaining({ capability: "hard-delete" }));
  });

  it("counts what was deleted, and identifies it in target not summary", async () => {
    await deleteOrganisationAction(ORG_ID);
    const describe = vi.mocked(withCrmWrite).mock.calls[0][3];

    const description = describe({
      organisationId: ORG_ID,
      name: "Glebe Flowers",
      contactsDeleted: 2,
      opportunitiesDeleted: 3,
    });

    // An irreversible action whose audit row says only "ok" is not an audit
    // trail. But `AuditSummary` is Readonly<Record<string, number>> — counts
    // only — and SUMMARY_KEY rejects anything that isn't a lowercase dotted
    // identifier, so the organisation's name cannot go in summary. It goes
    // in `target`, which is the free-string field.
    expect(description.action).toBe("crm.organisation.delete");
    expect(description.summary).toEqual({ contacts: 2, opportunities: 3 });
    expect(description.target).toContain(ORG_ID);
  });

  it("deletes, audits crm.organisation.delete, and revalidates the organisations list", async () => {
    signIn(["hard-delete"]);
    vi.mocked(deleteOrganisation).mockResolvedValue({
      organisationId: ORG_ID,
      name: "Glebe Flowers",
      contactsDeleted: 2,
      opportunitiesDeleted: 3,
    });

    const result = await deleteOrganisationAction(ORG_ID);

    expect(result).toEqual({ ok: true });
    expect(deleteOrganisation).toHaveBeenCalledWith(ORG_ID);
    expect(lastAuditInsert()).toEqual({
      action: "crm.organisation.delete",
      target: `Glebe Flowers (${ORG_ID})`,
      summary: { contacts: 2, opportunities: 3 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm");
    // Finding 3: not just the queue — a deleted organisation still listed on
    // the browse surface links to a detail page that no longer exists.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/organisations");
  });

  it("reports a missing organisation as already gone rather than as a failure", async () => {
    signIn(["hard-delete"]);
    vi.mocked(deleteOrganisation).mockResolvedValue(null);

    const result = await deleteOrganisationAction(ORG_ID);

    expect(result.ok).toBe(true);
    expect(lastAuditInsert()).toEqual({
      action: "crm.organisation.delete",
      target: ORG_ID,
      summary: { contacts: 0, opportunities: 0 },
    });
  });

  // Important 1 (fix round 1): the cascade already committed by the time
  // `auditedOperation`'s own INSERT fails — `withCrmWrite`'s default
  // "That change was not saved." would tell the operator the opposite of
  // what happened for the strongest instance of that risk in the codebase.
  it("tells the operator the deletion succeeded but was not recorded, when the audit write fails", async () => {
    signIn(["hard-delete"]);
    vi.mocked(deleteOrganisation).mockResolvedValue({
      organisationId: ORG_ID,
      name: "Glebe Flowers",
      contactsDeleted: 2,
      opportunitiesDeleted: 3,
    });
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await deleteOrganisationAction(ORG_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "The organisation is gone, but that action was not recorded in the audit log. Please report this.",
    });
    // Guards the guard: the cascade genuinely ran — this is not an
    // earlier bail-out — but the audit row for it does not exist.
    expect(deleteOrganisation).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Minor (fix round 2): the copy must not claim a deletion happened when
  // the organisation was already gone before this call — "is gone" is true
  // either way, "was deleted" would be a lie in this case.
  it("uses the same honest copy when the audit write fails for an organisation that no longer existed", async () => {
    signIn(["hard-delete"]);
    vi.mocked(deleteOrganisation).mockResolvedValue(null);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await deleteOrganisationAction(ORG_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "The organisation is gone, but that action was not recorded in the audit log. Please report this.",
    });
  });

  it("refuses an operator who holds read but not hard-delete", async () => {
    signIn(["crm"]);

    const result = await deleteOrganisationAction(ORG_ID);

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(deleteOrganisation).not.toHaveBeenCalled();
  });
});

describe("updateOrganisationAction", () => {
  const NAME = "Glebe Florist";

  /** The edit form submits an uncontrolled `<form>` as `new FormData(...)`,
   *  the same way `organisations/new` does. An array value here stands for a
   *  field submitted more than once (a multi-select), which is how
   *  `category`/`tags` arrive. */
  function editForm(fields: Readonly<Record<string, string | readonly string[]>>): FormData {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      for (const entry of typeof value === "string" ? [value] : value) {
        formData.append(key, entry);
      }
    }
    return formData;
  }

  it("updates the organisation, audits the changed field names, and revalidates both surfaces", async () => {
    signIn(["crm"]);
    vi.mocked(updateOrganisation).mockResolvedValue({
      changed: [
        { field: "name", from: "Glebe Flowers", to: NAME },
        { field: "websiteUrl", from: null, to: "https://glebe.example" },
      ],
    });

    const result = await updateOrganisationAction(
      ORG_ID,
      editForm({
        name: NAME,
        location: "Sydney",
        websiteUrl: "https://glebe.example",
        category: ["florist", "retail"],
        tags: "import-2026",
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(updateOrganisation).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      actor: "ava@tesserix.app",
      name: NAME,
      location: "Sydney",
      websiteUrl: "https://glebe.example",
      category: ["florist", "retail"],
      tags: ["import-2026"],
    });
    // `AuditSummary` is counts-only, so the changed fields are carried as one
    // key each rather than as a list of names.
    expect(lastAuditInsert()).toEqual({
      action: "crm.organisation.update",
      target: `${NAME} (${ORG_ID})`,
      summary: { fields: 2, name: 1, website_url: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
    // The browse surface renders name and location.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/organisations");
  });

  // `updateOrganisation` is a full replacement, not a patch: a field the form
  // leaves out is cleared. The action must pass the omission through rather
  // than quietly dropping the key, or the writer's contract stops holding.
  it("passes an omitted field through as absent rather than dropping it", async () => {
    signIn(["crm"]);
    vi.mocked(updateOrganisation).mockResolvedValue({ changed: [] });

    await updateOrganisationAction(ORG_ID, editForm({ name: NAME }));

    expect(updateOrganisation).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      actor: "ava@tesserix.app",
      name: NAME,
      location: undefined,
      websiteUrl: undefined,
      category: [],
      tags: [],
    });
  });

  it("trims every field and drops blank list entries", async () => {
    signIn(["crm"]);
    vi.mocked(updateOrganisation).mockResolvedValue({ changed: [] });

    await updateOrganisationAction(
      ORG_ID,
      editForm({
        name: `  ${NAME}  `,
        location: "  Sydney  ",
        category: ["  florist  ", "   ", "retail"],
        tags: "   ",
      }),
    );

    expect(updateOrganisation).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      actor: "ava@tesserix.app",
      name: NAME,
      location: "Sydney",
      websiteUrl: undefined,
      category: ["florist", "retail"],
      tags: [],
    });
  });

  // A save that changed nothing still succeeded, and still gets an audit row
  // — `{ fields: 0 }`, the same honest zero `changeStage` writes for a
  // no-op transition. Not an empty summary, which would read as a summariser
  // that forgot to fill itself in.
  it("records a save that changed nothing as fields: 0", async () => {
    signIn(["crm"]);
    vi.mocked(updateOrganisation).mockResolvedValue({ changed: [] });

    const result = await updateOrganisationAction(ORG_ID, editForm({ name: NAME }));

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "crm.organisation.update",
      target: `${NAME} (${ORG_ID})`,
      summary: { fields: 0 },
    });
  });

  it("refuses a blank name before any session or database work", async () => {
    const result = await updateOrganisationAction(ORG_ID, editForm({ name: "   " }));

    expect(result).toEqual({ ok: false, message: "Enter an organisation name." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(updateOrganisation).not.toHaveBeenCalled();
  });

  it("refuses an unsafe website scheme before any session or database work", async () => {
    const result = await updateOrganisationAction(
      ORG_ID,
      editForm({ name: NAME, websiteUrl: "javascript:alert(1)" }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Website must be a web address starting with http:// or https://.",
    });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(updateOrganisation).not.toHaveBeenCalled();
  });

  // An edit is not a deletion: it sits with create at `withCrmWrite`'s
  // CRM surface gate, not `hard-delete`.
  it("gates an ordinary edit on the crm surface, not on read", async () => {
    signIn(["crm"]);
    vi.mocked(updateOrganisation).mockResolvedValue({ changed: [] });

    await updateOrganisationAction(ORG_ID, editForm({ name: NAME }));

    // #261 inverted this assertion, and the inversion IS the change. It used to
    // read `toBeUndefined()` — an ordinary edit passed no capability and so
    // inherited the `read` default, the console entry ticket every operator
    // holds. Editing the pipeline now requires the CRM surface explicitly.
    expect(vi.mocked(withCrmWrite).mock.calls[0][1]).toEqual({ capability: "crm" });
  });

  it("refuses without console entry", async () => {
    signIn(undefined);

    const result = await updateOrganisationAction(ORG_ID, editForm({ name: NAME }));

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(updateOrganisation).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
