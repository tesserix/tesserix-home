import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
// The action is the boundary under test — the secrets-api client is stood
// in for wholesale, same discipline `access-actions.test.ts` applies to its
// own leaf dependencies.
vi.mock("@/lib/secrets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets-api")>()),
  approveProposal: vi.fn(),
  mergeProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));
// `auditedOperation` itself is NOT mocked — only its leaf database calls
// are, so a passing test here is evidence about the real audit control this
// action wraps (including the `capability.refused` row on a refusal), not
// about a hand-rolled stand-in for it. Same pattern `access-actions.test.ts`
// establishes.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { approveProposal, mergeProposal, rejectProposal } from "@/lib/secrets-api";
import { PlatformApiError } from "@/lib/platform-api-error";
import { tesserixQuery, isDatabaseConfigured } from "@/lib/db/tesserix";
import { approveAndMergeAction, rejectProposalAction } from "./actions";

const NO_PERMISSION = "You don't have permission to act on this proposal.";

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "operator-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** Mirrors `access-actions.test.ts`'s helper of the same name. */
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

function auditInserts(): Array<{ action: string; target: string | null }> {
  return vi.mocked(tesserixQuery).mock.calls.map((call) => {
    const [, params] = call;
    const [, action, target] = params as [string, string, string | null];
    return { action, target };
  });
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

describe("approveAndMergeAction", () => {
  it("approves then merges, in that order, on success", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(approveProposal).mockResolvedValue(undefined);
    vi.mocked(mergeProposal).mockResolvedValue({ number: 42, sha: "abc123" });

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: true });
    expect(approveProposal).toHaveBeenCalledWith(42);
    expect(mergeProposal).toHaveBeenCalledWith(42);
    // Two audit rows, approve before merge — the same separate rows
    // secrets-api's own handler writes (`ActionReviewApprove`/
    // `ActionReviewMerge`).
    expect(auditInserts()).toEqual([
      { action: "secrets.review.approve", target: "pull/42" },
      { action: "secrets.review.merge", target: "pull/42" },
    ]);
  });

  it("does not call mergeProposal at all when approveProposal fails", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(approveProposal).mockRejectedValue(
      new PlatformApiError("approve review: secrets-api returned 500", 500),
    );

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: "The approval was not recorded." });
    expect(mergeProposal).not.toHaveBeenCalled();
  });

  // The correctness requirement this whole file exists to prove: approve
  // succeeding and merge then failing must say so, not read as "nothing
  // happened" — the approval is already live on GitHub at that point.
  it("says the approval stood when the merge fails after a successful approve", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(approveProposal).mockResolvedValue(undefined);
    vi.mocked(mergeProposal).mockRejectedValue(
      new PlatformApiError("merge review: secrets-api returned 500", 500),
    );

    const result = await approveAndMergeAction(42);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("The approval went through");
    expect(result.message).toContain("merge did not");
    // The approve row was still written — it genuinely succeeded — while the
    // merge attempt is recorded as a refusal-shaped failure.
    expect(auditInserts()[0]).toEqual({ action: "secrets.review.approve", target: "pull/42" });
  });

  it("refuses a CapabilityError before calling either secrets-api function, and audits the refusal", async () => {
    signIn(undefined);

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(approveProposal).not.toHaveBeenCalled();
    expect(mergeProposal).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("refuses an operator who holds platform but not rotate-credentials", async () => {
    signIn(["platform"]);

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("refuses an operator who holds rotate-credentials but not platform", async () => {
    signIn(["rotate-credentials"]);

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("folds a PlatformApiError 403 into the same no-permission message a CapabilityError produces", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(approveProposal).mockRejectedValue(
      new PlatformApiError("approve review: secrets-api returned 403", 403),
    );

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
  });

  it("the failure result carries no error instance and no cause — plain data only", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(approveProposal).mockRejectedValue(new Error("boom, with a stack and everything"));

    const result = await approveAndMergeAction(42);

    expect(result).toEqual({ ok: false, message: "The approval was not recorded." });
    expect(Object.keys(result)).toEqual(["ok", "message"]);
    expect((result as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("rejectProposalAction", () => {
  it("calls rejectProposal with just the number — no reason travels with this call", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(rejectProposal).mockResolvedValue(undefined);

    const result = await rejectProposalAction(42);

    expect(result).toEqual({ ok: true });
    expect(rejectProposal).toHaveBeenCalledWith(42);
    expect(rejectProposal).toHaveBeenCalledTimes(1);
    expect(lastAuditInsert()).toEqual({
      action: "secrets.review.reject",
      target: "pull/42",
      summary: { rejected: 1 },
    });
  });

  it("refuses a CapabilityError with the fixed no-permission message, and audits the refusal", async () => {
    signIn(undefined);

    const result = await rejectProposalAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(rejectProposal).not.toHaveBeenCalled();
    expect(lastAuditInsert().action).toBe("capability.refused");
  });

  it("refuses an operator who holds platform but not rotate-credentials", async () => {
    signIn(["platform"]);

    const result = await rejectProposalAction(42);

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(rejectProposal).not.toHaveBeenCalled();
  });

  it("degrades any other failure to a fixed message, never passing the internal text through", async () => {
    signIn(["platform", "rotate-credentials"]);
    vi.mocked(rejectProposal).mockRejectedValue(
      new PlatformApiError("reject review: secrets-api returned 500", 500),
    );

    const result = await rejectProposalAction(42);

    expect(result).toEqual({ ok: false, message: "The rejection was not recorded." });
  });

  it("fails closed on AuditUnavailableError before the capability check, when no database is configured", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    signIn(undefined);

    const result = await rejectProposalAction(42);

    expect(rejectProposal).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "The rejection was not recorded." });
  });
});
