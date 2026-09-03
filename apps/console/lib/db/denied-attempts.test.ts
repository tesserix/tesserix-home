import { beforeEach, describe, expect, it, vi } from "vitest";

const writeAuditEntry = vi.fn();
vi.mock("./audit-repo", () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
}));

const { recordDeniedAttempt, resetDeniedAttemptCollapsing } = await import("./denied-attempts");

const SURFACE = {
  actor: "zitadel-operator-1",
  required: "platform",
  target: "/platform/secrets",
  kind: "surface",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetDeniedAttemptCollapsing();
  writeAuditEntry.mockResolvedValue(undefined);
});

describe("recording a denied attempt", () => {
  it("records the actor, the required capability and the target", async () => {
    await recordDeniedAttempt(SURFACE);

    expect(writeAuditEntry).toHaveBeenCalledWith({
      actor: "zitadel-operator-1",
      action: "capability.refused.surface",
      target: "/platform/secrets",
      summary: { platform: 1 },
    });
  });

  // A burst of surface refusals is someone probing the estate; a verb refusal
  // is an operator meeting the edge of their own grant. Reading the timeline
  // for one without the other has to be possible.
  // The capability travels as a summary KEY, hyphens underscored — the shape
  // `refusalDescription` already uses for the refusals `auditedOperation`
  // writes, so one reader convention covers both paths.
  it("underscores a hyphenated capability, as the existing refusal rows do", async () => {
    await recordDeniedAttempt({ ...SURFACE, required: "rotate-credentials" });

    expect(writeAuditEntry.mock.calls[0][0].summary).toEqual({ rotate_credentials: 1 });
  });

  it("distinguishes a surface refusal from a verb refusal", async () => {
    await recordDeniedAttempt({ ...SURFACE, kind: "verb", target: "org-1" });

    expect(writeAuditEntry.mock.calls[0][0]).toMatchObject({
      action: "capability.refused.verb",
      target: "org-1",
    });
  });

  // THE RULE THIS MODULE EXISTS TO KEEP. `auditedOperation` fails closed
  // because an unaudited mutation is worse than a refused one. That does not
  // carry over: refusing to refuse because the log is down would turn a
  // logging outage into an access-control outage.
  it("never throws when the audit write fails", async () => {
    writeAuditEntry.mockRejectedValue(new Error("console_audit_log is unreachable"));

    await expect(recordDeniedAttempt(SURFACE)).resolves.toBeUndefined();
  });

  it("says so rather than failing silently when it cannot record", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAuditEntry.mockRejectedValue(new Error("down"));

    await recordDeniedAttempt(SURFACE);

    // "denials stopped being recorded" is itself worth noticing.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the volume bound", () => {
  // A tight loop against a restricted URL must not be able to fill the audit
  // table — the acceptance asks for a bound, and this is it.
  it("collapses the same refusal repeated in a burst into one row", async () => {
    for (let i = 0; i < 50; i++) await recordDeniedAttempt(SURFACE);

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
  });

  // Collapsing must not become under-reporting. Each DISTINCT refusal is a
  // different fact and the first of each is always written.
  it("records each distinct refusal, and does not collapse across them", async () => {
    await recordDeniedAttempt(SURFACE);
    await recordDeniedAttempt({ ...SURFACE, target: "/platform/tenants" });
    await recordDeniedAttempt({ ...SURFACE, required: "crm" });
    await recordDeniedAttempt({ ...SURFACE, actor: "someone-else" });
    await recordDeniedAttempt({ ...SURFACE, kind: "verb" });

    expect(writeAuditEntry).toHaveBeenCalledTimes(5);
  });

  // A probing script must not be able to grow the tracking map without limit —
  // the same attack the collapsing blunts, one level up.
  it("does not grow its tracking map without bound", async () => {
    for (let i = 0; i < 10_050; i++) {
      await recordDeniedAttempt({ ...SURFACE, target: `/platform/probe-${i}` });
    }

    // Every distinct target is still recorded; what is bounded is the memory
    // used to remember them, not the honesty of the log.
    expect(writeAuditEntry).toHaveBeenCalledTimes(10_050);
  });
});
