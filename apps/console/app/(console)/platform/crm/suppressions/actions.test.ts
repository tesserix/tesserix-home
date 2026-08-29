import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/crm-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/crm-repo")>()),
  addSuppression: vi.fn(),
  removeSuppression: vi.fn(),
}));
// Ruling 15/17: goes through the REAL `auditedOperation`/`withCrmWrite`
// (neither is mocked) — only the two leaf dependencies are, exactly the way
// `[organisation]/actions.test.ts` tests the same shared wrapper. A passing
// test here is evidence about the actual control this app ships, not a copy
// of it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import { addSuppression, removeSuppression } from "@/lib/db/crm-repo";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { addSuppressionAction, removeSuppressionAction } from "./actions";

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
 *  occurredAt, metadata]`, per audit-repo.ts. */
function lastAuditInsert(): { actor: string; action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [actor, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { actor, action, target, summary: metadata ? JSON.parse(metadata) : null };
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

const SUPPRESSION_ROW = {
  id: "s1",
  email: "ava@example.com",
  instagramHandle: null,
  reason: "unsubscribed",
  createdBy: "ava@tesserix.app",
  createdAt: "2026-08-16T00:00:00.000Z",
};

describe("addSuppressionAction", () => {
  it("adds a suppression, audits crm.suppression.add under the actor's sub, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(addSuppression).mockResolvedValue(SUPPRESSION_ROW);

    const result = await addSuppressionAction({ email: "ava@example.com", reason: "unsubscribed" });

    expect(result).toEqual({ ok: true });
    expect(addSuppression).toHaveBeenCalledWith({
      email: "ava@example.com",
      instagramHandle: undefined,
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const audit = lastAuditInsert();
    // Critical 2's regression: the audit actor is the Zitadel `sub`, the same
    // identity shape `[organisation]/actions.ts` writes — not the operator's
    // email, which would leave `console_audit_log.actor` holding two
    // different kinds of value depending on which CRM surface wrote the row.
    expect(audit.actor).toBe("sub-1");
    expect(audit.action).toBe("crm.suppression.add");
    expect(audit.summary).toEqual({ added: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/suppressions");
  });

  // Minor 9: trimmed here, not only by the client form — a server action is
  // a network-reachable endpoint, and whitespace can arrive directly.
  it("trims email, instagram handle and reason server-side", async () => {
    signIn(["crm"]);
    vi.mocked(addSuppression).mockResolvedValue(SUPPRESSION_ROW);

    await addSuppressionAction({
      email: "  ava@example.com  ",
      instagramHandle: "  @bondibaker  ",
      reason: "  unsubscribed  ",
    });

    expect(addSuppression).toHaveBeenCalledWith({
      email: "ava@example.com",
      instagramHandle: "@bondibaker",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
  });

  it("refuses without either key, before touching the session", async () => {
    const result = await addSuppressionAction({ reason: "unsubscribed" });
    expect(result).toEqual({ ok: false, message: "Enter an email or an Instagram handle." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("refuses without a reason, before touching the session", async () => {
    const result = await addSuppressionAction({ email: "ava@example.com", reason: "   " });
    expect(result).toEqual({ ok: false, message: "Enter a reason." });
    expect(getCurrentSession).not.toHaveBeenCalled();
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("refuses without console entry", async () => {
    signIn(undefined);
    const result = await addSuppressionAction({ email: "ava@example.com", reason: "unsubscribed" });
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(addSuppression).not.toHaveBeenCalled();
  });

  // Critical 1's regression: a duplicate email hits
  // `crm_suppressions_email_uq` on the very next everyday add. The raw
  // Postgres message must never reach the operator verbatim.
  it("maps a duplicate-key violation to an operator-facing message, not the raw database error", async () => {
    signIn(["crm"]);
    vi.mocked(addSuppression).mockRejectedValue(
      new Error(
        'duplicate key value violates unique constraint "crm_suppressions_email_uq"',
      ),
    );

    const result = await addSuppressionAction({ email: "ava@example.com", reason: "unsubscribed" });

    expect(result).toEqual({
      ok: false,
      message: "That email or Instagram handle is already on the do-not-contact list.",
    });
  });

  // Guards the guard: an unrelated database error must still fall through to
  // the generic message, not leak either.
  it("maps any other database error to the generic message, not the raw text", async () => {
    signIn(["crm"]);
    vi.mocked(addSuppression).mockRejectedValue(new Error("connection terminated"));

    const result = await addSuppressionAction({ email: "ava@example.com", reason: "unsubscribed" });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
  });
});

describe("removeSuppressionAction", () => {
  it("removes a suppression, audits the real row count, and revalidates", async () => {
    signIn(["crm"]);
    vi.mocked(removeSuppression).mockResolvedValue([
      { id: "s1", email: "ava@example.com", instagramHandle: null },
    ]);

    const result = await removeSuppressionAction("s1");

    expect(result).toEqual({ ok: true });
    expect(removeSuppression).toHaveBeenCalledWith("s1");
    const audit = lastAuditInsert();
    expect(audit.actor).toBe("sub-1");
    expect(audit.action).toBe("crm.suppression.remove");
    expect(audit.summary).toEqual({ removed: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/crm/suppressions");
  });

  // Ruling 20: `console_audit_log.target` must hold the same kind of value
  // on both the add and the remove path — the suppression key, not a uuid
  // one direction and an email the other (the same divergence Critical 2
  // flagged for `actor`, one column over). The id is what `removeSuppression`
  // is looked up by; it must not be what gets audited once the row's real
  // key is known.
  it("audits the suppression's email as the target, not the uuid it was looked up by", async () => {
    signIn(["crm"]);
    vi.mocked(removeSuppression).mockResolvedValue([
      { id: "s1", email: "ava@example.com", instagramHandle: null },
    ]);

    await removeSuppressionAction("s1");

    const audit = lastAuditInsert();
    expect(audit.target).toBe("ava@example.com");
    expect(audit.target).not.toBe("s1");
  });

  it("audits the instagram handle as the target when there is no email", async () => {
    signIn(["crm"]);
    vi.mocked(removeSuppression).mockResolvedValue([
      { id: "s1", email: null, instagramHandle: "bondibaker" },
    ]);

    await removeSuppressionAction("s1");

    expect(lastAuditInsert().target).toBe("bondibaker");
  });

  // Important 3: a DELETE that matched nothing must not be recorded as a
  // removal that happened.
  it("audits removed: 0 when the id no longer matches anything, rather than assuming success", async () => {
    signIn(["crm"]);
    vi.mocked(removeSuppression).mockResolvedValue([]);

    const result = await removeSuppressionAction("missing");

    expect(result).toEqual({ ok: true });
    const audit = lastAuditInsert();
    expect(audit.summary).toEqual({ removed: 0 });
    // No row means no key to report — the uuid is the only identifier this
    // call ever had, so it's the only honest fallback.
    expect(audit.target).toBe("missing");
  });

  it("refuses without console entry, before the repo is touched, and audits the refusal", async () => {
    // #409 task 3 — see `crm-write.test.ts` for the full rationale: the
    // capability check now runs inside `auditedOperation`, so this refusal
    // writes a `capability.refused` row instead of writing nothing.
    signIn(undefined);
    const result = await removeSuppressionAction("s1");
    expect(result).toEqual({
      ok: false,
      message: "You don't have permission to edit the CRM.",
    });
    expect(removeSuppression).not.toHaveBeenCalled();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });

  // The `isDatabaseConfigured` short-circuit still runs before ANY operation
  // logic — see the ordering decision documented in `crm-write.ts`'s
  // `withCrmWrite`: with no database, the capability check inside `operation`
  // never runs either, so nothing is written even for an operator who would
  // have been refused.
  it("with no database configured, refuses before the capability check runs, and writes nothing", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(undefined);

    const result = await removeSuppressionAction("s1");

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(removeSuppression).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  it("maps a database-unavailable failure to a generic message, and writes no audit row", async () => {
    signIn(["crm"]);
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const result = await removeSuppressionAction("s1");

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(removeSuppression).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
  });

  // Same property `[organisation]/actions.test.ts` pins for `changeStage`: a
  // failed audit write must discard the result rather than report success.
  it("discards the result when the audit write fails, and does not report success", async () => {
    signIn(["crm"]);
    vi.mocked(removeSuppression).mockResolvedValue([
      { id: "s1", email: "ava@example.com", instagramHandle: null },
    ]);
    vi.mocked(tesserixQuery).mockRejectedValue(new Error("connection terminated"));

    const result = await removeSuppressionAction("s1");

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
    expect(removeSuppression).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
