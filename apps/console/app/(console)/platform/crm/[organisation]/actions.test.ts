import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  advanceStage: vi.fn(),
  setNextAction: vi.fn(),
  logActivity: vi.fn(),
}));
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
import { advanceStage, setNextAction, logActivity, MissingProductError } from "@/lib/db/crm-repo";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { changeStage, scheduleNextAction, addActivity } from "./actions";

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
    signIn(["read"]);
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
    signIn(["read"]);
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
    signIn(["read"]);
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

  it("refuses without console entry, before any transport or audit call", async () => {
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
    expect(tesserixQuery).not.toHaveBeenCalled();
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
    signIn(["read"]);
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
    signIn(["read"]);
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
  });
});

describe("scheduleNextAction", () => {
  it("schedules the next action, audits it, and revalidates", async () => {
    signIn(["read"]);
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
    signIn(["read"]);
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
    signIn(["read"]);
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

  it("rejects an attempt to log an assigned activity directly", async () => {
    const result = await addActivity({
      organisationId: ORG_ID,
      kind: "assigned",
    });
    expect(result.ok).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
  });
});
