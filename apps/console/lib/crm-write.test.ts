import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/operator")>()),
  checkOperatorCapability: vi.fn(),
}));
// Ruling 15/17: goes through the REAL `auditedOperation` (not mocked) —
// only its leaf dependency is, the same way `suppressions/actions.test.ts`
// tests this wrapper's caller. A passing test here is evidence about the
// actual control this app ships, not a copy of it.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapability } from "@/lib/auth/operator";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { withCrmWrite } from "./crm-write";

const description = { action: "crm.test.action", summary: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles: ["read"],
    iat: 0,
    exp: 0,
  } as never);
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
  // `vi.clearAllMocks()` clears call history, not a mock's implementation —
  // a throwing `mockImplementation` set by one test would otherwise leak
  // into the next. Reset to "capability granted" explicitly every time.
  vi.mocked(checkOperatorCapability).mockImplementation(() => undefined);
});

describe("withCrmWrite", () => {
  // #261 removed the default. This used to read "gates on read by default, so
  // existing callers are unchanged" — and that default is exactly how 11 of 14
  // mutating actions ended up on the console entry ticket: a caller inherited
  // the weakest gate in the system by saying nothing. There is no default left
  // to test, so the property is that the caller names one, which the compiler
  // now enforces.
  it("gates on the capability the caller names", async () => {
    await withCrmWrite("crm:org", { capability: "crm" }, async () => "ok", () => description);
    expect(checkOperatorCapability).toHaveBeenCalledWith(expect.anything(), "crm");
  });

  it("gates a verb on the verb, not on the surface it is reached from", async () => {
    // Orthogonality: erasure happens from a CRM surface but gates on
    // `hard-delete`. Holding `crm` must not carry the right to erase.
    await withCrmWrite("crm:org", { capability: "hard-delete" }, async () => "ok", () => description);
    expect(checkOperatorCapability).toHaveBeenCalledWith(expect.anything(), "hard-delete");
  });

  it("returns the permission message and never runs the operation when the gate fails", async () => {
    vi.mocked(checkOperatorCapability).mockImplementation(() => {
      throw new CapabilityError("hard-delete");
    });
    const run = vi.fn();
    const result = await withCrmWrite("crm:org", { capability: "hard-delete" }, run, () => description);
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "You don't have permission to edit the CRM." });
  });

  // #409 task 3: the gap this task closes. Before this change,
  // `checkOperatorCapability` ran BEFORE `auditedOperation`, so a thrown
  // `CapabilityError` never reached it and no row was written — a deliberate
  // refusal indistinguishable, on paper, from a request that was never made.
  // Breaks if the capability check in `withCrmWrite` moves back outside
  // `operation`.
  it("writes an audit row for a CapabilityError refusal, naming the required capability", async () => {
    vi.mocked(checkOperatorCapability).mockImplementation(() => {
      throw new CapabilityError("hard-delete");
    });
    const run = vi.fn();

    const result = await withCrmWrite("crm:org", { capability: "hard-delete" }, run, () => description);

    // The caller's own contract is unchanged: same shape, same message, as
    // before this task. Auditing changes what is RECORDED, never what the
    // caller sees.
    expect(result).toEqual({ ok: false, message: "You don't have permission to edit the CRM." });
    expect(run).not.toHaveBeenCalled();
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    const [actor, action, target, , metadata] = params as [
      string,
      string,
      string | null,
      string,
      string | null,
    ];
    expect(actor).toBe("sub-1");
    expect(action).toBe("capability.refused");
    expect(target).toBe("crm:org");
    expect(JSON.parse(metadata as string)).toEqual({ hard_delete: 1 });
  });

  // Pins the ordering decision (#409 task 3): `auditedOperation` refuses
  // BEFORE running `operation` at all when the database is not configured,
  // so a capability check that now lives inside `operation` never runs
  // either. The caller sees `AuditUnavailableError`'s message, not
  // `CapabilityError`'s — fail-closed on auditability, even though the
  // capability itself would also have been refused. Breaks if the capability
  // check moves back outside `operation`, which would run it regardless of
  // whether a database is configured.
  it("fails closed on AuditUnavailableError before the capability check runs, when no database is configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    vi.mocked(checkOperatorCapability).mockImplementation(() => {
      throw new CapabilityError("hard-delete");
    });
    const run = vi.fn();

    const result = await withCrmWrite("crm:org", { capability: "hard-delete" }, run, () => description);

    expect(checkOperatorCapability).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(tesserixQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "That change was not saved." });
  });

  // Breaks if a second write (of the audit row, or of anything else) sneaks
  // into the success path.
  it("writes exactly one audit row for a successful write", async () => {
    const result = await withCrmWrite("crm:org", { capability: "crm" }, async () => "ok", () => description);

    expect(result).toEqual({ ok: true, value: "ok" });
    expect(tesserixQuery).toHaveBeenCalledTimes(1);
  });
});
