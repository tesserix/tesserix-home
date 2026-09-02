import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
// The action is the boundary under test — the secrets-api client is stood
// in for wholesale, same discipline `crm/[organisation]/actions.test.ts`
// applies to its own leaf dependencies.
vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  createGrant: vi.fn(),
  proposeGrant: vi.fn(),
  revokeGrant: vi.fn(),
  deleteSecret: vi.fn(),
  restoreSecretVersion: vi.fn(),
}));
// `auditedOperation` itself is NOT mocked — only its leaf database calls
// are, so a passing test here is evidence about the real audit control
// this action wraps (including the `capability.refused` row on a refusal),
// not about a hand-rolled stand-in for it. Same pattern
// `billing/catalog/actions.test.ts` establishes.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { createGrant, proposeGrant, revokeGrant, deleteSecret, restoreSecretVersion } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  deleteSecretAction,
  grantAccessAction,
  proposeAccessAction,
  restoreSecretVersionAction,
  revokeAccessAction,
} from "./access-actions";

const NO_PERMISSION = "You don't have the platform and rotate-credentials capabilities this needs.";
const NOT_SAVED = "That change was not saved.";
const NO_PLATFORM = "You don't have the platform capability this needs.";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "operator-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The one write `writeAuditEntry` issues — `[actor, action, target,
 *  occurredAt, metadata]`, per `audit-repo.ts`. Mirrors
 *  `billing/catalog/actions.test.ts`'s own helper. */
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

describe("grantAccessAction", () => {
  it("calls createGrant with the three fields it was given, unchanged, on success", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(createGrant).mockResolvedValue(undefined);

    const result = await grantAccessAction({
      namespace: "homechef",
      app: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });

    expect(result).toEqual({ ok: true });
    expect(createGrant).toHaveBeenCalledWith({
      namespace: "homechef",
      name: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });
    expect(lastAuditInsert()).toEqual({
      action: "secrets.access.grant",
      target: "homechef/homechef-api",
      summary: { granted: 1 },
    });
  });

  it("refuses a CapabilityError with the fixed no-permission message, and audits the refusal", async () => {
    signIn(undefined);

    const result = await grantAccessAction({
      namespace: "homechef",
      app: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(createGrant).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("folds a PlatformApiError 403 into the SAME no-permission message a CapabilityError produces", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(createGrant).mockRejectedValue(new PlatformApiError("create grant: secrets-api returned 403", 403));

    const result = await grantAccessAction({
      namespace: "homechef",
      app: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
  });

  it("degrades any other failure to a fixed message, never passing the internal text through", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(createGrant).mockRejectedValue(
      new PlatformApiError("create grant: secrets-api returned 500", 500),
    );

    const result = await grantAccessAction({
      namespace: "homechef",
      app: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
  });

  it("the failure result carries no error instance and no cause — plain data only", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(createGrant).mockRejectedValue(new Error("boom, with a stack and everything"));

    const result = await grantAccessAction({
      namespace: "homechef",
      app: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
    expect(Object.keys(result)).toEqual(["ok", "message"]);
    expect((result as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("revokeAccessAction", () => {
  it("calls revokeGrant with namespace and app, unchanged, on success", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(revokeGrant).mockResolvedValue(undefined);

    const result = await revokeAccessAction("homechef", "homechef-api");

    expect(result).toEqual({ ok: true });
    expect(revokeGrant).toHaveBeenCalledWith("homechef", "homechef-api");
    expect(lastAuditInsert()).toEqual({
      action: "secrets.access.revoke",
      target: "homechef/homechef-api",
      summary: { revoked: 1 },
    });
  });

  it("refuses a CapabilityError with the fixed no-permission message, and audits the refusal", async () => {
    signIn(undefined);

    const result = await revokeAccessAction("homechef", "homechef-api");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(revokeGrant).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("folds a PlatformApiError 403 into the SAME no-permission message a CapabilityError produces", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(revokeGrant).mockRejectedValue(new PlatformApiError("revoke grant: secrets-api returned 403", 403));

    const result = await revokeAccessAction("homechef", "homechef-api");

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
  });

  it("degrades any other failure to a fixed message, never passing the internal text through", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(revokeGrant).mockRejectedValue(
      new PlatformApiError("revoke grant: secrets-api returned 500", 500),
    );

    const result = await revokeAccessAction("homechef", "homechef-api");

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
  });

  it("fails closed on AuditUnavailableError before the capability check, when no database is configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(undefined);

    const result = await revokeAccessAction("homechef", "homechef-api");

    expect(revokeGrant).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: NOT_SAVED });
  });
});

describe("deleteSecretAction", () => {
  it("calls deleteSecret with the store, path, and destroy flag unchanged, on a soft delete", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(deleteSecret).mockResolvedValue(undefined);

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", false);

    expect(result).toEqual({ ok: true });
    expect(deleteSecret).toHaveBeenCalledWith("openbao", "mark8ly/db-password", false);
    expect(lastAuditInsert()).toEqual({
      action: "secrets.delete",
      target: "mark8ly/db-password",
      summary: { destroyed: 0, deleted: 1 },
    });
  });

  it("calls deleteSecret with destroy: true unchanged, on a destroy", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(deleteSecret).mockResolvedValue(undefined);

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", true);

    expect(result).toEqual({ ok: true });
    expect(deleteSecret).toHaveBeenCalledWith("openbao", "mark8ly/db-password", true);
    expect(lastAuditInsert()).toEqual({
      action: "secrets.destroy",
      target: "mark8ly/db-password",
      summary: { destroyed: 1, deleted: 0 },
    });
  });

  it("refuses a CapabilityError with the fixed no-permission message, and audits the refusal", async () => {
    signIn(undefined);

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", true);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  // `withAccessWrite` checks `platform` AND `rotate-credentials` — both,
  // never as alternatives (see that function's own doc comment). Every
  // other test in this file signs in with `undefined` (fails on the very
  // first check) or with both capabilities present (passes both), so
  // neither proves the SECOND check does anything: deleting the
  // `rotate-credentials` check would satisfy every other test in this file
  // unchanged. These two cases hold one capability back at a time, so each
  // is refused only if ITS check is actually still there.
  it("refuses an operator who holds `platform` but not `rotate-credentials`", async () => {
    signIn(["platform"]);

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", true);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("refuses an operator who holds `rotate-credentials` but not `platform`", async () => {
    signIn(["rotate-credentials"]);

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", true);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("folds a PlatformApiError 403 into the SAME no-permission message a CapabilityError produces", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(deleteSecret).mockRejectedValue(
      new PlatformApiError("delete secret: secrets-api returned 403", 403),
    );

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", false);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
  });

  it("degrades any other failure to a fixed message, never passing the internal text through", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(deleteSecret).mockRejectedValue(
      new PlatformApiError("delete secret: secrets-api returned 500", 500),
    );

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", false);

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
  });

  it("the failure result carries no error instance and no cause — plain data only", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(deleteSecret).mockRejectedValue(new Error("boom, with a stack and everything"));

    const result = await deleteSecretAction("openbao", "mark8ly/db-password", true);

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
    expect(Object.keys(result)).toEqual(["ok", "message"]);
    expect((result as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("restoreSecretVersionAction", () => {
  it("calls restoreSecretVersion with the store, path, and version unchanged", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(restoreSecretVersion).mockResolvedValue(undefined);

    const result = await restoreSecretVersionAction("openbao", "mark8ly/db-password", 2);

    expect(result).toEqual({ ok: true });
    expect(restoreSecretVersion).toHaveBeenCalledWith("openbao", "mark8ly/db-password", 2);
    expect(lastAuditInsert()).toEqual({
      action: "secrets.restore",
      target: "mark8ly/db-password",
      summary: { restored: 1, version: 2 },
    });
  });

  it("refuses a CapabilityError with the fixed no-permission message, and audits the refusal", async () => {
    signIn(undefined);

    const result = await restoreSecretVersionAction("openbao", "mark8ly/db-password", 2);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(restoreSecretVersion).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  // The same pair `deleteSecretAction` uses, and for the same reason: with
  // only the `undefined`-roles case above and the both-capabilities case
  // at the top, deleting either capability check would leave this describe
  // passing unchanged.
  it("refuses an operator who holds `platform` but not `rotate-credentials`", async () => {
    signIn(["platform"]);

    const result = await restoreSecretVersionAction("openbao", "mark8ly/db-password", 2);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(restoreSecretVersion).not.toHaveBeenCalled();
  });

  it("refuses an operator who holds `rotate-credentials` but not `platform`", async () => {
    signIn(["rotate-credentials"]);

    const result = await restoreSecretVersionAction("openbao", "mark8ly/db-password", 2);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(restoreSecretVersion).not.toHaveBeenCalled();
  });

  // A destroyed version reaching here — the control never offers one, but
  // nothing stops a direct call — is refused by secrets-api, not by this
  // boundary, and its internal text must not reach the operator.
  it("degrades secrets-api's refusal of a destroyed version to the fixed message", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(restoreSecretVersion).mockRejectedValue(
      new PlatformApiError("restore secret version: version 1 is destroyed", 400),
    );

    const result = await restoreSecretVersionAction("openbao", "mark8ly/db-password", 1);

    expect(result).toEqual({ ok: false, message: NOT_SAVED });
  });
});

describe("proposeAccessAction", () => {
  const PULL_REQUEST = "https://github.com/tesserix/tesserix-k8s/pull/7";

  const INPUT = {
    namespace: "homechef",
    app: "homechef-api",
    serviceAccount: "homechef-api-sa",
  } as const;

  // THE WHOLE POINT OF tesserix-home#482. A `platform`-only operator is
  // exactly who this path exists for; requiring `rotate-credentials` here
  // would reproduce the refusal it removes.
  it("proposes for a platform-only operator, with no rotate-credentials", async () => {
    signIn(["platform"]);
    vi.mocked(proposeGrant).mockResolvedValue({ status: "proposed", pullRequest: PULL_REQUEST });

    const result = await proposeAccessAction({ ...INPUT });

    expect(result).toEqual({ ok: true, status: "proposed", pullRequest: PULL_REQUEST });
    // The arguments, not merely that it was called: `app` becomes `name` on
    // the `AppRef`, and a silent swap of the two would still "call" it.
    expect(proposeGrant).toHaveBeenCalledWith({
      namespace: "homechef",
      name: "homechef-api",
      serviceAccount: "homechef-api-sa",
    });
    expect(lastAuditInsert()).toEqual({
      action: "secrets.access.propose",
      target: "homechef/homechef-api",
      summary: { proposed: 1, unchanged: 0 },
    });
  });

  it("never reaches the immediate-grant route", async () => {
    signIn(["platform"]);
    vi.mocked(proposeGrant).mockResolvedValue({ status: "proposed", pullRequest: PULL_REQUEST });

    await proposeAccessAction({ ...INPUT });

    expect(createGrant).not.toHaveBeenCalled();
  });

  // `unchanged` is a SUCCESS carrying no URL — reporting it as a failure
  // would tell an operator their proposal broke when the state they asked
  // for already held.
  it("reports unchanged as a success, with no pullRequest, and audits it distinguishably", async () => {
    signIn(["platform"]);
    vi.mocked(proposeGrant).mockResolvedValue({ status: "unchanged" });

    const result = await proposeAccessAction({ ...INPUT });

    expect(result).toEqual({ ok: true, status: "unchanged" });
    expect(result).not.toHaveProperty("pullRequest");
    expect(lastAuditInsert()).toEqual({
      action: "secrets.access.propose",
      target: "homechef/homechef-api",
      summary: { proposed: 0, unchanged: 1 },
    });
  });

  it("refuses an operator without platform, and audits the refusal", async () => {
    signIn(["rotate-credentials"]);

    const result = await proposeAccessAction({ ...INPUT });

    expect(result).toEqual({ ok: false, message: NO_PLATFORM });
    expect(proposeGrant).not.toHaveBeenCalled();
    // Inside `auditedOperation`, not before it — a refused proposal is
    // recorded rather than vanishing.
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  // The refusal copy must not name a capability this path never asks for.
  it("does not tell a refused operator they are missing rotate-credentials", async () => {
    signIn(["rotate-credentials"]);

    const result = await proposeAccessAction({ ...INPUT });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toMatch(/rotate-credentials/);
  });

  it("folds a 403 from secrets-api into the same no-platform message", async () => {
    signIn(["platform"]);
    vi.mocked(proposeGrant).mockRejectedValue(
      new PlatformApiError("propose grant: secrets-api returned 403", 403),
    );

    expect(await proposeAccessAction({ ...INPUT })).toEqual({ ok: false, message: NO_PLATFORM });
  });

  // 503 (no whitelist repository configured) and 502 (the proposer failed)
  // are not things an operator can act on, and the upstream text can carry
  // secrets-api's origin — so both degrade to the fixed sentence.
  it("degrades a 503 to the fixed not-saved sentence, leaking no upstream text", async () => {
    signIn(["platform"]);
    vi.mocked(proposeGrant).mockRejectedValue(
      new PlatformApiError("propose grant: no whitelist repository is configured", 503),
    );

    expect(await proposeAccessAction({ ...INPUT })).toEqual({ ok: false, message: NOT_SAVED });
  });
});
