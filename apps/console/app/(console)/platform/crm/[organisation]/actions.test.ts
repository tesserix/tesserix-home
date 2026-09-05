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
vi.mock("@/lib/db/crm-void", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-void")>()),
  voidOpportunity: vi.fn(),
  restoreOpportunity: vi.fn(),
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
  VoidedOpportunityError,
} from "@/lib/db/crm-repo";
import { voidOpportunity, restoreOpportunity } from "@/lib/db/crm-void";
import { saveNextAction as setNextAction } from "@/lib/crm-queues";
import {
  createContact,
  createOpportunity as createOpportunityRow,
  updateOrganisation,
  DuplicateContactError,
} from "@/lib/db/crm-writes";
import { eraseContact, deleteOrganisation } from "@/lib/db/crm-erasure";
import { ErasureHashKeyMissingError } from "@/lib/db/crm-erasure-hash";
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
  voidOpportunityAction,
  restoreOpportunityAction,
} from "./actions";
// Not from `actions.ts`: that module is `"use server"` and may export only
// async functions, which is also why the control (T5) reads the cap from
// here for its own `maxLength`.
import { MAX_VOID_REASON_LENGTH } from "@/lib/crm-void-reason";

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

    const result = await addContactAction({
      organisationId: ORG_ID,
      email: "gone@example.com",
      lawfulBasis: "legitimate_interests",
    });

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

    const result = await addContactAction({
      organisationId: ORG_ID,
      email: "taken@example.com",
      lawfulBasis: "legitimate_interests",
    });

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

    const result = await addContactAction({
      organisationId: ORG_ID,
      instagramHandle: "takenshop",
      lawfulBasis: "legitimate_interests",
    });

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
      lawfulBasis: "legitimate_interests",
    });

    expect(result).toEqual({ ok: true });
    expect(createContact).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      name: "Ava",
      email: "ava@example.com",
      phone: undefined,
      instagramHandle: undefined,
      // #248: the path, not the batch — see `CONTACT_SOURCE`.
      source: "manual",
      lawfulBasis: "legitimate_interests",
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
      lawfulBasis: "  legitimate_interests  ",
    });

    expect(createContact).toHaveBeenCalledWith({
      organisationId: ORG_ID,
      name: "Ava",
      email: undefined,
      phone: "0400 000 000",
      instagramHandle: "@bondibaker",
      source: "manual",
      lawfulBasis: "legitimate_interests",
    });
  });

  // #248. A manually typed contact has a different basis from a scraped
  // profile, so the action refuses rather than defaulting — a silent default
  // is exactly the failure this issue reports. These are the tests that fail
  // when the boundary check is removed.
  it("refuses a hand-typed contact with no lawful basis, and never calls createContact", async () => {
    signIn(["crm"]);
    const result = await addContactAction({ organisationId: ORG_ID, name: "Ava" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/lawful basis/i);
    expect(createContact).not.toHaveBeenCalled();
  });

  it("refuses free text as a lawful basis", async () => {
    signIn(["crm"]);
    const result = await addContactAction({
      organisationId: ORG_ID,
      name: "Ava",
      lawfulBasis: "seemed fine",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/not a lawful basis/i);
    expect(createContact).not.toHaveBeenCalled();
  });

  it("refuses the pre-migration marker as a choice for a new contact", async () => {
    // Valid to HOLD — every contact in production carries it — and never
    // valid to CHOOSE. Offering it would let an operator record "we do not
    // know" going forward.
    signIn(["crm"]);
    const result = await addContactAction({
      organisationId: ORG_ID,
      name: "Ava",
      lawfulBasis: "not_recorded_pre_migration",
    });

    expect(result.ok).toBe(false);
    expect(createContact).not.toHaveBeenCalled();
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
    const result = await addContactAction({
      organisationId: ORG_ID,
      name: "Ava",
      lawfulBasis: "legitimate_interests",
    });
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
      activitiesPendingRedaction: [],
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true, pendingRedaction: 0 });
    expect(eraseContact).toHaveBeenCalledWith(CONTACT_ID);
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.erase",
      target: `Priya Raman (${CONTACT_ID})`,
      summary: { erased: 1, pending_redaction: 0 },
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
      activitiesPendingRedaction: [],
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
      summary: { erased: 0, pending_redaction: 0 },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the contact was NOT erased when CRM_ERASURE_HASH_KEY is missing (#226)", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockRejectedValue(new ErasureHashKeyMissingError());

    const result = await eraseContactAction(CONTACT_ID);

    // The shared wrapper's default here is "That change was not saved",
    // which reads as transient and would have an operator clicking forever.
    // This is a deployment fault with a named remedy, and — the part that
    // matters for a DPDP request — the operator must not walk away believing
    // the person was forgotten.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("NOT erased");
      expect(result.message).toContain("CRM_ERASURE_HASH_KEY");
    }
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
      activitiesPendingRedaction: [],
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true, pendingRedaction: 0 });
    expect(lastAuditInsert()).toEqual({
      action: "crm.contact.erase",
      target: `[erased] (${CONTACT_ID})`,
      summary: { erased: 0, pending_redaction: 0 },
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
      activitiesPendingRedaction: [],
    });
    await eraseContactAction(CONTACT_ID);
    const firstSummary = lastAuditInsert().summary;

    vi.mocked(eraseContact).mockResolvedValueOnce({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "[erased]",
      erasedAt: "2026-01-01T00:00:00.000Z",
      activitiesPendingRedaction: [],
    });
    await eraseContactAction(CONTACT_ID);
    const secondSummary = lastAuditInsert().summary;

    expect(firstSummary).toEqual({ erased: 1, pending_redaction: 0 });
    expect(secondSummary).toEqual({ erased: 0, pending_redaction: 0 });
    expect(secondSummary).not.toEqual(firstSummary);
  });

  // #507. An erasure that could not finish must say so on BOTH surfaces this
  // action owns: the operator standing at the dialog, and the audit row later
  // read as evidence the request was honoured. A row claiming `erased: 1`
  // with no mention of what survived overstates what happened.
  it("reports the outreach it could not finish, to the operator and to the audit log", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      erasedAt: null,
      activitiesPendingRedaction: ["activity-1", "activity-2"],
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true, pendingRedaction: 2 });
    expect(lastAuditInsert().summary).toEqual({ erased: 1, pending_redaction: 2 });
  });

  // A count is what a caller is handed, never the ids and never the text —
  // this value flows out towards a screen, and the whole reason those rows
  // are a problem is that what they hold must not be reproduced anywhere new.
  it("hands the caller a count, not the activity ids", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "Priya Raman",
      erasedAt: null,
      activitiesPendingRedaction: ["activity-1", "activity-2"],
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(JSON.stringify(result)).not.toContain("activity-1");
  });

  // The mirror of `erased: 0` above, and the opposite answer: a second click
  // erased nothing NEW, but the outstanding rows are as outstanding as they
  // were a minute ago. Zeroing this alongside `erased` would make a repeat
  // click the thing that makes an unfinished erasure look finished.
  it("still reports the outstanding rows when the contact was already erased", async () => {
    signIn(["hard-delete"]);
    vi.mocked(eraseContact).mockResolvedValue({
      contactId: CONTACT_ID,
      organisationId: ORG_ID,
      previousName: "[erased]",
      erasedAt: "2026-01-01T00:00:00.000Z",
      activitiesPendingRedaction: ["activity-1"],
    });

    const result = await eraseContactAction(CONTACT_ID);

    expect(result).toEqual({ ok: true, pendingRedaction: 1 });
    expect(lastAuditInsert().summary).toEqual({ erased: 0, pending_redaction: 1 });
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
      activitiesPendingRedaction: [],
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

describe("voidOpportunityAction", () => {
  /** What `voidOpportunity` returns for the fixture deal, in one place. */
  const VOIDED = {
    voided: true,
    opportunityId: OPP_ID,
    organisationId: ORG_ID,
    organisationName: "Glebe Flowers",
    product: "mark8ly",
  };

  it("gates the void on crm, not hard-delete", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue(VOIDED);

    await voidOpportunityAction(OPP_ID, null);

    const options = vi.mocked(withCrmWrite).mock.calls[0][1];
    // A void destroys nothing and is reversible, so it is an ordinary CRM
    // correction — the same distinction `updateContactAction` draws. Gating
    // it on `hard-delete` is what pushed operators onto destructive paths
    // for everyday mistakes in the first place (#251).
    expect(options).toEqual(expect.objectContaining({ capability: "crm" }));
  });

  it("refuses a session carrying no roles at all", async () => {
    // Not a hypothetical: a session can arrive with `roles` undefined, and
    // the gate has to fail closed on it rather than treating "no roles
    // stated" as "no roles required".
    signIn(undefined);

    const result = await voidOpportunityAction(OPP_ID, "Duplicate");

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(voidOpportunity).not.toHaveBeenCalled();
  });

  it("voids, audits crm.opportunity.void, and revalidates the detail page and the queues", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue(VOIDED);

    const result = await voidOpportunityAction(OPP_ID, "Duplicate of the other deal");

    expect(result).toEqual({ ok: true });
    expect(voidOpportunity).toHaveBeenCalledWith({
      opportunityId: OPP_ID,
      reason: "Duplicate of the other deal",
      actor: "ava@tesserix.app",
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.opportunity.void",
      // An opportunity has no name of its own: whose business it was and
      // what it was for are what make the row readable. The reason is NOT
      // here — `AuditSummary` is counts only, and free operator text belongs
      // on the deal and its activity, not in the audit log.
      target: `Glebe Flowers — mark8ly (${OPP_ID})`,
      // A void has no collateral to count. `voided: 1` says one deal left
      // the funnel and nothing else is claimed.
      summary: { voided: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
    // The Due and Drifting queues are lists of opportunities and a voided
    // deal has just left them.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm");
  });

  it("says so in the audit target when the deal had no product", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue({ ...VOIDED, product: null });

    await voidOpportunityAction(OPP_ID, null);

    // "(no product)" rather than an empty gap, so the row cannot be misread
    // as a truncation. The mis-clicked duplicate #251 is about is exactly
    // this row: `new`, no product.
    expect(lastAuditInsert().target).toBe(`Glebe Flowers — (no product) (${OPP_ID})`);
  });

  it("reports an already-voided deal as a zero-count void, not as a change", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue({ ...VOIDED, voided: false });

    const result = await voidOpportunityAction(OPP_ID, "Duplicate");

    // A second click is not a failure — the deal is out of the funnel,
    // which is what the operator asked for.
    expect(result).toEqual({ ok: true });
    // But the audit row must not claim a second void happened.
    expect(lastAuditInsert()).toEqual({
      action: "crm.opportunity.void",
      target: `Glebe Flowers — mark8ly (${OPP_ID})`,
      summary: { voided: 0 },
    });
    // Revalidated anyway: a no-op means the page the operator acted from
    // showed a live deal the database says is already voided, so this is
    // precisely the case where a refresh is owed.
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
  });

  it("refuses a grandfathered row with the repo's own message, not the generic one", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockRejectedValue(new MissingProductError(OPP_ID));

    const result = await voidOpportunityAction(OPP_ID, "Bad import");

    expect(result.ok).toBe(false);
    // The 0021 CHECK is re-evaluated on the void's UPDATE, so this is a real
    // refusal an operator can act on — degrading it to "That change was not
    // saved." tells them nothing about what to do next.
    expect(result.ok === false && result.message).toMatch(/product/i);
    expect(result.ok === false && result.message).not.toBe("That change was not saved.");
  });

  it("refuses a reason longer than the cap, before any session or database work", async () => {
    signIn(["crm"]);

    const result = await voidOpportunityAction(OPP_ID, "x".repeat(MAX_VOID_REASON_LENGTH + 1));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/too long/i);
    expect(voidOpportunity).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("accepts a reason exactly at the cap", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue(VOIDED);
    const reason = "x".repeat(MAX_VOID_REASON_LENGTH);

    const result = await voidOpportunityAction(OPP_ID, reason);

    expect(result).toEqual({ ok: true });
    expect(voidOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ reason }),
    );
  });

  it("measures the cap against the trimmed reason, which is what gets stored", async () => {
    signIn(["crm"]);
    vi.mocked(voidOpportunity).mockResolvedValue(VOIDED);

    const result = await voidOpportunityAction(OPP_ID, `  ${"x".repeat(MAX_VOID_REASON_LENGTH)}  `);

    // `voidOpportunity` trims before storing, so padding is not length.
    expect(result).toEqual({ ok: true });
  });
});

describe("restoreOpportunityAction", () => {
  const RESTORED = {
    restored: true,
    opportunityId: OPP_ID,
    organisationId: ORG_ID,
    organisationName: "Glebe Flowers",
    product: "mark8ly",
  };

  it("gates the restore on crm, not hard-delete", async () => {
    signIn(["crm"]);
    vi.mocked(restoreOpportunity).mockResolvedValue(RESTORED);

    await restoreOpportunityAction(OPP_ID);

    const options = vi.mocked(withCrmWrite).mock.calls[0][1];
    expect(options).toEqual(expect.objectContaining({ capability: "crm" }));
  });

  it("refuses a session carrying no roles at all", async () => {
    signIn(undefined);

    const result = await restoreOpportunityAction(OPP_ID);

    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(restoreOpportunity).not.toHaveBeenCalled();
  });

  it("restores, audits crm.opportunity.restore, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(restoreOpportunity).mockResolvedValue(RESTORED);

    const result = await restoreOpportunityAction(OPP_ID);

    expect(result).toEqual({ ok: true });
    expect(restoreOpportunity).toHaveBeenCalledWith({
      opportunityId: OPP_ID,
      actor: "ava@tesserix.app",
    });
    expect(lastAuditInsert()).toEqual({
      action: "crm.opportunity.restore",
      target: `Glebe Flowers — mark8ly (${OPP_ID})`,
      summary: { restored: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/crm/${ORG_ID}`);
    // A restored deal rejoins the queues it left.
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm");
  });

  it("reports an already-live deal as a zero-count restore", async () => {
    signIn(["crm"]);
    vi.mocked(restoreOpportunity).mockResolvedValue({ ...RESTORED, restored: false });

    const result = await restoreOpportunityAction(OPP_ID);

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "crm.opportunity.restore",
      target: `Glebe Flowers — mark8ly (${OPP_ID})`,
      summary: { restored: 0 },
    });
  });

  it("refuses a grandfathered row with the repo's own message", async () => {
    signIn(["crm"]);
    vi.mocked(restoreOpportunity).mockRejectedValue(new MissingProductError(OPP_ID));

    const result = await restoreOpportunityAction(OPP_ID);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/product/i);
    expect(result.ok === false && result.message).not.toBe("That change was not saved.");
  });
});

describe("the voided-deal refusal reaching the operator", () => {
  // `VoidedOpportunityError` is raised by `advanceStageOnQuery` and
  // `setNextAction` (crm-repo.ts), and by nothing else a CRM action reaches:
  // the DM path moves a stage only for deals `CLOCK_ELIGIBLE_SQL` returned,
  // and that predicate already excludes a voided row. So these are the two
  // actions that owe it a mapping — the detail page keeps voided deals
  // visible, so both controls are on screen for one.
  it("tells the operator to restore the deal when a stage change is refused", async () => {
    signIn(["crm"]);
    vi.mocked(advanceStage).mockRejectedValue(new VoidedOpportunityError(OPP_ID));

    const result = await changeStage({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      to: "contacted",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/restore it first/i);
    expect(result.ok === false && result.message).not.toBe("That change was not saved.");
  });

  it("tells the operator to restore the deal when a next action is refused", async () => {
    signIn(["crm"]);
    vi.mocked(setNextAction).mockRejectedValue(new VoidedOpportunityError(OPP_ID));

    const result = await scheduleNextAction({
      organisationId: ORG_ID,
      opportunityId: OPP_ID,
      at: null,
      note: null,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/restore it first/i);
    expect(result.ok === false && result.message).not.toBe("That change was not saved.");
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
